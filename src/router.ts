import type { ChatTurn, Env, ExceptionRecord, ReviewMode, ReviewParams, ReviewResult } from './types'
import { RULES, ruleById } from './rules'
import { SAMPLES } from './samples'
import { HttpError, fetchPrDiff, parsePrUrl } from './github'
import { cacheKey, validateGlob } from './review'
import { CHAT_FALLBACK, answerChat, relevantCode } from './chat'

const MAX_DIFF_BYTES = 100 * 1024
const MONTH = 30 * 24 * 60 * 60
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPO_RE = /^[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/
const SAMPLE_REPO = 'demo/sample-service'
const FAILED_MSG = 'The review could not be completed. Please try again.'
const GENERIC_500 = 'Something went wrong. Please try again.'

interface MemoryStub {
  listExceptions(): Promise<ExceptionRecord[]>
  addException(i: { ruleId: string; pathGlob: string; reason: string }): Promise<ExceptionRecord>
  removeException(id: string): Promise<boolean>
  getReview(id: string): Promise<ReviewResult | null>
  appendChat(id: string, t: ChatTurn[]): Promise<void>
  getChat(id: string, n: number): Promise<ChatTurn[]>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const err = (status: number, message: string) => json({ error: message }, status)

const memoryFor = (env: Env, key: string) => env.REPO_MEMORY.get(env.REPO_MEMORY.idFromName(key)) as unknown as MemoryStub

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

async function limited(limiter: RateLimit | undefined, req: Request): Promise<boolean> {
  if (!limiter) return false
  try {
    const { success } = await limiter.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' })
    return !success
  } catch {
    return false
  }
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json()
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const visitorId = (req: Request): string | null => {
  const v = req.headers.get('x-visitor-id')
  return v && UUID_RE.test(v) ? v.toLowerCase() : null
}

async function createReview(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  if (!body) return err(400, 'Send a JSON body like {"prUrl": "https://github.com/owner/repo/pull/123"}')

  let repo: string
  let memoryKey: string
  let title: string
  let prNumber: number | null = null
  let diff: string
  let isEval = false
  let forceStaticOnly = false

  if (body.evalDiff !== undefined) {
    const key = req.headers.get('x-eval-key') ?? ''
    if (!env.EVAL_KEY || !(await safeEqual(key, env.EVAL_KEY))) return err(401, 'Unauthorized')
    if (typeof body.evalDiff !== 'string' || typeof body.repo !== 'string') return err(400, 'evalDiff and repo must be strings')
    repo = body.repo.toLowerCase()
    if (!REPO_RE.test(repo)) return err(400, 'repo must look like owner/name')
    if (new TextEncoder().encode(body.evalDiff).length > MAX_DIFF_BYTES) return err(413, 'Diff is too large')
    diff = body.evalDiff
    memoryKey = repo
    title = `eval ${repo}`
    isEval = true
    forceStaticOnly = body.evalMode === 'static-only'
  } else if (typeof body.sampleId === 'string') {
    const sample = SAMPLES.find((s) => s.id === body.sampleId)
    if (!sample) return err(400, 'Unknown sample')
    if (await limited(env.REVIEW_LIMITER, req)) return err(429, 'Too many reviews — wait a minute and try again')
    const vid = visitorId(req)
    repo = SAMPLE_REPO
    memoryKey = vid ? `${SAMPLE_REPO}#${vid}` : SAMPLE_REPO
    title = sample.title
    diff = sample.diff
  } else if (typeof body.prUrl === 'string') {
    const p = parsePrUrl(body.prUrl)
    if ('error' in p) return err(400, p.error)
    if (await limited(env.REVIEW_LIMITER, req)) return err(429, 'Too many reviews — wait a minute and try again')
    try {
      const pr = await fetchPrDiff(body.prUrl, env.GITHUB_TOKEN)
      repo = pr.repo
      memoryKey = pr.repo
      title = pr.title
      prNumber = pr.prNumber
      diff = pr.diff
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.message)
      return err(502, 'GitHub is unavailable right now — try again or use a sample PR')
    }
  } else {
    return err(400, 'Provide a prUrl or a sampleId')
  }

  const ck = await cacheKey(diff)
  const inflightKey = `inflight:${ck}:${memoryKey}`

  const existing = (await env.CACHE.get(inflightKey, 'json')) as { reviewId: string; mode: ReviewMode } | null
  if (existing) {
    let finished = false
    try {
      finished = (await memoryFor(env, memoryKey).getReview(existing.reviewId)) !== null
    } catch {
      /* treat as still running */
    }
    if (!finished) return json({ reviewId: existing.reviewId, repo, mode: existing.mode }, 202)
  }

  // Mode: eval honours evalMode and never touches the budget; a cached diff is free; otherwise the daily cap applies.
  let mode: ReviewMode = 'full'
  const day = new Date().toISOString().slice(0, 10)
  const budgetKey = `budget:${day}`
  let spend = false
  if (forceStaticOnly) mode = 'static-only'
  else if (!isEval) {
    const hit = await env.CACHE.get(ck)
    if (hit === null) {
      const used = parseInt((await env.CACHE.get(budgetKey)) ?? '0', 10) || 0
      const cap = parseInt(env.DAILY_LLM_REVIEWS ?? '12', 10)
      if (used >= (Number.isFinite(cap) ? cap : 12)) mode = 'static-only'
      else spend = true
    }
  }

  const reviewId = crypto.randomUUID()
  const params: ReviewParams = { reviewId, repo, memoryKey, prNumber, title, diff, mode }
  try {
    await env.CACHE.put(`rid:${reviewId}`, JSON.stringify({ repo, memoryKey }), { expirationTtl: MONTH })
    await env.CACHE.put(`diff:${reviewId}`, diff, { expirationTtl: MONTH })
    await env.REVIEW_WORKFLOW.create({ id: reviewId, params })
    await env.CACHE.put(inflightKey, JSON.stringify({ reviewId, mode }), { expirationTtl: 60 })
    if (spend) {
      const used = parseInt((await env.CACHE.get(budgetKey)) ?? '0', 10) || 0
      await env.CACHE.put(budgetKey, String(used + 1), { expirationTtl: 2 * 24 * 60 * 60 })
    }
  } catch {
    return err(500, GENERIC_500)
  }
  return json({ reviewId, repo, mode }, 202)
}

async function getReview(env: Env, id: string, memoryKey: string): Promise<Response> {
  const done = await memoryFor(env, memoryKey).getReview(id)
  if (done) return json({ status: 'complete', result: done })
  try {
    const st = (await (await env.REVIEW_WORKFLOW.get(id)).status()) as { status: string; output?: unknown }
    if (st.status === 'complete' && st.output && typeof st.output === 'object') {
      return json({ status: 'complete', result: st.output })
    }
    if (['errored', 'terminated', 'unknown'].includes(st.status)) return json({ status: 'failed', error: FAILED_MSG })
    return json({ status: 'running' })
  } catch {
    return json({ status: 'failed', error: FAILED_MSG })
  }
}

/** Sample memory is per visitor: only the owner may change it, and the shared read-only key is never writable. */
function checkSampleOwnership(req: Request, memoryKey: string): Response | null {
  if (!memoryKey.startsWith(SAMPLE_REPO)) return null
  const vid = visitorId(req)
  if (!vid) return err(400, 'A valid visitor id is required to change exceptions on the sample repo')
  if (memoryKey !== `${SAMPLE_REPO}#${vid}`) return err(403, 'This sample review belongs to another visitor')
  return null
}

async function reviewRoute(req: Request, env: Env, id: string, sub: string | undefined, exId: string | undefined): Promise<Response> {
  if (!ID_RE.test(id)) return err(400, 'Invalid review id')
  const idx = (await env.CACHE.get(`rid:${id}`, 'json')) as { repo: string; memoryKey: string } | null
  if (!idx) return err(404, 'Review not found')
  const memory = memoryFor(env, idx.memoryKey)

  if (!sub) {
    if (req.method !== 'GET') return err(404, 'Not found')
    return getReview(env, id, idx.memoryKey)
  }

  if (sub === 'chat') {
    if (req.method !== 'POST') return err(404, 'Not found')
    const body = await readJson(req)
    const msg = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!msg) return err(400, 'Write a question first')
    if (msg.length > 2000) return err(400, 'Messages are limited to 2,000 characters')
    if (await limited(env.CHAT_LIMITER, req)) return err(429, 'Too many messages — wait a minute and try again')
    const review = await memory.getReview(id)
    if (!review) return err(409, 'The review is not finished yet')
    const history = await memory.getChat(id, 10)
    const diff = (await env.CACHE.get(`diff:${id}`)) ?? ''
    const reply = await answerChat(env.AI, review, history, msg, relevantCode(review, diff))
    const at = new Date().toISOString()
    await memory.appendChat(id, [
      { role: 'user', content: msg, at },
      { role: 'assistant', content: reply || CHAT_FALLBACK, at },
    ])
    return json({ reply, history: await memory.getChat(id, 20) })
  }

  if (sub === 'exceptions') {
    if (!exId && req.method === 'GET') return json(await memory.listExceptions())
    if (!exId && req.method === 'POST') {
      const own = checkSampleOwnership(req, idx.memoryKey)
      if (own) return own
      const body = await readJson(req)
      if (!body) return err(400, 'Send a JSON body with ruleId, pathGlob and reason')
      const { ruleId, pathGlob, reason } = body
      if (typeof ruleId !== 'string' || !ruleById(ruleId)) return err(400, 'Unknown rule')
      if (typeof pathGlob !== 'string') return err(400, 'Path glob is required.')
      const globErr = validateGlob(pathGlob)
      if (globErr) return err(400, globErr)
      const why = typeof reason === 'string' ? reason.trim() : ''
      if (why.length < 3 || why.length > 500) return err(400, 'Reason must be 3 to 500 characters')
      if (await limited(env.CHAT_LIMITER, req)) return err(429, 'Too many requests — wait a minute and try again')
      try {
        return json(await memory.addException({ ruleId, pathGlob: pathGlob.trim(), reason: why }), 201)
      } catch (e) {
        if (e instanceof Error && e.message === 'limit') return err(409, 'This repo already has the maximum of 25 exceptions')
        throw e
      }
    }
    if (exId && req.method === 'DELETE') {
      const own = checkSampleOwnership(req, idx.memoryKey)
      if (own) return own
      return (await memory.removeException(exId)) ? new Response(null, { status: 204 }) : err(404, 'Exception not found')
    }
  }
  return err(404, 'Not found')
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req)
  try {
    if (path === '/api/health' && req.method === 'GET') return json({ ok: true, githubToken: Boolean(env.GITHUB_TOKEN) })
    if (path === '/api/rules' && req.method === 'GET') return json(RULES)
    if (path === '/api/samples' && req.method === 'GET') {
      return json(SAMPLES.map(({ id, title, description }) => ({ id, title, description })))
    }
    if (path === '/api/reviews' && req.method === 'POST') return await createReview(req, env)
    const m = path.match(/^\/api\/reviews\/([^/]+)(?:\/(chat|exceptions)(?:\/([^/]+))?)?$/)
    if (m) {
      let id: string
      let exId: string | undefined
      try {
        id = decodeURIComponent(m[1])
        exId = m[3] ? decodeURIComponent(m[3]) : undefined
      } catch {
        return err(400, 'Invalid review id')
      }
      return await reviewRoute(req, env, id, m[2], exId)
    }
    return err(404, 'Not found')
  } catch {
    return err(500, GENERIC_500)
  }
}
