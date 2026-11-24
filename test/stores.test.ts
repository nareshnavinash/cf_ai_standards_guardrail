import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from './helpers/sqlite'
import { MemoryStore } from '../src/memory-store'
import { ControlStore } from '../src/control-store'
import type { ReviewResult } from '../src/types'

const review = (id: string, createdAt: string): ReviewResult => ({
  id, repo: 'o/r', prNumber: 1, title: 't', mode: 'full', findings: [], suppressed: [], filesReviewed: 0,
  skippedFiles: [], degradedFiles: [], truncated: false, rulesVersion: 'v', cached: false, createdAt,
})

describe('MemoryStore', () => {
  let m: MemoryStore
  beforeEach(() => void (m = new MemoryStore(sqliteAdapter())))

  it('adds, lists and removes exceptions, with a limit of 25', () => {
    const a = m.addException({ ruleId: 'STD-001', pathGlob: 'test/**', reason: 'fixtures' })
    expect(a.id).toMatch(/[0-9a-f-]{36}/)
    expect(m.listExceptions()).toEqual([a])
    expect(m.removeException(a.id)).toBe(true)
    expect(m.removeException(a.id)).toBe(false)
    for (let i = 0; i < 25; i++) m.addException({ ruleId: 'STD-001', pathGlob: `d${i}/**`, reason: 'because' })
    expect(() => m.addException({ ruleId: 'STD-001', pathGlob: 'x/**', reason: 'because' })).toThrow('limit')
  })
  it('saves and loads reviews, replacing by id', () => {
    m.saveReview(review('a', '2026-01-01T00:00:00Z'))
    m.saveReview({ ...review('a', '2026-01-01T00:00:00Z'), title: 'new' })
    expect(m.getReview('a')?.title).toBe('new')
    expect(m.getReview('nope')).toBeNull()
  })
  it('keeps only the 50 newest reviews and drops pruned chat', () => {
    for (let i = 0; i < 52; i++) {
      const id = 'r' + String(i).padStart(2, '0')
      m.saveReview(review(id, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`))
      m.appendChat(id, [{ role: 'user', content: 'q', at: 'a' }])
    }
    expect(m.getReview('r00')).toBeNull()
    expect(m.getReview('r01')).toBeNull()
    expect(m.getReview('r02')).not.toBeNull()
    expect(m.getReview('r51')).not.toBeNull()
    expect(m.getChat('r00', 10)).toEqual([])
  })
  it('keeps chat histories separate per review and in order', () => {
    m.appendChat('a', [{ role: 'user', content: 'a1', at: '1' }, { role: 'assistant', content: 'a2', at: '2' }])
    m.appendChat('b', [{ role: 'user', content: 'b1', at: '3' }])
    expect(m.getChat('a', 10).map((t) => t.content)).toEqual(['a1', 'a2'])
    expect(m.getChat('b', 10).map((t) => t.content)).toEqual(['b1'])
    expect(m.getChat('a', 1).map((t) => t.content)).toEqual(['a2'])
  })
  it('caps chat at 40 turns per review, keeping the newest', () => {
    for (let i = 0; i < 45; i++) m.appendChat('a', [{ role: 'user', content: 'm' + i, at: String(i) }])
    const all = m.getChat('a', 100)
    expect(all).toHaveLength(40)
    expect(all[0].content).toBe('m5')
    expect(all.at(-1)!.content).toBe('m44')
  })
})

describe('ControlStore', () => {
  let c: ControlStore
  let now = 1_000_000
  beforeEach(() => void (c = new ControlStore(sqliteAdapter(), () => now)))

  it('indexes reviews and stores their diff', () => {
    c.registerReview('id1', 'o/r', 'o/r#v1', 'v1', 'DIFF')
    expect(c.getReviewIndex('id1')).toEqual({ repo: 'o/r', memoryKey: 'o/r#v1', visitor: 'v1' })
    expect(c.getDiff('id1')).toBe('DIFF')
    expect(c.getReviewIndex('nope')).toBeNull()
    expect(c.getDiff('nope')).toBeNull()
  })
  it('deletes rows older than 30 days on write', () => {
    c.registerReview('old', 'o/r', 'k', 'v', 'D')
    now += 31 * 24 * 60 * 60 * 1000
    c.registerReview('new', 'o/r', 'k', 'v', 'D')
    expect(c.getReviewIndex('old')).toBeNull()
    expect(c.getDiff('old')).toBeNull()
    expect(c.getReviewIndex('new')).not.toBeNull()
  })
  it('in-flight entries expire after 10 minutes and can be cleared by review id', () => {
    c.setInflight('k1', 'r1', 'full')
    expect(c.getInflight('k1')).toEqual({ reviewId: 'r1', mode: 'full' })
    now += 9 * 60 * 1000
    expect(c.getInflight('k1')).not.toBeNull()
    now += 2 * 60 * 1000
    expect(c.getInflight('k1')).toBeNull()
    c.setInflight('k2', 'r2', 'full')
    c.clearInflight('r2')
    expect(c.getInflight('k2')).toBeNull()
  })
  it('reserveReview is atomic against the daily cap', () => {
    const got = Array.from({ length: 5 }, () => c.reserveReview('2026-11-24', 3))
    expect(got).toEqual([true, true, true, false, false])
    expect(c.reserveReview('2026-11-25', 3)).toBe(true)
  })
  it('reserveChat enforces the per-review and daily caps', () => {
    for (let i = 0; i < 10; i++) expect(c.reserveChat('r1', '2026-11-24', 60, 10)).toBe('ok')
    expect(c.reserveChat('r1', '2026-11-24', 60, 10)).toBe('review')
    expect(c.reserveChat('r2', '2026-11-24', 10, 10)).toBe('daily')
  })
})
