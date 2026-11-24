import { describe, expect, it, vi } from 'vitest'
import { runReview, type StepLike } from '../src/workflow'
import { addFiles } from '../src/samples'
import type { ExceptionRecord, ReviewParams, ReviewResult } from '../src/types'

/** Runs steps like Workflows: retries per opts, and (with `replay`) returns recorded results by step name. */
function fakeStep(failing: string[] = [], replay?: Map<string, unknown>): StepLike & { names: string[] } {
  const names: string[] = []
  return {
    names,
    async do(name: string, a: any, b?: any) {
      names.push(name)
      if (replay?.has(name)) return replay.get(name)
      if (failing.includes(name)) throw new Error('step failed')
      const fn = typeof a === 'function' ? a : b
      const attempts = typeof a === 'object' && a?.retries ? a.retries.limit + 1 : 1
      let last: unknown
      for (let i = 0; i < attempts; i++) {
        try {
          const v = await fn()
          replay?.set(name, v)
          return v
        } catch (e) {
          last = e
        }
      }
      throw last
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
    expect(r.findings.filter((f) => f.source === 'llm').map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/c.ts'])
    expect(r.findings.some((f) => f.ruleId === 'STD-003' && f.path === 'test/x.test.ts')).toBe(true)
    expect(kv.put).not.toHaveBeenCalled()
    expect(mem.saved).toHaveLength(1)
    expect(r.mode).toBe('full')
  })

  it('retries transport errors but not parse failures', async () => {
    const diff = addFiles([{ path: 'src/a.ts', lines: ['const a = 1'] }, { path: 'test/a.test.ts', lines: ['const t = 1'] }])
    const down = { run: vi.fn(async () => { throw new Error('503') }) }
    const r1 = await runReview(params(diff), { step: fakeStep(), ai: down as any, cache: fakeKv() as any, memory: fakeMemory() })
    expect(down.run).toHaveBeenCalledTimes(3)
    expect(r1.degradedFiles).toEqual(['src/a.ts'])
    const junk = { run: vi.fn(async () => ({ response: '{"findings":[{"ru' })) }
    const kv = fakeKv()
    const r2 = await runReview(params(diff), { step: fakeStep(), ai: junk as any, cache: kv as any, memory: fakeMemory() })
    expect(junk.run).toHaveBeenCalledTimes(1)
    expect(r2.degradedFiles).toEqual(['src/a.ts'])
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('never sends test files to the LLM but still runs static rules on them', async () => {
    const diff = addFiles([
      { path: 'src/a.ts', lines: ['const a = 1'] },
      { path: 'test/a.test.ts', lines: ['// TODO later'] },
    ])
    const { ai, state } = fakeAi()
    const step = fakeStep()
    const r = await runReview(params(diff), { step, ai, cache: fakeKv() as any, memory: fakeMemory() })
    expect(state.calls).toBe(1)
    expect(step.names.filter((n) => n.startsWith('llm-check:'))).toEqual(['llm-check:0'])
    expect(r.findings.some((f) => f.ruleId === 'STD-003' && f.path === 'test/a.test.ts')).toBe(true)
    expect(r.findings.some((f) => f.source === 'llm' && f.path === 'test/a.test.ts')).toBe(false)
  })

  it('treats a malformed cache entry as a miss', async () => {
    const diff = diffOf(['src/a.ts', 'test/a.test.ts'])
    const kv = fakeKv()
    const { cacheKey } = await import('../src/review')
    for (const bad of ['{}', '{"findings":[1,2]}', '{"findings":[{"ruleId":5,"path":"a"}],"filesReviewed":1,"skippedFiles":[],"truncated":false}', 'not json']) {
      kv.store.set(await cacheKey(diff), bad)
      const { ai, state } = fakeAi()
      const r = await runReview(params(diff), { step: fakeStep(), ai, cache: kv as any, memory: fakeMemory() })
      expect(r.cached).toBe(false)
      expect(state.calls).toBe(1)
    }
  })

  it('static-only ignores a cached full result', async () => {
    const diff = diffOf(['src/a.ts', 'test/a.test.ts'])
    const kv = fakeKv()
    await runReview(params(diff), { step: fakeStep(), ai: fakeAi().ai, cache: kv as any, memory: fakeMemory() })
    const { ai, state } = fakeAi()
    const r = await runReview(params(diff, { mode: 'static-only' }), { step: fakeStep(), ai, cache: kv as any, memory: fakeMemory() })
    expect(r.cached).toBe(false)
    expect(r.mode).toBe('static-only')
    expect(state.calls).toBe(0)
    expect(r.findings.every((f) => f.source === 'static')).toBe(true)
  })

  it('survives a failing cache write (KV quota)', async () => {
    const diff = diffOf(['src/a.ts', 'test/a.test.ts'])
    const kv = fakeKv()
    kv.put = vi.fn(async () => { throw new Error('KV put() limit exceeded') })
    const r = await runReview(params(diff), { step: fakeStep(), ai: fakeAi().ai, cache: kv as any, memory: fakeMemory() })
    expect(r.cached).toBe(false)
    expect(r.findings.length).toBeGreaterThan(0)
  })

  it('is deterministic on replay: recorded steps are not re-run', async () => {
    const diff = diffOf(['src/a.ts', 'src/b.ts', 'test/a.test.ts'])
    const replay = new Map<string, unknown>()
    const kv = fakeKv()
    const mem = fakeMemory()
    const first = fakeAi()
    const r1 = await runReview(params(diff), { step: fakeStep([], replay), ai: first.ai, cache: kv as any, memory: mem })
    expect(first.state.calls).toBe(2)
    const second = fakeAi()
    const r2 = await runReview(params(diff), { step: fakeStep([], replay), ai: second.ai, cache: kv as any, memory: mem })
    expect(second.state.calls).toBe(0)
    expect(r2).toEqual(r1)
    expect(mem.saved).toHaveLength(1)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight marker in the persist step', async () => {
    const control = { clearInflight: vi.fn(async () => {}) }
    await runReview(params(diffOf(['src/a.ts', 'test/a.test.ts']), { mode: 'static-only' }), {
      step: fakeStep(), ai: fakeAi().ai, cache: fakeKv() as any, memory: fakeMemory(), control,
    })
    expect(control.clearInflight).toHaveBeenCalledWith('r1')
  })

  it('a deleted test file does not satisfy STD-004', async () => {
    const diff =
      addFiles([{ path: 'src/a.ts', lines: ['const a = 1'] }]) +
      ['diff --git a/test/old.test.ts b/test/old.test.ts', 'deleted file mode 100644', 'index 111..000', '--- a/test/old.test.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-x'].join('\n') + '\n'
    const r = await runReview(params(diff, { mode: 'static-only' }), { step: fakeStep(), ai: fakeAi().ai, cache: fakeKv() as any, memory: fakeMemory() })
    expect(r.findings.some((f) => f.ruleId === 'STD-004')).toBe(true)
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
    expect(step.names).toEqual(['parse', 'static-checks', 'apply-exceptions', 'persist'])
  })
})
