export type Level = 'debug' | 'info' | 'warn' | 'error'
export type Fields = Record<string, string | number | boolean | null>

export interface Logger {
  log(level: Level, event: string, fields?: Fields): void
}

/** Writes one JSON object per line so logs can be queried by field. */
export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  return {
    log(level, event, fields = {}) {
      write(JSON.stringify({ level, event, ...fields }))
    },
  }
}
