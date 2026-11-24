import type { SqlLike } from './sql'
import type { ReviewMode } from './types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
export const RETENTION_MS = 30 * DAY_MS
export const DIFF_RETENTION_MS = 3 * DAY_MS
export const INFLIGHT_MS = 10 * 60 * 1000
export const PRUNE_EVERY_MS = HOUR_MS

export interface ClaimArgs {
  inflightKey: string
  reviewId: string
  repo: string
  memoryKey: string
  visitor: string
  diff: string
  day: string
  /** Daily cap on LLM reviews (secondary guard). */
  cap: number
  /** Daily neuron budget; once spent, new reviews are static-only. */
  neuronBudget: number
  /** Hashed client IP, or null when unknown (per-IP limits are skipped). */
  ip: string | null
  ipCap: number
  /** Per-IP daily cap on ALL claims (LLM, cached, static-only). Default 30. */
  ipTotalCap?: number
  /** True when the review would spend LLM budget (not a cached diff). */
  needsBudget: boolean
  /** Run static-only without taking any slot. */
  forceStatic?: boolean
}
export type ClaimResult =
  | { kind: 'existing'; reviewId: string; mode: ReviewMode; ageMs: number }
  | { kind: 'claimed'; mode: ReviewMode }
  | { kind: 'ip-limit' }
  | { kind: 'total-limit' }

export interface ReserveChatArgs {
  reviewId: string
  day: string
  dailyCap: number
  perReviewCap: number
  ip: string | null
  ipCap: number
  neuronBudget: number
}

/** SQL logic of the single global Control Durable Object: review index, diffs, in-flight dedupe, daily counters, neuron usage. */
export class ControlStore {
  constructor(
    private sql: SqlLike,
    private now: () => number = Date.now,
  ) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, memory_key TEXT NOT NULL, visitor TEXT NOT NULL, diff TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    )
    sql.exec(`CREATE INDEX IF NOT EXISTS reviews_created ON reviews (created_at)`)
    sql.exec(
      `CREATE TABLE IF NOT EXISTS inflight (
        key TEXT PRIMARY KEY, review_id TEXT NOT NULL, mode TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    )
    sql.exec(`CREATE INDEX IF NOT EXISTS inflight_review ON inflight (review_id)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL, created_at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS counters_created ON counters (created_at)`)
    // The LLM slot a claimed review holds, so a failed start can refund exactly what it took.
    sql.exec(`CREATE TABLE IF NOT EXISTS slots (review_id TEXT PRIMARY KEY, day TEXT NOT NULL, ip TEXT)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_keys (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS usage_keys_created ON usage_keys (created_at)`)
    // Per-call neuron reservations (reviewId:stepName or chat:<uuid>), settled to actual usage after the AI call.
    sql.exec(`CREATE TABLE IF NOT EXISTS reservations (key TEXT PRIMARY KEY, day TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`)
  }

  /** At most once per hour: diffs go after 3 days, index rows and counters after 30, expired in-flight markers always. */
  private prune(): void {
    const now = this.now()
    const m = this.sql.exec(`SELECT v FROM meta WHERE k = 'last_prune'`).toArray()
    const last = m.length ? (m[0].v as number) : 0
    if (last && now - last < PRUNE_EVERY_MS) return
    const cutoff = now - RETENTION_MS
    this.sql.exec(`DELETE FROM reviews WHERE created_at < ?`, cutoff)
    this.sql.exec(`DELETE FROM counters WHERE created_at < ?`, cutoff)
    this.sql.exec(`DELETE FROM usage_keys WHERE created_at < ?`, cutoff)
    this.sql.exec(`DELETE FROM reservations WHERE created_at < ?`, cutoff)
    this.sql.exec(`DELETE FROM slots WHERE review_id NOT IN (SELECT id FROM reviews)`)
    this.sql.exec(`DELETE FROM inflight WHERE expires_at < ?`, now)
    // Only the window since the previous prune can hold newly expired diffs, so the scan stays small.
    const lo = last ? last - DIFF_RETENTION_MS - HOUR_MS : 0
    this.sql.exec(`UPDATE reviews SET diff = '' WHERE created_at >= ? AND created_at < ? AND diff <> ''`, lo, now - DIFF_RETENTION_MS)
    this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('last_prune', ?)`, now)
  }

  getReviewIndex(id: string): { repo: string; memoryKey: string; visitor: string } | null {
    const r = this.sql.exec(`SELECT repo, memory_key, visitor FROM reviews WHERE id = ? AND created_at >= ?`, id, this.now() - RETENTION_MS).toArray()
    return r.length ? { repo: r[0].repo as string, memoryKey: r[0].memory_key as string, visitor: r[0].visitor as string } : null
  }

  getDiff(id: string): string | null {
    const r = this.sql.exec(`SELECT diff FROM reviews WHERE id = ? AND created_at >= ?`, id, this.now() - DIFF_RETENTION_MS).toArray()
    return r.length && r[0].diff ? (r[0].diff as string) : null
  }

  private count(name: string): number {
    const row = this.sql.exec(`SELECT n FROM counters WHERE name = ?`, name).toArray()
    return row.length ? (row[0].n as number) : 0
  }
  private bump(name: string, by: number): void {
    const n = Math.max(0, this.count(name) + by)
    this.sql.exec(`INSERT OR REPLACE INTO counters (name, n, created_at) VALUES (?, ?, ?)`, name, n, this.now())
  }

  /** Increments counter `name` unless it is already at `cap`. Single-threaded inside the DO, so atomic. */
  private take(name: string, cap: number): boolean {
    if (this.count(name) >= cap) return false
    this.bump(name, 1)
    return true
  }

  reserveReview(day: string, cap: number): boolean {
    return this.take(`review:${day}`, cap)
  }

  neuronsSpent(day: string): number {
    return this.count(`neurons:${day}`)
  }

  /** Adds neurons to the day's total, once per key (workflow steps replay). */
  recordUsage(key: string, day: string, neurons: number): void {
    const n = Math.ceil(neurons)
    if (!Number.isFinite(n) || n <= 0) return
    if (this.sql.exec(`SELECT 1 FROM usage_keys WHERE key = ?`, key).toArray().length) return
    this.sql.exec(`INSERT INTO usage_keys (key, created_at) VALUES (?, ?)`, key, this.now())
    this.bump(`neurons:${day}`, n)
  }

  /**
   * Reserves `amount` neurons for one AI call, before it is made. Idempotent per key (a retry does not charge twice);
   * refused when it would push the day past `budget`.
   */
  reserveNeurons(day: string, key: string, amount: number, budget: number): boolean {
    if (this.sql.exec(`SELECT 1 FROM reservations WHERE key = ?`, key).toArray().length) return true
    const n = Math.max(0, Math.ceil(amount))
    if (this.neuronsSpent(day) + n > budget) return false
    this.sql.exec(`INSERT INTO reservations (key, day, amount, created_at) VALUES (?, ?, ?, ?)`, key, day, n, this.now())
    this.bump(`neurons:${day}`, n)
    return true
  }

  /** Adjusts a reservation to the real usage (0 refunds it). Unknown keys and repeats are no-ops. */
  settleNeurons(key: string, actual: number): void {
    const r = this.sql.exec(`SELECT day, amount FROM reservations WHERE key = ?`, key).toArray()
    if (!r.length) return
    const a = Math.max(0, Math.ceil(actual))
    const delta = a - (r[0].amount as number)
    if (delta !== 0) this.bump(`neurons:${r[0].day as string}`, delta)
    this.sql.exec(`UPDATE reservations SET amount = ? WHERE key = ?`, a, key)
  }

  /**
   * One synchronous transaction (no awaits, so nothing interleaves): dedupe against an in-flight review, decide the mode,
   * take the daily/IP slots, then index the review and mark it in flight.
   */
  claimReview(a: ClaimArgs): ClaimResult {
    this.prune()
    const hit = this.sql.exec(`SELECT review_id, mode, expires_at FROM inflight WHERE key = ? AND expires_at > ?`, a.inflightKey, this.now()).toArray()
    if (hit.length) {
      const claimedAt = (hit[0].expires_at as number) - INFLIGHT_MS
      return { kind: 'existing', reviewId: hit[0].review_id as string, mode: hit[0].mode as ReviewMode, ageMs: this.now() - claimedAt }
    }
    const totalKey = a.ip ? `ip-total:${a.day}:${a.ip}` : null
    if (totalKey && this.count(totalKey) >= (a.ipTotalCap ?? 30)) return { kind: 'total-limit' }

    let mode: ReviewMode = 'full'
    let takeSlot = false
    if (a.forceStatic) mode = 'static-only'
    else if (a.needsBudget) {
      if (this.neuronsSpent(a.day) >= a.neuronBudget || this.count(`review:${a.day}`) >= a.cap) mode = 'static-only'
      else if (a.ip && this.count(`ip-review:${a.day}:${a.ip}`) >= a.ipCap) return { kind: 'ip-limit' }
      else takeSlot = true
    }
    if (takeSlot) {
      this.bump(`review:${a.day}`, 1)
      if (a.ip) this.bump(`ip-review:${a.day}:${a.ip}`, 1)
      this.sql.exec(`INSERT OR REPLACE INTO slots (review_id, day, ip) VALUES (?, ?, ?)`, a.reviewId, a.day, a.ip)
    }
    if (totalKey) this.bump(totalKey, 1)
    this.sql.exec(
      `INSERT OR REPLACE INTO reviews (id, repo, memory_key, visitor, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      a.reviewId,
      a.repo,
      a.memoryKey,
      a.visitor,
      mode === 'full' ? a.diff : '', // chat is disabled for static-only reviews, so their diff is never read
      this.now(),
    )
    this.sql.exec(`INSERT OR REPLACE INTO inflight (key, review_id, mode, expires_at) VALUES (?, ?, ?, ?)`, a.inflightKey, a.reviewId, mode, this.now() + INFLIGHT_MS)
    return { kind: 'claimed', mode }
  }

  /** The review finished: drop its in-flight marker; its slot is now permanently spent. */
  clearInflight(reviewId: string): void {
    this.sql.exec(`DELETE FROM inflight WHERE review_id = ?`, reviewId)
    this.sql.exec(`DELETE FROM slots WHERE review_id = ?`, reviewId)
  }

  /** The review never ran (or its workflow died): forget it, and give the LLM slot back when `refund` is set. */
  releaseReview(reviewId: string, refund: boolean): void {
    const slot = this.sql.exec(`SELECT day, ip FROM slots WHERE review_id = ?`, reviewId).toArray()
    if (refund && slot.length) {
      this.bump(`review:${slot[0].day as string}`, -1)
      if (slot[0].ip) this.bump(`ip-review:${slot[0].day as string}:${slot[0].ip as string}`, -1)
    }
    this.sql.exec(`DELETE FROM slots WHERE review_id = ?`, reviewId)
    this.sql.exec(`DELETE FROM inflight WHERE review_id = ?`, reviewId)
    this.sql.exec(`DELETE FROM reviews WHERE id = ?`, reviewId)
  }

  reserveChat(a: ReserveChatArgs): 'ok' | 'daily' | 'review' | 'ip' | 'budget' {
    if (this.neuronsSpent(a.day) >= a.neuronBudget) return 'budget'
    if (this.count(`turns:${a.reviewId}`) >= a.perReviewCap) return 'review'
    if (a.ip && this.count(`ip-chat:${a.day}:${a.ip}`) >= a.ipCap) return 'ip'
    if (this.count(`chat:${a.day}`) >= a.dailyCap) return 'daily'
    this.bump(`chat:${a.day}`, 1)
    this.bump(`turns:${a.reviewId}`, 1)
    if (a.ip) this.bump(`ip-chat:${a.day}:${a.ip}`, 1)
    return 'ok'
  }

  refundChat(a: { reviewId: string; day: string; ip: string | null }): void {
    this.bump(`chat:${a.day}`, -1)
    this.bump(`turns:${a.reviewId}`, -1)
    if (a.ip) this.bump(`ip-chat:${a.day}:${a.ip}`, -1)
  }
}
