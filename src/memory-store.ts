import type { SqlLike } from './sql'
import type { ChatTurn, ExceptionRecord, ReviewResult } from './types'

export const MAX_EXCEPTIONS = 25
export const MAX_REVIEWS = 50
export const MAX_CHAT_TURNS = 40

/** SQL logic of the per-repo (per-visitor) memory Durable Object. */
export class MemoryStore {
  constructor(private sql: SqlLike) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS exceptions (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, path_glob TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`,
    )
    sql.exec(`CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)`)
    sql.exec(
      `CREATE TABLE IF NOT EXISTS chat (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL)`,
    )
    sql.exec(`CREATE INDEX IF NOT EXISTS chat_review ON chat (review_id, seq)`)
  }

  listExceptions(): ExceptionRecord[] {
    return this.sql
      .exec(`SELECT id, rule_id, path_glob, reason, created_at FROM exceptions ORDER BY created_at, id`)
      .toArray()
      .map((r) => ({
        id: r.id as string,
        ruleId: r.rule_id as string,
        pathGlob: r.path_glob as string,
        reason: r.reason as string,
        createdAt: r.created_at as string,
      }))
  }

  addException(input: { ruleId: string; pathGlob: string; reason: string }): ExceptionRecord {
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM exceptions`).one().n as number
    if (count >= MAX_EXCEPTIONS) throw new Error('limit')
    const rec: ExceptionRecord = {
      id: crypto.randomUUID(),
      ruleId: input.ruleId,
      pathGlob: input.pathGlob,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    }
    this.sql.exec(
      `INSERT INTO exceptions (id, rule_id, path_glob, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      rec.id,
      rec.ruleId,
      rec.pathGlob,
      rec.reason,
      rec.createdAt,
    )
    return rec
  }

  removeException(id: string): boolean {
    return this.sql.exec(`DELETE FROM exceptions WHERE id = ?`, id).rowsWritten > 0
  }

  /** Saves a review and keeps only the newest MAX_REVIEWS (with their chat). */
  saveReview(r: ReviewResult): void {
    this.sql.exec(`INSERT OR REPLACE INTO reviews (id, body, created_at) VALUES (?, ?, ?)`, r.id, JSON.stringify(r), r.createdAt)
    const old = this.sql
      .exec(`SELECT id FROM reviews ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`, MAX_REVIEWS)
      .toArray()
    for (const o of old) {
      this.sql.exec(`DELETE FROM reviews WHERE id = ?`, o.id)
      this.sql.exec(`DELETE FROM chat WHERE review_id = ?`, o.id)
    }
  }

  getReview(id: string): ReviewResult | null {
    const rows = this.sql.exec(`SELECT body FROM reviews WHERE id = ?`, id).toArray()
    return rows.length ? (JSON.parse(rows[0].body as string) as ReviewResult) : null
  }

  appendChat(reviewId: string, turns: ChatTurn[]): void {
    for (const t of turns) {
      this.sql.exec(`INSERT INTO chat (review_id, role, content, at) VALUES (?, ?, ?, ?)`, reviewId, t.role, t.content, t.at)
    }
    this.sql.exec(
      `DELETE FROM chat WHERE review_id = ? AND seq NOT IN (SELECT seq FROM chat WHERE review_id = ? ORDER BY seq DESC LIMIT ?)`,
      reviewId,
      reviewId,
      MAX_CHAT_TURNS,
    )
  }

  getChat(reviewId: string, limit: number): ChatTurn[] {
    const rows = this.sql
      .exec(`SELECT role, content, at FROM chat WHERE review_id = ? ORDER BY seq DESC LIMIT ?`, reviewId, limit)
      .toArray()
    return rows.reverse().map((r) => ({ role: r.role as ChatTurn['role'], content: r.content as string, at: r.at as string }))
  }
}
