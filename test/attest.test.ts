import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain ESM script without types
import { computeTreeHash, fileHashes, isHashed, mismatchReason, trackedFiles } from '../scripts/attest.mjs'

let dir: string
const write = (p: string, s: string) => {
  mkdirSync(join(dir, p, '..'), { recursive: true })
  writeFileSync(join(dir, p), s)
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'attest-'))
  write('a.txt', 'one')
  write('src/b.ts', 'two')
  write('.ci/attestation.json', '{}')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const files = ['a.txt', 'src/b.ts', '.ci/attestation.json']

describe('computeTreeHash', () => {
  it('is stable across calls and independent of order', () => {
    expect(computeTreeHash(files, dir)).toBe(computeTreeHash(files, dir))
    expect(computeTreeHash([...files].reverse(), dir)).toBe(computeTreeHash(files, dir))
  })
  it('changes when any tracked file changes or is removed', () => {
    const before = computeTreeHash(files, dir)
    write('src/b.ts', 'changed')
    const after = computeTreeHash(files, dir)
    expect(after).not.toBe(before)
    rmSync(join(dir, 'a.txt'))
    expect(computeTreeHash(files, dir)).not.toBe(after)
  })
  it('changes when the file list changes', () => {
    write('c.txt', 'x')
    expect(computeTreeHash([...files, 'c.txt'], dir)).not.toBe(computeTreeHash(files, dir))
  })
  it('ignores the attestation file', () => {
    const before = computeTreeHash(files, dir)
    write('.ci/attestation.json', '{"different":true}')
    expect(computeTreeHash(files, dir)).toBe(before)
    expect(computeTreeHash(['a.txt', 'src/b.ts'], dir)).toBe(before)
  })
})

describe('examples exclusion', () => {
  it('isHashed skips examples/ only', () => {
    expect(isHashed('examples/demo-service/src/orders.ts')).toBe(false)
    expect(isHashed('src/examples.ts')).toBe(true)
  })
  it('trackedFiles never lists examples/ files', () => {
    const files = trackedFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f: string) => f.startsWith('examples/'))).toBe(false)
  })
})

describe('mismatchReason', () => {
  const att = () => ({ treeHash: computeTreeHash(files, dir), passed: true, fileHashes: fileHashes(files, dir) })
  it('is null when the tree matches', () => {
    expect(mismatchReason(att(), files, dir)).toBeNull()
  })
  it('names the files that changed, were added or were removed', () => {
    const a = att()
    write('src/b.ts', 'changed')
    write('c.txt', 'new')
    const why = mismatchReason(a, [...files, 'c.txt'], dir) as string
    expect(why).toContain('changed: src/b.ts')
    expect(why).toContain('added: c.txt')
    expect(mismatchReason(a, ['a.txt'], dir)).toContain('removed: src/b.ts')
  })
  it('explains a missing or failed attestation', () => {
    expect(mismatchReason(null, files, dir)).toContain('no .ci/attestation.json')
    expect(mismatchReason({ ...att(), passed: false }, files, dir)).toContain('did not pass')
  })
})
