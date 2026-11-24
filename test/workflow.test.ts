import { describe, expect, it, vi } from 'vitest'
import { runReview, type StepLike } from '../src/workflow'
import { addFiles } from '../src/samples'
import type { ExceptionRecord, ReviewParams, ReviewResult } from '../src/types'

function fakeStep(failing: string[] = []): StepLike & { names: string[] } {
  const names: string[] = []
  return {
    names,
    async do(name: string, a: any, b?: any) {
      names.push(name)
      if (failing.includes(name)) throw new Error('step failed')
      return (typeof a === 'function' ? a : b)()
    },
  } as any
}

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k)
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v
    }),
    put: vi.fn(async (k: string, v: string, _opts?: unknown) => void store.set(k, v)),
  }
}

function fakeMemory(exceptions: ExceptionRecord[] = []) {
  const saved: ReviewResult[] = []
  return { exceptions, saved, listExceptions: async () => exceptions, saveReview: async (r: ReviewResult) => void saved.push(r) }
}

/** AI that flags STD-005 on line 1 of every file, except paths in `failOn`. Tracks max concurrency. */
function fakeAi(failOn: string[] = []) {
  let inflight = 0
  const state = { calls: 0, maxInflight: 0 }
  const run = vi.fn(async (_model: string, input: any) => {
    state.calls++
    inflight++
    state.maxInflight = Math.max(state.maxInflight, inflight)
    await new Promise((r) => setTimeout(r, 5))
    inflight--
    const path = /<code path="([^"]+)"/.exec(input.messages[1].content)![1]
    if (failOn.includes(path)) throw new Error('model down')
    return { response: { findings: [{ ruleId: 'STD-005', line: 1, message: 'no timeout', suggestion: 'add one' }] } }
  })
  return { ai: { run } as any, state }
}

const clean = (n: number) => `const v${n} = ${n}`
const diffOf = (paths: string[]) => addFiles(paths.map((p, i) => ({ path: p, lines: [clean(i), clean(i + 1)] })))
const params = (diff: string, over: Partial<ReviewParams> = {}): ReviewParams => ({
  reviewId: 'r1',
  repo: 'o/r',
  memoryKey: 'o/r',
  prNumber: 1,
  title: 't',
  diff,
  mode: 'full',
  ...over,
})

describe('runReview', () => {
  it('degrades instead of erroring', async () => {
    const diff = addFiles([
      { path: 'src/a.ts', lines: ['const a = 1'] },
      { path: 'src/b.ts', lines: ['const b = 1'] },
      { path: 'src/c.ts', lines: ['const c = 1'] },
      { path: 'test/x.test.ts', lines: ['// TODO later'] },
    ])
    const kv = fakeKv()
    const mem = fakeMemory()
    const { ai } = fakeAi(['src/b.ts'])
    const r = await runReview(params(diff), { step: fakeStep(), ai, cache: kv as any, memory: mem })
    expect(r.degradedFiles).toEqual(['src/b.ts'])
    expect(r.findings.filter((f) => f.source === 'llm').map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/c.ts', 'test/x.test.ts'])
    expect(r.findings.some((f) => f.ruleId === 'STD-003' && f.path === 'test/x.test.ts')).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
    expect(mem.saved).toHaveLength(1)
    expect(r.mode).toBe('full')
  })

  it('stores to cache on a clean full run and serves the next run from it', async () => {
    const diff = diffOf(['src/a.ts', 'test/a.test.ts'])
    const kv = fakeKv()
    const first = fakeAi()
    const r1 = await runReview(params(diff), { step: fakeStep(), ai: first.ai, cache: kv as any, memory: fakeMemory() })
    expect(r1.cached).toBe(false)
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 30 * 24 * 60 * 60 })

    const second = fakeAi()
    const r2 = await runReview(params(diff, { reviewId: 'r2' }), { step: fakeStep(), ai: second.ai, cache: kv as any, memory: fakeMemory() })
    expect(second.state.calls).toBe(0)
    expect(r2.cached).toBe(true)
    expect(r2.findings).toEqual(r1.findings)
    expect(r2.filesReviewed).toBe(r1.filesReviewed)
  })

  it('applies exceptions added after a cached run', async () => {
    const diff = diffOf(['src/a.ts', 'test/a.test.ts'])
    const kv = fakeKv()
    const mem = fakeMemory()
    const { ai } = fakeAi()
    const r1 = await runReview(params(diff), { step: fakeStep(), ai, cache: kv as any, memory: mem })
    expect(r1.findings.some((f) => f.ruleId === 'STD-005' && f.path === 'src/a.ts')).toBe(true)

    mem.exceptions.push({ id: 'e1', ruleId: 'STD-005', pathGlob: 'src/**', reason: 'internal calls', createdAt: 't' })
    const r2 = await runReview(params(diff, { reviewId: 'r2' }), { step: fakeStep(), ai, cache: kv as any, memory: mem })
    expect(r2.cached).toBe(true)
    expect(r2.findings.some((f) => f.path === 'src/a.ts' && f.ruleId === 'STD-005')).toBe(false)
    expect(r2.suppressed.some((f) => f.path === 'src/a.ts' && f.ruleId === 'STD-005')).toBe(true)
  })

  it('static-only mode never calls the AI and never caches', async () => {
    const diff = addFiles([{ path: 'src/a.ts', lines: ['// TODO later'] }])
    const kv = fakeKv()
    const { ai, state } = fakeAi()
    const r = await runReview(params(diff, { mode: 'static-only' }), { step: fakeStep(), ai, cache: kv as any, memory: fakeMemory() })
    expect(state.calls).toBe(0)
    expect(kv.put).not.toHaveBeenCalled()
    expect(r.mode).toBe('static-only')
    expect(r.findings.map((f) => f.ruleId).sort()).toEqual(['STD-003', 'STD-004'])
  })

  it('runs LLM checks in batches of at most 4 concurrent', async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`)
    const diff = diffOf([...paths, 'test/a.test.ts'].slice(0, 7))
    const { ai, state } = fakeAi()
    const step = fakeStep()
    await runReview(params(diff), { step, ai, cache: fakeKv() as any, memory: fakeMemory() })
    expect(state.calls).toBe(7)
    expect(state.maxInflight).toBe(4)
    expect(step.names.filter((n) => n.startsWith('llm-check:'))).toHaveLength(7)
  })

  it('records skipped files and truncation, and keeps step names stable', async () => {
    const diff = addFiles([
      { path: 'package-lock.json', lines: ['{}'] },
      { path: 'src/a.ts', lines: ['const a = 1'] },
      { path: 'test/a.test.ts', lines: ['const t = 1'] },
    ])
    const step = fakeStep()
    const r = await runReview(params(diff, { mode: 'static-only' }), { step, ai: fakeAi().ai, cache: fakeKv() as any, memory: fakeMemory() })
    expect(r.skippedFiles).toEqual(['package-lock.json'])
    expect(r.filesReviewed).toBe(2)
    expect(step.names).toEqual(['parse', 'cache-lookup', 'static-checks', 'apply-exceptions', 'persist'])
  })
})
