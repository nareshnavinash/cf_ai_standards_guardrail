import { DurableObject } from 'cloudflare:workers'
import type { ChatTurn, Env, ExceptionRecord, ReviewResult } from './types'

const MAX_EXCEPTIONS = 25

/** Per-repo memory: exceptions, past reviews and chat history. The DO name is the memoryKey. */
export class RepoMemory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
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

  async listExceptions(): Promise<ExceptionRecord[]> {
    return this.ctx.storage.sql
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

  async addException(input: { ruleId: string; pathGlob: string; reason: string }): Promise<ExceptionRecord> {
    const sql = this.ctx.storage.sql
    const count = sql.exec(`SELECT COUNT(*) AS n FROM exceptions`).one().n as number
    if (count >= MAX_EXCEPTIONS) throw new Error('limit')
    const rec: ExceptionRecord = {
      id: crypto.randomUUID(),
      ruleId: input.ruleId,
      pathGlob: input.pathGlob,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    }
    sql.exec(
      `INSERT INTO exceptions (id, rule_id, path_glob, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      rec.id,
      rec.ruleId,
      rec.pathGlob,
      rec.reason,
      rec.createdAt,
    )
    return rec
  }

  async removeException(id: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(`DELETE FROM exceptions WHERE id = ?`, id)
    return cursor.rowsWritten > 0
  }

  async saveReview(r: ReviewResult): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO reviews (id, body, created_at) VALUES (?, ?, ?)`,
      r.id,
      JSON.stringify(r),
      r.createdAt,
    )
  }

  async getReview(id: string): Promise<ReviewResult | null> {
    const rows = this.ctx.storage.sql.exec(`SELECT body FROM reviews WHERE id = ?`, id).toArray()
    return rows.length ? (JSON.parse(rows[0].body as string) as ReviewResult) : null
  }

  async appendChat(reviewId: string, turns: ChatTurn[]): Promise<void> {
    for (const t of turns) {
      this.ctx.storage.sql.exec(
        `INSERT INTO chat (review_id, role, content, at) VALUES (?, ?, ?, ?)`,
        reviewId,
        t.role,
        t.content,
        t.at,
      )
    }
  }

  async getChat(reviewId: string, limit: number): Promise<ChatTurn[]> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT role, content, at FROM chat WHERE review_id = ? ORDER BY seq DESC LIMIT ?`, reviewId, limit)
      .toArray()
    return rows.reverse().map((r) => ({ role: r.role as ChatTurn['role'], content: r.content as string, at: r.at as string }))
  }
}
