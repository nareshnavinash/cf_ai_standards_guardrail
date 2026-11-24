import type { AddedLine, DiffFile } from './types'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const MAX_FILES = 10
const MAX_LINES = 300
const MAX_LINE_CHARS = 500

function unquote(p: string): string {
  p = p.trim().replace(/\t.*$/, '')
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    const inner = p.slice(1, -1)
    const bytes: number[] = []
    const enc = new TextEncoder()
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch === '\\' && i + 1 < inner.length) {
        const oct = inner.slice(i + 1, i + 4)
        if (/^[0-7]{3}$/.test(oct)) {
          bytes.push(parseInt(oct, 8))
          i += 3
          continue
        }
        const next = inner[i + 1]
        const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
        bytes.push(...enc.encode(map[next] ?? next))
        i += 1
        continue
      }
      bytes.push(...enc.encode(ch))
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
  return p
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '')
}

function pathFromGitHeader(rest: string): string {
  const q = rest.match(/^"a\/(.*)" "b\/(.*)"$/)
  if (q) return unquote(`"${q[2]}"`)
  const half = (rest.length - 5) / 2
  if (Number.isInteger(half) && half > 0) {
    const a = rest.slice(2, 2 + half)
    const b = rest.slice(2 + half + 3)
    if (rest.startsWith('a/') && rest.slice(2 + half, 2 + half + 3) === ' b/' && a === b) return a
  }
  const m = rest.match(/ b\/(.+)$/)
  return m ? m[1] : rest
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = diff.split('\n')
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let sawContent = false
  let oldLeft = 0
  let newLeft = 0
  let newLine = 0

  const start = (path: string): DiffFile => {
    const f: DiffFile = { path, status: 'modified', added: [], truncated: false }
    files.push(f)
    sawContent = false
    return f
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) {
        cur!.added.push({ line: newLine, text: line.slice(1) })
        newLine++
        newLeft--
      } else if (line.startsWith('-')) {
        oldLeft--
      } else {
        // context line (leading space, or empty line from stripped whitespace)
        oldLeft--
        newLeft--
        newLine++
      }
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('diff --git ')) {
      cur = start(pathFromGitHeader(line.slice('diff --git '.length)))
      continue
    }
    const hm = line.match(HUNK_RE)
    if (hm && cur) {
      oldLeft = hm[2] === undefined ? 1 : parseInt(hm[2], 10)
      newLeft = hm[4] === undefined ? 1 : parseInt(hm[4], 10)
      newLine = parseInt(hm[3], 10)
      sawContent = true
      continue
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (!cur || sawContent) cur = start('')
      const from = unquote(line.slice(4))
      if (from !== '/dev/null') cur.path = stripPrefix(from)
      continue
    }
    if (line.startsWith('+++ ') && cur) {
      const to = unquote(line.slice(4))
      if (to !== '/dev/null') cur.path = stripPrefix(to)
      continue
    }
    if (!cur) continue
    if (line.startsWith('new file mode')) cur.status = 'added'
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted'
    else if (line.startsWith('rename to ')) {
      cur.status = 'renamed'
      cur.path = unquote(line.slice('rename to '.length))
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.status = 'binary'
  }
  return files
}

const SKIP_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/
const SKIP_EXT = /\.(min\.js|min\.css|map|png|jpe?g|gif|webp|ico|svg|woff2?|ttf|pdf|zip)$/i

export function isSkippedPath(path: string): boolean {
  return SKIP_NAMES.test(path) || SKIP_EXT.test(path)
}

export function isMinified(file: DiffFile): boolean {
  if (file.added.length === 0) return false
  const total = file.added.reduce((n, l) => n + l.text.length, 0)
  return total / file.added.length > 1000
}

export function limitFiles(files: DiffFile[]): { files: DiffFile[]; skipped: string[]; truncated: boolean } {
  const skipped: string[] = []
  const kept: DiffFile[] = []
  let truncated = false
  for (const f of files) {
    if (f.status === 'binary' || isSkippedPath(f.path) || isMinified(f)) {
      skipped.push(f.path)
      continue
    }
    if (f.added.length === 0) continue
    if (kept.length >= MAX_FILES) {
      skipped.push(f.path)
      truncated = true
      continue
    }
    let fileTruncated = f.truncated
    let added: AddedLine[] = f.added
    if (added.length > MAX_LINES) {
      added = added.slice(0, MAX_LINES)
      fileTruncated = true
      truncated = true
    }
    added = added.map((l) =>
      l.text.length > MAX_LINE_CHARS ? ((fileTruncated = true), (truncated = true), { line: l.line, text: l.text.slice(0, MAX_LINE_CHARS) }) : l,
    )
    kept.push({ ...f, added, truncated: fileTruncated })
  }
  return { files: kept, skipped, truncated }
}
