import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  const DAY = '2026-11-24'
  const claim = (over: Record<string, unknown> = {}) =>
    c.claimReview({
      inflightKey: 'k1', reviewId: 'r1', repo: 'o/r', memoryKey: 'o/r#v1', visitor: 'v1', diff: 'DIFF', day: DAY,
      cap: 10, neuronBudget: 9000, ip: 'ip1', ipCap: 4, needsBudget: true, ...over,
    } as any)
  beforeEach(() => {
    now = 1_000_000
    c = new ControlStore(sqliteAdapter(), () => now)
  })

  it('claimReview indexes the review, stores the diff and marks it in flight, atomically', () => {
    expect(claim()).toEqual({ kind: 'claimed', mode: 'full' })
    expect(c.getReviewIndex('r1')).toEqual({ repo: 'o/r', memoryKey: 'o/r#v1', visitor: 'v1' })
    expect(c.getDiff('r1')).toBe('DIFF')
    expect(c.getReviewIndex('nope')).toBeNull()
    expect(claim({ reviewId: 'r2' })).toEqual({ kind: 'existing', reviewId: 'r1', mode: 'full' })
    expect(c.getReviewIndex('r2')).toBeNull()
  })
  it('in-flight claims expire after 10 minutes and clearInflight frees the key', () => {
    claim()
    now += 9 * 60 * 1000
    expect(claim({ reviewId: 'r2' }).kind).toBe('existing')
    now += 2 * 60 * 1000
    expect(claim({ reviewId: 'r3' })).toEqual({ kind: 'claimed', mode: 'full' })
    c.clearInflight('r3')
    expect(claim({ reviewId: 'r4' })).toEqual({ kind: 'claimed', mode: 'full' })
  })
  it('releaseReview clears the marker and the index, and refunds the slot only when asked', () => {
    expect(claim({ cap: 1 })).toEqual({ kind: 'claimed', mode: 'full' })
    c.releaseReview('r1', true)
    expect(c.getReviewIndex('r1')).toBeNull()
    expect(claim({ reviewId: 'r2', cap: 1 })).toEqual({ kind: 'claimed', mode: 'full' })
    c.releaseReview('r2', false) // no refund: the slot stays spent
    expect(claim({ reviewId: 'r3', cap: 1 })).toEqual({ kind: 'claimed', mode: 'static-only' })
    c.releaseReview('r3', true)
    c.releaseReview('r3', true) // a static-only claim holds no slot, so nothing is refunded (never twice)
    expect(claim({ reviewId: 'r4', cap: 1 })).toEqual({ kind: 'claimed', mode: 'static-only' })
  })
  it('a finished review keeps its slot (clearInflight) so a later release cannot refund it', () => {
    claim({ cap: 1 })
    c.clearInflight('r1')
    c.releaseReview('r1', true)
    expect((claim({ reviewId: 'r2', cap: 1 }) as any).mode).toBe('static-only')
  })
  it('needsBudget=false (cached diff) takes no slot; forceStatic runs static-only', () => {
    expect(claim({ cap: 0, needsBudget: false })).toEqual({ kind: 'claimed', mode: 'full' })
    expect(claim({ reviewId: 'r2', inflightKey: 'k2', forceStatic: true })).toEqual({ kind: 'claimed', mode: 'static-only' })
  })
  it('daily count cap falls back to static-only', () => {
    const modes = [1, 2, 3, 4, 5].map((i) => (claim({ reviewId: 'r' + i, inflightKey: 'k' + i, cap: 3, ip: null }) as any).mode)
    expect(modes).toEqual(['full', 'full', 'full', 'static-only', 'static-only'])
    expect((claim({ reviewId: 'n', inflightKey: 'kn', cap: 3, day: '2026-11-25', ip: null }) as any).mode).toBe('full')
  })
  it('claims static-only once the neuron budget is spent, and recordUsage is idempotent per key', () => {
    c.recordUsage('r0:llm-check:0', DAY, 5000)
    c.recordUsage('r0:llm-check:0', DAY, 5000)
    expect(c.neuronsSpent(DAY)).toBe(5000)
    expect((claim() as any).mode).toBe('full')
    c.recordUsage('r0:llm-check:1', DAY, 4000)
    expect(c.neuronsSpent(DAY)).toBe(9000)
    expect(claim({ reviewId: 'r2', inflightKey: 'k2' })).toEqual({ kind: 'claimed', mode: 'static-only' })
    expect(c.neuronsSpent('2026-11-25')).toBe(0)
  })
  it('per-IP daily cap applies to LLM reviews only and reports ip-limit', () => {
    for (let i = 0; i < 4; i++) expect(claim({ reviewId: 'r' + i, inflightKey: 'k' + i, ipCap: 4 }).kind).toBe('claimed')
    expect(claim({ reviewId: 'x', inflightKey: 'kx', ipCap: 4 })).toEqual({ kind: 'ip-limit' })
    expect(c.getReviewIndex('x')).toBeNull()
    expect(claim({ reviewId: 'y', inflightKey: 'ky', ipCap: 4, needsBudget: false }).kind).toBe('claimed')
    expect(claim({ reviewId: 'z', inflightKey: 'kz', ipCap: 4, forceStatic: true }).kind).toBe('claimed')
    expect(claim({ reviewId: 'o', inflightKey: 'ko', ipCap: 4, ip: 'ip2' }).kind).toBe('claimed')
  })
  it('an in-flight hit is returned even when the IP is over its cap', () => {
    claim({ ipCap: 1 })
    expect(claim({ reviewId: 'r2', ipCap: 1 })).toEqual({ kind: 'existing', reviewId: 'r1', mode: 'full' })
  })
  it('reserveChat enforces per-review, per-IP, daily and neuron limits; refundChat gives the slot back', () => {
    const rc = (o: Record<string, unknown> = {}) =>
      c.reserveChat({ reviewId: 'r1', day: DAY, dailyCap: 40, perReviewCap: 10, ip: 'ip1', ipCap: 15, neuronBudget: 9000, ...o } as any)
    for (let i = 0; i < 10; i++) expect(rc()).toBe('ok')
    expect(rc()).toBe('review')
    expect(rc({ reviewId: 'r2', dailyCap: 10 })).toBe('daily')
    for (let i = 0; i < 5; i++) expect(rc({ reviewId: 'a' + i })).toBe('ok')
    expect(rc({ reviewId: 'b' })).toBe('ip')
    expect(rc({ reviewId: 'b', ip: null })).toBe('ok')
    c.refundChat({ reviewId: 'r1', day: DAY, ip: 'ip1' })
    expect(rc()).toBe('ok')
    c.recordUsage('u', DAY, 9000)
    expect(rc({ reviewId: 'c', ip: 'ip9' })).toBe('budget')
  })
  it('deletes index rows older than 30 days, at most once per hour', () => {
    claim()
    now += 31 * 24 * 60 * 60 * 1000
    claim({ reviewId: 'r2', inflightKey: 'k2' })
    expect(c.getReviewIndex('r1')).toBeNull()
    expect(c.getReviewIndex('r2')).not.toBeNull()
  })
  it('drops stored diffs after 3 days but keeps the index for 30', () => {
    claim()
    now += 3 * 24 * 60 * 60 * 1000 + 1000
    claim({ reviewId: 'r2', inflightKey: 'k2' })
    expect(c.getDiff('r1')).toBeNull()
    expect(c.getReviewIndex('r1')).not.toBeNull()
    expect(c.getDiff('r2')).toBe('DIFF')
  })
  it('prunes at most once per hour', () => {
    const sql = sqliteAdapter()
    const spy = vi.fn(sql.exec.bind(sql))
    const store = new ControlStore({ exec: spy } as any, () => now)
    const deletes = () => spy.mock.calls.filter((a) => /DELETE FROM reviews/.test(a[0] as string)).length
    const args = { inflightKey: 'k', reviewId: 'a', repo: 'o/r', memoryKey: 'm', visitor: 'v', diff: 'D', day: DAY, cap: 9, neuronBudget: 9, ip: null, ipCap: 4, needsBudget: false } as any
    store.claimReview(args)
    store.claimReview({ ...args, inflightKey: 'k2', reviewId: 'b' })
    expect(deletes()).toBe(1)
    now += 61 * 60 * 1000
    store.claimReview({ ...args, inflightKey: 'k3', reviewId: 'c' })
    expect(deletes()).toBe(2)
  })
})
