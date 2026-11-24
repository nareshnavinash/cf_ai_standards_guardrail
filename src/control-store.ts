import type { SqlLike } from './sql'
import type { ReviewMode } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
export const RETENTION_MS = 30 * DAY_MS
export const INFLIGHT_MS = 10 * 60 * 1000

/** SQL logic of the single global Control Durable Object: review index, diffs, in-flight dedupe, daily counters. */
export class ControlStore {
  constructor(
    private sql: SqlLike,
    private now: () => number = Date.now,
  ) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, memory_key TEXT NOT NULL, visitor TEXT NOT NULL, diff TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    )
    sql.exec(
      `CREATE TABLE IF NOT EXISTS inflight (
        key TEXT PRIMARY KEY, review_id TEXT NOT NULL, mode TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    )
    sql.exec(`CREATE INDEX IF NOT EXISTS inflight_review ON inflight (review_id)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL, created_at INTEGER NOT NULL)`)
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS
    this.sql.exec(`DELETE FROM reviews WHERE created_at < ?`, cutoff)
    this.sql.exec(`DELETE FROM counters WHERE created_at < ?`, cutoff)
    this.sql.exec(`DELETE FROM inflight WHERE expires_at < ?`, this.now())
  }

  registerReview(id: string, repo: string, memoryKey: string, visitor: string, diff: string): void {
    this.prune()
    this.sql.exec(
      `INSERT OR REPLACE INTO reviews (id, repo, memory_key, visitor, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      repo,
      memoryKey,
      visitor,
      diff,
      this.now(),
    )
  }

  getReviewIndex(id: string): { repo: string; memoryKey: string; visitor: string } | null {
    const r = this.sql.exec(`SELECT repo, memory_key, visitor FROM reviews WHERE id = ? AND created_at >= ?`, id, this.now() - RETENTION_MS).toArray()
    return r.length ? { repo: r[0].repo as string, memoryKey: r[0].memory_key as string, visitor: r[0].visitor as string } : null
  }

  getDiff(id: string): string | null {
    const r = this.sql.exec(`SELECT diff FROM reviews WHERE id = ? AND created_at >= ?`, id, this.now() - RETENTION_MS).toArray()
    return r.length ? (r[0].diff as string) : null
  }

  getInflight(key: string): { reviewId: string; mode: ReviewMode } | null {
    const r = this.sql.exec(`SELECT review_id, mode FROM inflight WHERE key = ? AND expires_at > ?`, key, this.now()).toArray()
    return r.length ? { reviewId: r[0].review_id as string, mode: r[0].mode as ReviewMode } : null
  }

  setInflight(key: string, reviewId: string, mode: ReviewMode): void {
    this.sql.exec(`INSERT OR REPLACE INTO inflight (key, review_id, mode, expires_at) VALUES (?, ?, ?, ?)`, key, reviewId, mode, this.now() + INFLIGHT_MS)
  }

  clearInflight(reviewId: string): void {
    this.sql.exec(`DELETE FROM inflight WHERE review_id = ?`, reviewId)
  }

  /** Increments counter `name` unless it is already at `cap`. Single-threaded inside the DO, so atomic. */
  private take(name: string, cap: number): boolean {
    const row = this.sql.exec(`SELECT n FROM counters WHERE name = ?`, name).toArray()
    const n = row.length ? (row[0].n as number) : 0
    if (n >= cap) return false
    this.sql.exec(`INSERT OR REPLACE INTO counters (name, n, created_at) VALUES (?, ?, ?)`, name, n + 1, this.now())
    return true
  }

  reserveReview(day: string, cap: number): boolean {
    return this.take(`review:${day}`, cap)
  }

  reserveChat(reviewId: string, day: string, dailyCap: number, perReviewCap: number): 'ok' | 'daily' | 'review' {
    const turns = this.sql.exec(`SELECT n FROM counters WHERE name = ?`, `turns:${reviewId}`).toArray()
    if (turns.length && (turns[0].n as number) >= perReviewCap) return 'review'
    if (!this.take(`chat:${day}`, dailyCap)) return 'daily'
    this.take(`turns:${reviewId}`, perReviewCap)
    return 'ok'
  }
}
