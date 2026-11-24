/** The subset of Durable Object `ctx.storage.sql` the stores use, so the logic is testable with node:sqlite. */
export interface SqlCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
  rowsWritten: number
}
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): SqlCursor
}
