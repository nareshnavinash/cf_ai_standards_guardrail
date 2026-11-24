import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseUnifiedDiff, isSkippedPath, isMinified, limitFiles } from '../src/diff'
import { RULES, RULES_VERSION, ruleById } from '../src/rules'
import type { DiffFile } from '../src/types'

const fx = (n: string) => readFileSync(resolve(import.meta.dirname, 'fixtures', n), 'utf8')
const mk = (path: string, n: number, len = 10): DiffFile => ({
  path,
  status: 'modified',
  truncated: false,
  added: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: 'x'.repeat(len) })),
})

describe('rules', () => {
  it('has STD-001..007', () => {
    expect(RULES.map((r) => r.id)).toEqual(['STD-001', 'STD-002', 'STD-003', 'STD-004', 'STD-005', 'STD-006', 'STD-007'])
    expect(RULES_VERSION).toBe('2026.11.2')
    expect(ruleById('STD-005')?.kind).toBe('llm')
    expect(ruleById('nope')).toBeUndefined()
  })
})

describe('parseUnifiedDiff', () => {
  it('parses added lines with new line numbers', () => {
    const [f] = parseUnifiedDiff(fx('modified.diff'))
    expect(f.path).toBe('src/a.ts')
    expect(f.added).toEqual([{ line: 12, text: 'const x = fetch(url)' }])
  })
  it('does not treat a removed "-- comment" line as a file header', () => {
    const files = parseUnifiedDiff(fx('dashes.diff'))
    expect(files).toHaveLength(1)
    expect(files[0].added).toEqual([
      { line: 2, text: 'select 2' },
      { line: 4, text: 'select 4' },
    ])
  })
  it('ignores "\\ No newline at end of file"', () => {
    const [f] = parseUnifiedDiff(fx('no-newline.diff'))
    expect(f.added).toEqual([
      { line: 2, text: 'two' },
      { line: 3, text: 'three' },
    ])
  })
  it('marks binary files', () => {
    const [f] = parseUnifiedDiff(fx('binary.diff'))
    expect(f).toMatchObject({ path: 'x.png', status: 'binary', added: [] })
  })
  it('handles rename-only, mode-only and deleted', () => {
    expect(parseUnifiedDiff(fx('rename.diff'))[0]).toMatchObject({ path: 'new/name.ts', status: 'renamed', added: [] })
    expect(parseUnifiedDiff(fx('mode.diff'))[0]).toMatchObject({ path: 'run.sh', status: 'modified', added: [] })
    expect(parseUnifiedDiff(fx('deleted.diff'))[0]).toMatchObject({ path: 'src/gone.ts', status: 'deleted', added: [] })
  })
  it('handles spaces and quoted paths', () => {
    const files = parseUnifiedDiff(fx('spaces.diff'))
    expect(files.map((f) => f.path)).toEqual(['src/my file.ts', 'src/é.ts'])
    expect(files[0].added).toEqual([{ line: 2, text: 'b' }])
    expect(files[1].added).toEqual([{ line: 2, text: 'c' }])
  })
  it('walks hunks by counts, not prefixes', () => {
    const d = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '+++ not a header',
      ' ctx',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,1 +1,2 @@',
      ' k',
      '+n',
    ].join('\n')
    const files = parseUnifiedDiff(d)
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(files[0].added).toEqual([{ line: 1, text: '++ not a header' }])
    expect(files[1].added).toEqual([{ line: 2, text: 'n' }])
  })
  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('isSkippedPath / isMinified', () => {
  it('skips lockfiles, images, minified assets', () => {
    for (const p of ['package-lock.json', 'a/logo.png', 'dist/app.min.js', 'yarn.lock', 'x/pnpm-lock.yaml', 'a.map']) {
      expect(isSkippedPath(p)).toBe(true)
    }
    expect(isSkippedPath('src/a.ts')).toBe(false)
  })
  it('detects minified files', () => {
    expect(isMinified(mk('a.js', 1, 200_000))).toBe(true)
    expect(isMinified(mk('a.js', 5, 80))).toBe(false)
    expect(isMinified(mk('a.js', 0))).toBe(false)
  })
})

describe('limitFiles', () => {
  it('keeps 10 files and lists the rest as skipped', () => {
    const files = Array.from({ length: 15 }, (_, i) => mk(`src/f${i}.ts`, 2))
    const r = limitFiles(files)
    expect(r.files).toHaveLength(10)
    expect(r.skipped).toHaveLength(5)
    expect(r.truncated).toBe(true)
  })
  it('caps lines per file and flags the file', () => {
    const r = limitFiles([mk('src/big.ts', 400)])
    expect(r.files[0].added).toHaveLength(300)
    expect(r.files[0].truncated).toBe(true)
    expect(r.truncated).toBe(true)
  })
  it('cuts long lines to 500 chars', () => {
    const r = limitFiles([mk('src/long.ts', 1, 900)])
    expect(r.files[0].added[0].text).toHaveLength(500)
    expect(r.files[0].truncated).toBe(true)
  })
  it('skips lockfiles, binaries and minified files without truncating', () => {
    const bin: DiffFile = { path: 'x.png', status: 'binary', added: [], truncated: false }
    const r = limitFiles([mk('package-lock.json', 3), bin, mk('src/m.ts', 1, 200_000), mk('src/ok.ts', 1)])
    expect(r.files.map((f) => f.path)).toEqual(['src/ok.ts'])
    expect(r.skipped).toEqual(['package-lock.json', 'x.png', 'src/m.ts'])
    expect(r.truncated).toBe(false)
  })
  it('drops files with no added lines', () => {
    expect(limitFiles([mk('src/empty.ts', 0)])).toEqual({ files: [], skipped: [], truncated: false })
  })
})
