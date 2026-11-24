import { DatabaseSync } from 'node:sqlite'
import type { SqlLike } from '../../src/sql'

/** Adapts Node's built-in sqlite to the subset of ctx.storage.sql used by the stores. */
export function sqliteAdapter(): SqlLike {
  const db = new DatabaseSync(':memory:')
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query)
      if (/^\s*(select|pragma|with)/i.test(query)) {
        const rows = stmt.all(...(bindings as any[])) as Record<string, unknown>[]
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error('expected exactly one row')
            return rows[0]
          },
          rowsWritten: 0,
        }
      }
      const info = stmt.run(...(bindings as any[]))
      return {
        toArray: () => [],
        one: () => {
          throw new Error('no rows')
        },
        rowsWritten: Number(info.changes),
      }
    },
  }
}
