import { describe, expect, it } from 'vitest'
import { applyExceptions, cacheKey, dedupeFindings, globMatch, sortFindings, validateGlob } from '../src/review'
import type { ExceptionRecord, Finding } from '../src/types'

const f = (ruleId: string, path: string, line: number | null): Finding => ({
  ruleId,
  path,
  line,
  message: 'm',
  suggestion: null,
  source: 'static',
})
const ex = (ruleId: string, pathGlob: string): ExceptionRecord => ({ id: '1', ruleId, pathGlob, reason: 'because', createdAt: 't' })

describe('globMatch', () => {
  const cases: [string, string, boolean][] = [
    ['test/fixtures/a.ts', 'test/**', true],
    ['a.test.ts', '**/*.test.ts', true],
    ['src/a.test.ts', '**/*.test.ts', true],
    ['src/a.ts', '**/*.test.ts', false],
    ['src/a.ts', 'src/*.ts', true],
    ['src/x/a.ts', 'src/*.ts', false],
    ['a+b.ts', 'a+b.ts', true],
    ['src/(a).ts', 'src/(a).ts', true],
    ['src/ab.ts', 'src/a?.ts', true],
    ['src/a/b.ts', 'src/a?.ts', false],
    ['srcXts', 'src.ts', false],
  ]
  for (const [p, g, want] of cases) it(`${p} vs ${g} -> ${want}`, () => expect(globMatch(p, g)).toBe(want))
  it('does not treat user input as a regex', () => {
    const t = Date.now()
    expect(globMatch('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', '(a+)+$')).toBe(false)
    expect(Date.now() - t).toBeLessThan(200)
  })
})

describe('validateGlob', () => {
  for (const bad of ['*', '**', '**/*', '', 'x'.repeat(201)]) it(`rejects ${bad.slice(0, 10) || '(empty)'}`, () => expect(validateGlob(bad)).toEqual(expect.any(String)))
  it('accepts scoped globs', () => {
    expect(validateGlob('test/**')).toBeNull()
    expect(validateGlob('src/*.ts')).toBeNull()
  })
})

describe('applyExceptions', () => {
  it('scopes by rule and path', () => {
    const findings = [f('STD-001', 'test/x.ts', 1), f('STD-002', 'test/x.ts', 2), f('STD-001', 'src/x.ts', 3)]
    const { kept, suppressed } = applyExceptions(findings, [ex('STD-001', 'test/**')])
    expect(suppressed).toEqual([findings[0]])
    expect(kept).toEqual([findings[1], findings[2]])
  })
  it('matches STD-004 null-line findings by path', () => {
    const { suppressed } = applyExceptions([f('STD-004', 'scripts/a.ts', null)], [ex('STD-004', 'scripts/**')])
    expect(suppressed).toHaveLength(1)
  })
})

describe('dedupe / sort', () => {
  it('merges same rule+path+line', () => {
    expect(dedupeFindings([f('STD-001', 'a', 1), f('STD-001', 'a', 1), f('STD-001', 'a', 2), f('STD-002', 'a', 1)])).toHaveLength(3)
  })
  it('sorts errors first, then path, then line with null last', () => {
    const sorted = sortFindings([f('STD-004', 'a.ts', null), f('STD-003', 'a.ts', 1), f('STD-003', 'a.ts', null), f('STD-001', 'b.ts', 9), f('STD-001', 'a.ts', 5)])
    expect(sorted.map((x) => `${x.ruleId}:${x.path}:${x.line}`)).toEqual([
      'STD-001:a.ts:5',
      'STD-001:b.ts:9',
      'STD-003:a.ts:1',
      'STD-003:a.ts:null',
      'STD-004:a.ts:null',
    ])
  })
})

describe('cacheKey', () => {
  it('is stable and diff-sensitive', async () => {
    expect(await cacheKey('x')).toBe(await cacheKey('x'))
    expect(await cacheKey('x')).not.toBe(await cacheKey('y'))
    expect(await cacheKey('x')).toMatch(/^review:[0-9a-f]{64}$/)
  })
})
