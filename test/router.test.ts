import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../src/router'
import { SAMPLES } from '../src/samples'
import type { ChatTurn, ExceptionRecord, ReviewResult } from '../src/types'

const VISITOR = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

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
    if (!mems.has(key)) {
      const m = {
        exceptions: [] as ExceptionRecord[],
        reviews: new Map<string, ReviewResult>(),
        chat: [] as ChatTurn[],
        listExceptions: async () => m.exceptions,
        addException: vi.fn(async (i: any) => {
          if (m.exceptions.length >= 25) throw new Error('limit')
          const rec = { id: 'ex' + m.exceptions.length, createdAt: 't', ...i }
          m.exceptions.push(rec)
          return rec
        }),
        removeException: async (id: string) => {
          const n = m.exceptions.length
          m.exceptions = m.exceptions.filter((e) => e.id !== id)
          return m.exceptions.length < n
        },
        saveReview: async (r: ReviewResult) => void m.reviews.set(r.id, r),
        getReview: async (id: string) => m.reviews.get(id) ?? null,
        appendChat: async (_id: string, t: ChatTurn[]) => void m.chat.push(...t),
        getChat: async (_id: string, n: number) => m.chat.slice(-n),
      }
      mems.set(key, m)
    }
    return mems.get(key)
  }
  const create = vi.fn(async (_o: any) => ({ id: 'x' }))
  const wfStatus = { status: 'running' as string, output: undefined as unknown }
  const env: any = {
    CACHE: kv,
    REVIEW_WORKFLOW: { create, get: vi.fn(async () => ({ status: async () => wfStatus })) },
    REPO_MEMORY: { idFromName: (n: string) => n, get: (n: string) => mem(n) },
    AI: { run: vi.fn(async () => ({ response: 'Here is how to fix it.' })) },
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    REVIEW_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CHAT_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    DAILY_LLM_REVIEWS: '12',
    EVAL_KEY: 'secret-eval-key',
    ...over,
  }
  return { env, kv, create, mem, wfStatus }
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
  it('missing limiter binding means allow', async () => {
    const t2 = makeEnv({ REVIEW_LIMITER: undefined })
    expect((await post(t2.env, { sampleId: 'leaky-config' })).status).toBe(202)
  })
})

describe('POST /api/reviews samples', () => {
  it('starts a workflow scoped to the visitor and records indexes', async () => {
    const r = await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })
    expect(r.status).toBe(202)
    const body = (await r.json()) as any
    expect(body).toMatchObject({ repo: 'demo/sample-service', mode: 'full' })
    expect(t.create).toHaveBeenCalledTimes(1)
    const arg = t.create.mock.calls[0][0]
    expect(arg.id).toBe(body.reviewId)
    expect(arg.params).toMatchObject({ memoryKey: `demo/sample-service#${VISITOR}`, repo: 'demo/sample-service', mode: 'full', prNumber: null })
    expect(JSON.parse(t.kv.store.get(`rid:${body.reviewId}`)!)).toEqual({ repo: 'demo/sample-service', memoryKey: `demo/sample-service#${VISITOR}` })
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
    await t.mem(`demo/sample-service#${VISITOR}`).saveReview({ id: a.reviewId } as ReviewResult)
    const b = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(b.reviewId).not.toBe(a.reviewId)
  })
  it('goes static-only once the daily budget is spent, and counts full runs', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })
    expect(t.kv.store.get(`budget:${day}`)).toBe('1')
    t.kv.store.set(`budget:${day}`, '12')
    const r = (await (await post(t.env, { sampleId: 'swallowed-errors' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(r.mode).toBe('static-only')
    expect(t.kv.store.get(`budget:${day}`)).toBe('12')
  })
  it('a cached diff stays full-mode even when the budget is spent', async () => {
    const { cacheKey } = await import('../src/review')
    t.kv.store.set(await cacheKey(SAMPLES[0].diff), '{}')
    t.kv.store.set(`budget:${new Date().toISOString().slice(0, 10)}`, '12')
    const r = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': VISITOR })).json()) as any
    expect(r.mode).toBe('full')
  })
  it('without a visitor id uses the shared read-only key', async () => {
    await post(t.env, { sampleId: 'clean-change' })
    expect(t.create.mock.calls[0][0].params.memoryKey).toBe('demo/sample-service')
  })
})

describe('POST /api/reviews with a PR url', () => {
  it('fetches the diff server-side and keys memory by lowercased repo', async () => {
    const diff = SAMPLES[3].diff
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      const accept = (init!.headers as Record<string, string>).Accept
      return accept.includes('diff')
        ? new Response(diff)
        : new Response(JSON.stringify({ title: 'My PR', changed_files: 2 }))
    })
    vi.stubGlobal('fetch', f)
    try {
      const r = await post(t.env, { prUrl: 'https://github.com/Foo/Bar/pull/9' })
      expect(r.status).toBe(202)
      expect(t.create.mock.calls[0][0].params).toMatchObject({ repo: 'foo/bar', memoryKey: 'foo/bar', prNumber: 9, title: 'My PR' })
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
  it('skips the limiter, does not spend budget, honours evalMode', async () => {
    t.env.REVIEW_LIMITER.limit = vi.fn(async () => ({ success: false }))
    const day = new Date().toISOString().slice(0, 10)
    const r = await post(t.env, body, { 'x-eval-key': 'secret-eval-key' })
    expect(r.status).toBe(202)
    expect(((await r.json()) as any)).toMatchObject({ repo: 'eval/case-1', mode: 'full' })
    expect(t.kv.store.has(`budget:${day}`)).toBe(false)
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

async function startSample(visitor = VISITOR) {
  const r = (await (await post(t.env, { sampleId: 'leaky-config' }, { 'x-visitor-id': visitor })).json()) as any
  return r.reviewId as string
}
const result = (id: string): ReviewResult => ({
  id, repo: 'demo/sample-service', prNumber: null, title: 'leaky-config', mode: 'full',
  findings: [{ ruleId: 'STD-001', path: 'src/config.ts', line: 3, message: 'secret', suggestion: 's', source: 'static' }],
  suppressed: [], filesReviewed: 1, skippedFiles: [], degradedFiles: [], truncated: false, rulesVersion: '2026.11.1', cached: false, createdAt: 't',
})

describe('GET /api/reviews/:id', () => {
  it('400 for a bad id, 404 for an unknown one', async () => {
    expect((await call(t.env, 'GET', '/api/reviews/..%2F')).status).toBe(400)
    expect((await call(t.env, 'GET', '/api/reviews/' + 'a'.repeat(101))).status).toBe(400)
    expect((await call(t.env, 'GET', '/api/reviews/unknown-id')).status).toBe(404)
  })
  it('running, then complete from the DO, even if the workflow is gone', async () => {
    const id = await startSample()
    expect(await (await call(t.env, 'GET', `/api/reviews/${id}`)).json()).toEqual({ status: 'running' })
    await t.mem(`demo/sample-service#${VISITOR}`).saveReview(result(id))
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
  it('409 while the review is running, 400 for bad messages, 404 for unknown id', async () => {
    const id = await startSample()
    expect((await call(t.env, 'POST', `/api/reviews/${id}/chat`, { message: 'hi' })).status).toBe(409)
    expect((await call(t.env, 'POST', `/api/reviews/${id}/chat`, { message: '  ' })).status).toBe(400)
    expect((await call(t.env, 'POST', `/api/reviews/${id}/chat`, { message: 'x'.repeat(2001) })).status).toBe(400)
    expect((await call(t.env, 'POST', `/api/reviews/${id}/chat`, 'nope')).status).toBe(400)
    expect((await call(t.env, 'POST', `/api/reviews/zzz/chat`, { message: 'hi' })).status).toBe(404)
  })
  it('429 when limited', async () => {
    const id = await startSample()
    t.env.CHAT_LIMITER.limit = vi.fn(async () => ({ success: false }))
    expect((await call(t.env, 'POST', `/api/reviews/${id}/chat`, { message: 'hi' })).status).toBe(429)
  })
  it('replies and stores both turns once complete', async () => {
    const id = await startSample()
    await t.mem(`demo/sample-service#${VISITOR}`).saveReview(result(id))
    const r = await call(t.env, 'POST', `/api/reviews/${id}/chat`, { message: 'How do I fix STD-001?' })
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
    await t.mem(`demo/sample-service#${VISITOR}`).saveReview(result(id))
    t.env.AI.run = vi.fn(async () => {
      throw new Error('boom internal detail')
    })
    const r = await call(t.env, 'POST', `/api/reviews/${id}/chat`, { message: 'hello' })
    expect(r.status).toBe(200)
    const text = JSON.stringify(await r.json())
    expect(text).not.toContain('boom')
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
    const list = (await (await call(t.env, 'GET', `/api/reviews/${id}/exceptions`, undefined, { 'x-visitor-id': VISITOR })).json()) as any[]
    expect(list).toHaveLength(1)
    expect((await call(t.env, 'DELETE', `/api/reviews/${id}/exceptions/${rec.id}`, undefined, { 'x-visitor-id': VISITOR })).status).toBe(204)
    expect((await call(t.env, 'DELETE', `/api/reviews/${id}/exceptions/${rec.id}`, undefined, { 'x-visitor-id': VISITOR })).status).toBe(404)
  })
  it('rejects catch-all globs, unknown rules, bad reasons', async () => {
    const id = await startSample()
    expect((await add(id, { ...good, pathGlob: '**' })).status).toBe(400)
    expect((await add(id, { ...good, pathGlob: '*' })).status).toBe(400)
    expect((await add(id, { ...good, ruleId: 'STD-999' })).status).toBe(400)
    expect((await add(id, { ...good, reason: 'no' })).status).toBe(400)
    expect((await add(id, { ...good, reason: 'x'.repeat(501) })).status).toBe(400)
    expect((await add(id, 'nope')).status).toBe(400)
  })
  it('sample reviews need a visitor id and only that visitor may change them', async () => {
    const id = await startSample()
    expect((await add(id, good, {})).status).toBe(400)
    expect((await add(id, good, { 'x-visitor-id': 'not-a-uuid' })).status).toBe(400)
    expect((await add(id, good, { 'x-visitor-id': OTHER })).status).toBe(403)
    const shared = (await (await post(t.env, { sampleId: 'clean-change' })).json()) as any
    expect((await add(shared.reviewId, good, {})).status).toBe(400)
  })
  it('409 at the per-repo limit, 404 for unknown review, 429 when limited', async () => {
    const id = await startSample()
    for (let i = 0; i < 25; i++) expect((await add(id, good)).status).toBe(201)
    expect((await add(id, good)).status).toBe(409)
    expect((await add('nope', good)).status).toBe(404)
    t.env.CHAT_LIMITER.limit = vi.fn(async () => ({ success: false }))
    expect((await add(id, good)).status).toBe(429)
  })
  it('does not call the AI for exception writes and never leaks internal errors', async () => {
    const id = await startSample()
    expect(t.env.AI.run).not.toHaveBeenCalled()
    t.mem(`demo/sample-service#${VISITOR}`).addException = vi.fn(async () => {
      throw new Error('sqlite exploded at /internal/path')
    })
    const r = await add(id, good)
    expect(r.status).toBe(500)
    expect(JSON.stringify(await r.json())).not.toContain('sqlite')
  })
})
