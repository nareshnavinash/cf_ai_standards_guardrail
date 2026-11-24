import type { ChatTurn, Env, ExceptionRecord, ReviewMode, ReviewParams, ReviewResult } from './types'
import { RULES, ruleById } from './rules'
import { SAMPLES } from './samples'
import { HttpError, fetchPrDiff, parsePrUrl } from './github'
import { cacheKey, readCachedReview, validateGlob } from './review'
import { CHAT_FALLBACK, answerChat, relevantCode } from './chat'

const MAX_DIFF_BYTES = 100 * 1024
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPO_RE = /^[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/
const SAMPLE_REPO = 'demo/sample-service'
const CHAT_TURNS_PER_REVIEW = 10
const FAILED_MSG = 'The review could not be completed. Please try again.'
const GENERIC_500 = 'Something went wrong. Please try again.'
const BUSY_MSG = 'Service is busy, try again later'

interface MemoryStub {
  listExceptions(): Promise<ExceptionRecord[]>
  addException(i: { ruleId: string; pathGlob: string; reason: string }): Promise<ExceptionRecord>
  removeException(id: string): Promise<boolean>
  getReview(id: string): Promise<ReviewResult | null>
  appendChat(id: string, t: ChatTurn[]): Promise<void>
  getChat(id: string, n: number): Promise<ChatTurn[]>
}
interface ControlStub {
  registerReview(id: string, repo: string, memoryKey: string, visitor: string, diff: string): Promise<void>
  getReviewIndex(id: string): Promise<{ repo: string; memoryKey: string; visitor: string } | null>
  getDiff(id: string): Promise<string | null>
  getInflight(key: string): Promise<{ reviewId: string; mode: ReviewMode } | null>
  setInflight(key: string, reviewId: string, mode: ReviewMode): Promise<void>
  reserveReview(day: string, cap: number): Promise<boolean>
  reserveChat(reviewId: string, day: string, dailyCap: number, perReviewCap: number): Promise<'ok' | 'daily' | 'review'>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const err = (status: number, message: string) => json({ error: message }, status)
const busy = () => err(503, BUSY_MSG)

const memoryFor = (env: Env, key: string) => env.REPO_MEMORY.get(env.REPO_MEMORY.idFromName(key)) as unknown as MemoryStub
const controlFor = (env: Env) => env.CONTROL.get(env.CONTROL.idFromName('global')) as unknown as ControlStub
const today = () => new Date().toISOString().slice(0, 10)
const intVar = (v: string | undefined, d: number) => {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

/** True when the request must be rejected. A missing binding allows (local tests); a throwing binding fails closed. */
async function limited(limiter: RateLimit | undefined, req: Request): Promise<boolean> {
  if (!limiter) return false
  try {
    const { success } = await limiter.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' })
    return !success
  } catch {
    return true
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
  let visitor: string
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
    visitor = 'eval'
    memoryKey = `${repo}#eval`
    title = `eval ${repo}`
    isEval = true
    forceStaticOnly = body.evalMode === 'static-only'
  } else if (typeof body.sampleId === 'string') {
    const sample = SAMPLES.find((s) => s.id === body.sampleId)
    if (!sample) return err(400, 'Unknown sample')
    if (await limited(env.REVIEW_LIMITER, req)) return err(429, 'Too many reviews — wait a minute and try again')
    visitor = visitorId(req) ?? 'anon'
    repo = SAMPLE_REPO
    memoryKey = `sample:${SAMPLE_REPO}#${visitor}`
    title = sample.title
    diff = sample.diff
  } else if (typeof body.prUrl === 'string') {
    const p = parsePrUrl(body.prUrl)
    if ('error' in p) return err(400, p.error)
    if (await limited(env.REVIEW_LIMITER, req)) return err(429, 'Too many reviews — wait a minute and try again')
    try {
      const pr = await fetchPrDiff(body.prUrl, env.GITHUB_TOKEN)
      repo = pr.repo
      title = pr.title
      prNumber = pr.prNumber
      diff = pr.diff
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.message)
      return err(502, 'GitHub is unavailable right now — try again or use a sample PR')
    }
    visitor = visitorId(req) ?? 'anon'
    memoryKey = `${repo}#${visitor}`
  } else {
    return err(400, 'Provide a prUrl or a sampleId')
  }

  try {
    const control = controlFor(env)
    const ck = await cacheKey(diff)
    const inflightKey = `${ck}:${memoryKey}`

    const existing = await control.getInflight(inflightKey)
    if (existing) {
      let finished = false
      try {
        finished = (await memoryFor(env, memoryKey).getReview(existing.reviewId)) !== null
      } catch {
        /* treat as still running */
      }
      if (!finished) return json({ reviewId: existing.reviewId, repo, mode: existing.mode }, 202)
    }

    // Mode: eval honours evalMode and never touches the budget; a cached diff is free; otherwise reserve atomically.
    let mode: ReviewMode = 'full'
    if (forceStaticOnly) mode = 'static-only'
    else if (!isEval && (await readCachedReview(env.CACHE, ck)) === null) {
      if (!(await control.reserveReview(today(), intVar(env.DAILY_LLM_REVIEWS, 12)))) mode = 'static-only'
    }

    const reviewId = crypto.randomUUID()
    const params: ReviewParams = { reviewId, repo, memoryKey, prNumber, title, diff, mode }
    await control.registerReview(reviewId, repo, memoryKey, visitor, diff)
    await control.setInflight(inflightKey, reviewId, mode)
    await env.REVIEW_WORKFLOW.create({ id: reviewId, params })
    return json({ reviewId, repo, mode }, 202)
  } catch {
    return busy()
  }
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

/** Memory is scoped to (repo, visitor). Only the owning visitor may change it; anonymous reviews are read-only. */
function checkOwnership(req: Request, owner: string): Response | null {
  const vid = visitorId(req)
  if (!vid) return err(400, 'A valid visitor id is required to change exceptions')
  if (owner !== vid) return err(403, 'This review belongs to another visitor')
  return null
}

async function reviewRoute(req: Request, env: Env, id: string, sub: string | undefined, exId: string | undefined): Promise<Response> {
  if (!ID_RE.test(id)) return err(400, 'Invalid review id')
  const control = controlFor(env)
  const idx = await control.getReviewIndex(id)
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
    if (review.mode === 'static-only') return err(409, 'Chat is unavailable for static-only reviews (the daily AI budget was used up when this ran)')
    const slot = await control.reserveChat(id, today(), intVar(env.DAILY_CHAT_TURNS, 60), CHAT_TURNS_PER_REVIEW)
    if (slot === 'daily') return err(429, 'Daily AI budget used — chat resumes tomorrow')
    if (slot === 'review') return err(429, `Chat limit reached for this review (${CHAT_TURNS_PER_REVIEW} questions)`)
    const history = await memory.getChat(id, 10)
    const diff = (await control.getDiff(id)) ?? ''
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
      const own = checkOwnership(req, idx.visitor)
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
        return busy()
      }
    }
    if (exId && req.method === 'DELETE') {
      const own = checkOwnership(req, idx.visitor)
      if (own) return own
      if (await limited(env.CHAT_LIMITER, req)) return err(429, 'Too many requests — wait a minute and try again')
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
