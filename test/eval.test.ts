import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prf, score, type CaseRun, type EvalCase } from '../evals/run'
import { RULES } from '../src/rules'

const dir = join(import.meta.dirname, '../evals/cases')
const cases = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase)

describe('eval cases', () => {
  it('has enough cases, including real PRs with an origin', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
    const real = cases.filter((c) => c.source === 'real')
    expect(real.length).toBeGreaterThanOrEqual(3)
    expect(real.length).toBeLessThanOrEqual(5)
    for (const c of real) expect(c.origin).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/)
  })
  it('uses unique names and known rule ids', () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
    const ids = new Set(RULES.map((r) => r.id))
    for (const c of cases) for (const e of c.expected) expect(ids.has(e)).toBe(true)
  })
})

describe('scoring', () => {
  const cs = [
    { name: 'a', expected: ['STD-001'] },
    { name: 'b', expected: [] },
    { name: 'c', expected: ['STD-001'] },
  ] as EvalCase[]
  const run = (name: string, found: string[]): CaseRun => ({ name, mode: 'full', found, degradedFiles: [], seconds: 1, rulesVersion: 'x' })
  it('counts tp, fp and fn per rule', () => {
    const s = score(cs, [run('a', ['STD-001']), run('b', ['STD-001']), run('c', [])], ['STD-001'])
    expect(s['STD-001']).toEqual({ tp: 1, fp: 1, fn: 1 })
    expect(prf(s['STD-001']!)).toEqual({ p: 0.5, r: 0.5, f1: 0.5 })
  })
  it('returns n/a (null) when a ratio has no denominator', () => {
    expect(prf({ tp: 0, fp: 0, fn: 0 })).toEqual({ p: null, r: null, f1: null })
  })
})
