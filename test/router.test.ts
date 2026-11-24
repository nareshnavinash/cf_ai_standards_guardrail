import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../src/router'
import { SAMPLES } from '../src/samples'
import type { ChatTurn, ExceptionRecord, ReviewResult } from '../src/types'

import { sqliteAdapter } from './helpers/sqlite'
import { MemoryStore } from '../src/memory-store'
import { ControlStore } from '../src/control-store'

const VISITOR = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'
const DAY = () => new Date().toISOString().slice(0, 10)
const SAMPLE_KEY = (v: string) => `sample:demo/sample-service#${v}`

/** DO RPC methods are always async; wrap a sync store the same way. */
function asyncify<T extends object>(store: T): any {
  return new Proxy(store, {
    get: (target, prop) => {
      const v = (target as any)[prop]
      return typeof v === 'function' ? async (...a: unknown[]) => v.apply(target, a) : v
    },
  })
}

function makeEnv(over: Record<string, unknown> = {}) {
  const store = new Map<string, string>()
  const kv = {
    store,
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k)
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v
    }),
    put: vi.fn(async (k: string, v: string, _o?: unknown) => void store.set(k, v)),
  }
  const mems = new Map<string, any>()
  const mem = (key: string) => {
    if (!mems.has(key)) mems.set(key, asyncify(new MemoryStore(sqliteAdapter())))
    return mems.get(key)
  }
  const controlStore = new ControlStore(sqliteAdapter())
  const control = asyncify(controlStore)
  const create = vi.fn(async (_o: any) => ({ id: 'x' }))
  const wfStatus = { status: 'running' as string, output: undefined as unknown }
  const env: any = {
    CACHE: kv,
    CONTROL: { idFromName: (n: string) => n, get: () => control },
    REVIEW_WORKFLOW: { create, get: vi.fn(async () => ({ status: async () => wfStatus })) },
    REPO_MEMORY: { idFromName: (n: string) => n, get: (n: string) => mem(n) },
    AI: { run: vi.fn(async () => ({ response: 'Here is how to fix it.' })) },
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    REVIEW_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CHAT_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    DAILY_LLM_REVIEWS: '12',
    DAILY_CHAT_TURNS: '60',
    EVAL_KEY: 'secret-eval-key',
    ...over,
  }
  return { env, kv, create, mem, wfStatus, control }
}

const call = (env: any, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  handleRequest(
    new Request('https://x.test' + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  )
const post = (env: any, body: unknown, headers: Record<string, string> = {}) => call(env, 'POST', '/api/reviews', body, headers)

let t: ReturnType<typeof makeEnv>
beforeEach(() => {
  t = makeEnv()
})

describe('basic routes', () => {
  it('health reports token presence', async () => {
    expect(await (await call(t.env, 'GET', '/api/health')).json()).toEqual({ ok: true, githubToken: false })
    const t2 = makeEnv({ GITHUB_TOKEN: 'x' })
    expect(await (await call(t2.env, 'GET', '/api/health')).json()).toEqual({ ok: true, githubToken: true })
  })
  it('lists rules and samples', async () => {
    const rules = (await (await call(t.env, 'GET', '/api/rules')).json()) as any[]
    expect(rules).toHaveLength(7)
    const samples = (await (await call(t.env, 'GET', '/api/samples')).json()) as any[]
    expect(samples.map((s) => s.id)).toEqual(SAMPLES.map((s) => s.id))
    expect(Object.keys(samples[0]).sort()).toEqual(['description', 'id', 'title'])
  })
  it('unknown /api route is a 404 json; other paths go to assets', async () => {
    const r = await call(t.env, 'GET', '/api/x')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'Not found' })
    expect(await (await call(t.env, 'GET', '/')).text()).toBe('asset')
  })
})

describe('POST /api/reviews invalid input', () => {
  const bad: [string, unknown][] = [
    ['invalid json', '{nope'],
    ['empty object', {}],
    ['array body', []],
    ['unknown sample', { sampleId: 'nope' }],
    ['GHE url', { prUrl: 'https://github.example.com/a/b/pull/1' }],
    ['issue url', { prUrl: 'https://github.com/a/b/issues/1' }],
    ['non-string prUrl', { prUrl: 5 }],
  ]
  for (const [name, body] of bad) {
    it(`${name} -> 400, no workflow`, async () => {
      const r = await post(t.env, body)
      expect(r.status).toBe(400)
      expect(typeof ((await r.json()) as any).error).toBe('string')
      expect(t.create).not.toHaveBeenCalled()
    })
  }
  it('limiter failure -> 429, no workflow', async () => {
    t.env.REVIEW_LIMITER.limit = vi.fn(async () => ({ success: false }))
    const r = await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })
    expect(r.status).toBe(429)
    expect(t.create).not.toHaveBeenCalled()
  })
  it('a throwing limiter fails closed (429)', async () => {
    t.env.REVIEW_LIMITER.limit = vi.fn(async () => {
      throw new Error('limiter down')
    })
    expect((await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).status).toBe(429)
    expect(t.create).not.toHaveBeenCalled()
  })
  it('missing limiter binding means allow', async () => {
    const t2 = makeEnv({ REVIEW_LIMITER: undefined })
    expect((await post(t2.env, { sampleId: 'leaky-config' })).status).toBe(202)
  })
})

describe('POST /api/reviews samples', () => {
  it('starts a workflow scoped to the visitor, with zero KV writes', async () => {
    const r = await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })
    expect(r.status).toBe(202)
    const body = (await r.json()) as any
    expect(body).toMatchObject({ repo: 'demo/sample-service', mode: 'full' })
    expect(t.create).toHaveBeenCalledTimes(1)
    const arg = t.create.mock.calls[0][0]
    expect(arg.id).toBe(body.reviewId)
    expect(arg.params).toMatchObject({ memoryKey: SAMPLE_KEY(VISITOR), repo: 'demo/sample-service', mode: 'full', prNumber: null })
    expect(await t.control.getReviewIndex(body.reviewId)).toEqual({ repo: 'demo/sample-service', memoryKey: SAMPLE_KEY(VISITOR), visitor: VISITOR })
    expect(await t.control.getDiff(body.reviewId)).toBe(SAMPLES[0].diff)
    expect(t.kv.put).not.toHaveBeenCalled()
  })
  it('dedupes while in flight, per visitor', async () => {
    const a = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    const b = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(b.reviewId).toBe(a.reviewId)
    expect(t.create).toHaveBeenCalledTimes(1)
    const c = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': OTHER })).json()) as any
    expect(c.reviewId).not.toBe(a.reviewId)
    expect(t.create).toHaveBeenCalledTimes(2)
  })
  it('does not dedupe against a review that already finished', async () => {
    const a = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    await t.mem(SAMPLE_KEY(VISITOR)).saveReview({ id: a.reviewId, createdAt: 't' } as ReviewResult)
    const b = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(b.reviewId).not.toBe(a.reviewId)
  })
  it('reserves the daily budget atomically; beyond the cap runs static-only', async () => {
    const first = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(first.mode).toBe('full')
    for (let i = 0; i < 11; i++) expect(await t.control.reserveReview(DAY(), 12)).toBe(true)
    const r = (await (await post(t.env, { sampleId: 'swallowed-errors' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(r.mode).toBe('static-only')
    expect(t.create.mock.calls[1][0].params.mode).toBe('static-only')
  })
  it('a cached diff stays full-mode without reserving budget', async () => {
    const { cacheKey } = await import('../src/review')
    t.kv.store.set(await cacheKey(SAMPLES[0].diff), JSON.stringify({ findings: [{ ruleId: 'STD-001', path: 'src/a.ts', line: 1, message: 'm', suggestion: null, source: 'static' }], filesReviewed: 1, skippedFiles: [], truncated: false }))
    for (let i = 0; i < 12; i++) await t.control.reserveReview(DAY(), 12)
    const r = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(r.mode).toBe('full')
  })
  it('a malformed cache entry is not a hit', async () => {
    const { cacheKey } = await import('../src/review')
    t.kv.store.set(await cacheKey(SAMPLES[0].diff), '{}')
    for (let i = 0; i < 12; i++) await t.control.reserveReview(DAY(), 12)
    const r = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(r.mode).toBe('static-only')
  })
  it('without a visitor id uses a shared anonymous key', async () => {
    await post(t.env, { sampleId: 'clean-change' })
    expect(t.create.mock.calls[0][0].params.memoryKey).toBe(SAMPLE_KEY('anon'))
  })
  it('returns 503 when storage fails, never 500', async () => {
    t.control.registerReview = vi.fn(async () => {
      throw new Error('storage down')
    })
    const r = await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'Service is busy, try again later' })
    expect(t.create).not.toHaveBeenCalled()
  })
  it('returns 503 when the workflow cannot be created', async () => {
    t.create.mockRejectedValueOnce(new Error('workflow quota'))
    const r = await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })
    expect(r.status).toBe(503)
  })
})

describe('POST /api/reviews with a PR url', () => {
  const stubGitHub = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        const accept = (init!.headers as Record<string, string>).Accept
        return accept.includes('diff') ? new Response(SAMPLES[3].diff) : new Response(JSON.stringify({ title: 'My PR', changed_files: 2, base: { repo: { private: false } } }))
      }),
    )
  it('fetches the diff server-side; memory is scoped to repo and visitor', async () => {
    stubGitHub()
    try {
      const r = await post(t.env, { prUrl: 'https://github.com/Foo/Bar/pull/9' }, { 'x-visitor-id': VISITOR })
      expect(r.status).toBe(202)
      expect(t.create.mock.calls[0][0].params).toMatchObject({ repo: 'foo/bar', memoryKey: `foo/bar#${VISITOR}`, prNumber: 9, title: 'My PR' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('an anonymous visitor gets a shared read-only key', async () => {
    stubGitHub()
    try {
      await post(t.env, { prUrl: 'https://github.com/Foo/Bar/pull/9' })
      expect(t.create.mock.calls[0][0].params.memoryKey).toBe('foo/bar#anon')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('maps GitHub errors to their status without starting a workflow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    try {
      const r = await post(t.env, { prUrl: 'https://github.com/a/b/pull/1' })
      expect(r.status).toBe(404)
      expect(t.create).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('eval route', () => {
  const body = { evalDiff: SAMPLES[3].diff, repo: 'Eval/Case-1' }
  it('401 without or with a wrong key, and when EVAL_KEY is unset', async () => {
    expect((await post(t.env, body)).status).toBe(401)
    expect((await post(t.env, body, { 'x-eval-key': 'nope' })).status).toBe(401)
    const t2 = makeEnv({ EVAL_KEY: undefined })
    expect((await post(t2.env, body, { 'x-eval-key': 'undefined' })).status).toBe(401)
    expect(t.create).not.toHaveBeenCalled()
  })
  it('skips the limiter, does not spend budget, honours evalMode, uses visitor "eval"', async () => {
    t.env.REVIEW_LIMITER.limit = vi.fn(async () => ({ success: false }))
    const r = await post(t.env, body, { 'x-eval-key': 'secret-eval-key' })
    expect(r.status).toBe(202)
    expect((await r.json()) as any).toMatchObject({ repo: 'eval/case-1', mode: 'full' })
    expect(t.create.mock.calls[0][0].params.memoryKey).toBe('eval/case-1#eval')
    for (let i = 0; i < 12; i++) expect(await t.control.reserveReview(DAY(), 12)).toBe(true)
    const r2 = await post(t.env, { ...body, repo: 'eval/case-2', evalMode: 'static-only' }, { 'x-eval-key': 'secret-eval-key' })
    expect(((await r2.json()) as any).mode).toBe('static-only')
  })
  it('validates repo and diff size', async () => {
    const h = { 'x-eval-key': 'secret-eval-key' }
    expect((await post(t.env, { evalDiff: 'x', repo: 'bad repo!' }, h)).status).toBe(400)
    expect((await post(t.env, { evalDiff: 'x'.repeat(100 * 1024 + 1), repo: 'a/b' }, h)).status).toBe(413)
    expect(t.create).not.toHaveBeenCalled()
  })
})

async function startSample(sampleId = 'leaky-config', visitor = VISITOR) {
  const r = (await (await post(t.env, { sampleId }, { 'x-visitor-id': visitor })).json()) as any
  return r.reviewId as string
}
const result = (id: string, over: Partial<ReviewResult> = {}): ReviewResult => ({
  id, repo: 'demo/sample-service', prNumber: null, title: 'leaky-config', mode: 'full',
  findings: [{ ruleId: 'STD-001', path: 'src/config.ts', line: 3, message: 'secret', suggestion: 's', source: 'static' }],
  suppressed: [], filesReviewed: 1, skippedFiles: [], degradedFiles: [], truncated: false, rulesVersion: '2026.11.1', cached: false,
  createdAt: new Date().toISOString(), ...over,
})
const complete = async (id: string, visitor = VISITOR, over: Partial<ReviewResult> = {}) => t.mem(SAMPLE_KEY(visitor)).saveReview(result(id, over))

describe('GET /api/reviews/:id', () => {
  it('400 for a bad id, 404 for an unknown one', async () => {
    expect((await call(t.env, 'GET', '/api/reviews/..%2F')).status).toBe(400)
    expect((await call(t.env, 'GET', '/api/reviews/' + 'a'.repeat(101))).status).toBe(400)
    expect((await call(t.env, 'GET', '/api/reviews/unknown-id')).status).toBe(404)
  })
  it('running, then complete from the DO, even if the workflow is gone', async () => {
    const id = await startSample()
    expect(await (await call(t.env, 'GET', `/api/reviews/${id}`)).json()).toEqual({ status: 'running' })
    await complete(id)
    t.env.REVIEW_WORKFLOW.get = vi.fn(async () => {
      throw new Error('instance not found')
    })
    const b = (await (await call(t.env, 'GET', `/api/reviews/${id}`)).json()) as any
    expect(b.status).toBe('complete')
    expect(b.result.id).toBe(id)
  })
  it('maps errored/terminated/unknown to a fixed failed message', async () => {
    const id = await startSample()
    for (const s of ['errored', 'terminated', 'unknown']) {
      t.wfStatus.status = s
      const b = (await (await call(t.env, 'GET', `/api/reviews/${id}`)).json()) as any
      expect(b.status).toBe('failed')
      expect(b.error).toBe('The review could not be completed. Please try again.')
    }
  })
})

describe('chat', () => {
  const chat = (id: string, message = 'hi') => call(t.env, 'POST', `/api/reviews/${id}/chat`, { message })
  it('409 while the review is running, 400 for bad messages, 404 for unknown id', async () => {
    const id = await startSample()
    expect((await chat(id)).status).toBe(409)
    expect((await chat(id, '  ')).status).toBe(400)
    expect((await chat(id, 'x'.repeat(2001))).status).toBe(400)
    expect((await call(t.env, 'POST', `/api/reviews/${id}/chat`, 'nope')).status).toBe(400)
    expect((await chat('zzz')).status).toBe(404)
  })
  it('429 when rate limited, including a throwing limiter', async () => {
    const id = await startSample()
    t.env.CHAT_LIMITER.limit = vi.fn(async () => ({ success: false }))
    expect((await chat(id)).status).toBe(429)
    t.env.CHAT_LIMITER.limit = vi.fn(async () => {
      throw new Error('down')
    })
    expect((await chat(id)).status).toBe(429)
  })
  it('409 for static-only reviews, without calling the AI', async () => {
    const id = await startSample()
    await complete(id, VISITOR, { mode: 'static-only' })
    const r = await chat(id)
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error).toMatch(/static-only/i)
    expect(t.env.AI.run).not.toHaveBeenCalled()
  })
  it('replies and stores both turns once complete', async () => {
    const id = await startSample()
    await complete(id)
    const r = await chat(id, 'How do I fix STD-001?')
    expect(r.status).toBe(200)
    const b = (await r.json()) as any
    expect(b.reply).toBe('Here is how to fix it.')
    expect(b.history.map((h: ChatTurn) => h.role)).toEqual(['user', 'assistant'])
    const prompt = JSON.stringify(t.env.AI.run.mock.calls[0][1].messages)
    expect(prompt).toContain('STD-001')
    expect(prompt).toContain('api_key')
  })
  it('falls back to a fixed apology when the model fails', async () => {
    const id = await startSample()
    await complete(id)
    t.env.AI.run = vi.fn(async () => {
      throw new Error('boom internal detail')
    })
    const r = await chat(id, 'hello')
    expect(r.status).toBe(200)
    expect(JSON.stringify(await r.json())).not.toContain('boom')
  })
  it('allows 10 questions per review, then 429', async () => {
    const id = await startSample()
    await complete(id)
    for (let i = 0; i < 10; i++) expect((await chat(id, 'q' + i)).status).toBe(200)
    const r = await chat(id, 'one more')
    expect(r.status).toBe(429)
    expect(((await r.json()) as any).error).toMatch(/limit/i)
    expect(t.env.AI.run).toHaveBeenCalledTimes(10)
  })
  it('stops at the daily chat cap with a clear message', async () => {
    const t2 = makeEnv({ DAILY_CHAT_TURNS: '2' })
    t = t2
    const a = await startSample('leaky-config')
    const b = await startSample('swallowed-errors')
    await complete(a)
    await complete(b)
    expect((await chat(a)).status).toBe(200)
    expect((await chat(b)).status).toBe(200)
    const r = await chat(a)
    expect(r.status).toBe(429)
    expect(await r.json()).toEqual({ error: 'Daily AI budget used — chat resumes tomorrow' })
  })
  it('keeps histories separate across reviews of the same visitor', async () => {
    const a = await startSample('leaky-config')
    const b = await startSample('swallowed-errors')
    await complete(a)
    await complete(b)
    await chat(a, 'question for A')
    const rb = (await (await chat(b, 'question for B')).json()) as any
    expect(rb.history.map((h: ChatTurn) => h.content)).toEqual(['question for B', 'Here is how to fix it.'])
    const ra = (await (await chat(a, 'second for A')).json()) as any
    expect(ra.history.map((h: ChatTurn) => h.content)).toContain('question for A')
    expect(JSON.stringify(ra.history)).not.toContain('question for B')
  })
})

describe('exceptions', () => {
  const add = (id: string, body: unknown, headers: Record<string, string> = { 'x-visitor-id': VISITOR }) =>
    call(t.env, 'POST', `/api/reviews/${id}/exceptions`, body, headers)
  const good = { ruleId: 'STD-007', pathGlob: 'src/**', reason: 'internal tool' }

  it('creates, lists and deletes', async () => {
    const id = await startSample()
    const r = await add(id, good)
    expect(r.status).toBe(201)
    const rec = (await r.json()) as any
    expect(rec).toMatchObject(good)
    const list = (await (await call(t.env, 'GET', `/api/reviews/${id}/exceptions`)).json()) as any[]
    expect(list).toHaveLength(1)
    expect((await call(t.env, 'DELETE', `/api/reviews/${id}/exceptions/${rec.id}`, undefined, { 'x-visitor-id': VISITOR })).status).toBe(204)
    expect((await call(t.env, 'DELETE', `/api/reviews/${id}/exceptions/${rec.id}`, undefined, { 'x-visitor-id': VISITOR })).status).toBe(404)
  })
  it('rejects catch-all globs, unknown rules, bad reasons', async () => {
    const id = await startSample()
    expect((await add(id, { ...good, pathGlob: '**' })).status).toBe(400)
    expect((await add(id, { ...good, pathGlob: '*' })).status).toBe(400)
    expect((await add(id, { ...good, pathGlob: '**/?*' })).status).toBe(400)
    expect((await add(id, { ...good, ruleId: 'STD-999' })).status).toBe(400)
    expect((await add(id, { ...good, reason: 'no' })).status).toBe(400)
    expect((await add(id, { ...good, reason: 'x'.repeat(501) })).status).toBe(400)
    expect((await add(id, 'nope')).status).toBe(400)
  })
  it('need a visitor id and only the owner may change them (samples)', async () => {
    const id = await startSample()
    expect((await add(id, good, {})).status).toBe(400)
    expect((await add(id, good, { 'x-visitor-id': 'not-a-uuid' })).status).toBe(400)
    expect((await add(id, good, { 'x-visitor-id': OTHER })).status).toBe(403)
    const shared = (await (await post(t.env, { sampleId: 'clean-change' })).json()) as any
    expect((await add(shared.reviewId, good, {})).status).toBe(400)
  })
  it('real-repo reviews are visitor-scoped too: no writes without an id, none across visitors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) =>
        (init!.headers as Record<string, string>).Accept.includes('diff') ? new Response(SAMPLES[3].diff) : new Response(JSON.stringify({ title: 'T', changed_files: 2, base: { repo: { private: false } } })),
      ),
    )
    try {
      const mine = (await (await post(t.env, { prUrl: 'https://github.com/o/r/pull/1' }, { 'x-visitor-id': VISITOR })).json()) as any
      const anon = (await (await post(t.env, { prUrl: 'https://github.com/o/r/pull/2' })).json()) as any
      expect((await add(mine.reviewId, good)).status).toBe(201)
      expect((await add(mine.reviewId, good, { 'x-visitor-id': OTHER })).status).toBe(403)
      expect((await add(mine.reviewId, good, {})).status).toBe(400)
      expect((await add(anon.reviewId, good)).status).toBe(403)
      expect((await add(anon.reviewId, good, {})).status).toBe(400)
      const ex = (await (await call(t.env, 'GET', `/api/reviews/${mine.reviewId}/exceptions`)).json()) as any[]
      expect(await (await call(t.env, 'GET', `/api/reviews/${anon.reviewId}/exceptions`)).json()).toEqual([])
      const del = await call(t.env, 'DELETE', `/api/reviews/${mine.reviewId}/exceptions/${ex[0].id}`, undefined, { 'x-visitor-id': OTHER })
      expect(del.status).toBe(403)
      expect(await t.mem(`o/r#${VISITOR}`).listExceptions()).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('409 at the per-repo limit, 404 for unknown review, 429 when limited', async () => {
    const id = await startSample()
    for (let i = 0; i < 25; i++) expect((await add(id, good)).status).toBe(201)
    expect((await add(id, good)).status).toBe(409)
    expect((await add('nope', good)).status).toBe(404)
    t.env.CHAT_LIMITER.limit = vi.fn(async () => ({ success: false }))
    expect((await add(id, good)).status).toBe(429)
  })
  it('DELETE goes through the chat limiter', async () => {
    const id = await startSample()
    const rec = (await (await add(id, good)).json()) as any
    t.env.CHAT_LIMITER.limit = vi.fn(async () => ({ success: false }))
    const r = await call(t.env, 'DELETE', `/api/reviews/${id}/exceptions/${rec.id}`, undefined, { 'x-visitor-id': VISITOR })
    expect(r.status).toBe(429)
    expect(await t.mem(SAMPLE_KEY(VISITOR)).listExceptions()).toHaveLength(1)
  })
  it('never calls the AI, and storage errors are a 503 without internals', async () => {
    const id = await startSample()
    expect(t.env.AI.run).not.toHaveBeenCalled()
    t.mem(SAMPLE_KEY(VISITOR)).addException = vi.fn(async () => {
      throw new Error('sqlite exploded at /internal/path')
    })
    const r = await add(id, good)
    expect(r.status).toBe(503)
    expect(JSON.stringify(await r.json())).not.toContain('sqlite')
  })
})
