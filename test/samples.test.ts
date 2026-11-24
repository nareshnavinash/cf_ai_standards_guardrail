import { describe, expect, it } from 'vitest'
import { SAMPLES } from '../src/samples'
import { parseUnifiedDiff, limitFiles } from '../src/diff'
import { runStaticChecks } from '../src/checks/static'

describe('SAMPLES', () => {
  it('has the four samples', () => {
    expect(SAMPLES.map((s) => s.id)).toEqual(['leaky-config', 'swallowed-errors', 'untested-endpoint', 'clean-change'])
  })
  for (const s of SAMPLES) {
    it(`${s.id}: static rule ids match expectedStatic`, () => {
      const parsed = parseUnifiedDiff(s.diff)
      const { files } = limitFiles(parsed)
      const ids = [...new Set(runStaticChecks(files, parsed.map((f) => f.path)).map((f) => f.ruleId))].sort()
      expect(ids).toEqual([...s.expectedStatic].sort())
    })
  }
  it('each sample is a small valid diff', () => {
    for (const s of SAMPLES) expect(new TextEncoder().encode(s.diff).length).toBeLessThan(10_000)
  })
})
