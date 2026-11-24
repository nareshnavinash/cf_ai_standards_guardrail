import type { ChatTurn, Env, ExceptionRecord, ReviewMode, ReviewParams, ReviewResult } from './types'
import { RULES, ruleById } from './rules'
import { SAMPLES } from './samples'
import { HttpError, fetchPrDiff, parsePrUrl } from './github'
import { cacheKey, readCachedReview, validateGlob } from './review'
import { CHAT_FALLBACK, answerChat, relevantCode } from './chat'
import { DEFAULT_NEURON_BUDGET, LlmBudgetError } from './budget'
import type { ClaimArgs, ClaimResult, ReserveChatArgs } from './control-store'

const MAX_DIFF_BYTES = 100 * 1024
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPO_RE = /^[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/
const SAMPLE_REPO = 'demo/sample-service'
const CHAT_TURNS_PER_REVIEW = 10
const FAILED_MSG = 'The review could not be completed. Please try again.'
const BUDGET_NOTICE = 'Daily AI budget used — AI resumes tomorrow (UTC). This review ran static-only.'
const EXPIRED_MSG = 'This review has expired. Run it again.'
const BUDGET_MSG = 'Daily AI budget used — AI resumes tomorrow (UTC)'
const IP_REVIEW_NOTICE = "You've used today's AI reviews for your network, so this one ran static-only. AI reviews resume tomorrow (UTC)."
const GRACE_MS = 90 * 1000 // a fresh claim may not have reached REVIEW_WORKFLOW.create yet
const IP_SALT = 'standards-guardrail-ip-v1'
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
  claimReview(a: ClaimArgs): Promise<ClaimResult>
  releaseReview(reviewId: string, refund: boolean): Promise<void>
  clearInflight(reviewId: string): Promise<void>
  getReviewIndex(id: string): Promise<{ repo: string; memoryKey: string; visitor: string; createdAt: number } | null>
  getDiff(id: string): Promise<string | null>
  recordUsage(key: string, day: string, neurons: number): Promise<void>
  reserveNeurons(day: string, key: string, amount: number, budget: number): Promise<boolean>
  settleNeurons(key: string, actual: number): Promise<void>
  reserveChat(a: ReserveChatArgs): Promise<'ok' | 'daily' | 'review' | 'ip' | 'budget'>
  refundChat(a: { reviewId: string; day: string; ip: string | null }): Promise<void>
}

/** A Durable Object / Workflow / storage call failed. These (and only these) become a 503. */
class InfraError extends Error {
  constructor(public cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}
async function infra<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof InfraError ? e : new InfraError(e)
  }
}
/** Wraps every method of a DO stub so a rejection becomes an InfraError. */
function guard<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(target, prop) {
      const v = (target as any)[prop]
      if (typeof v !== 'function') return v
      return (...a: unknown[]) => infra(async () => (target as any)[prop](...a))
    },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
type ErrCode = 'static_only' | 'not_finished' | 'budget' | 'ip_limit' | 'review_limit' | 'expired'
const err = (status: number, message: string, code?: ErrCode) => json(code ? { error: message, code } : { error: message }, status)
const isNotFound = (e: unknown) => /not[ ._-]?found/i.test(e instanceof Error ? e.message : String(e))
const busy = () => err(503, BUSY_MSG)

const memoryFor = (env: Env, key: string) => guard(env.REPO_MEMORY.get(env.REPO_MEMORY.idFromName(key)) as unknown as MemoryStub)
const controlFor = (env: Env) => guard(env.CONTROL.get(env.CONTROL.idFromName('global')) as unknown as ControlStub)
const today = () => new Date().toISOString().slice(0, 10)
const intVar = (v: string | undefined, d: number) => {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}
/** Salted sha256 of the client IP (never stored raw); null when unknown, which skips the per-IP limits. */
async function ipHash(req: Request): Promise<string | null> {
  const ip = req.headers.get('cf-connecting-ip')
  if (!ip) return null
  return [...(await sha256(`${IP_SALT}|${ip}`))].map((b) => b.toString(16).padStart(2, '0')).join('')
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

  const control = controlFor(env)
  const ck = await cacheKey(diff)
  const inflightKey = `${ck}:${memoryKey}`
  const day = today()
  const needsBudget = !forceStaticOnly && !isEval && (await readCachedReview(env.CACHE, ck)) === null
  const base = {
    inflightKey,
    repo,
    memoryKey,
    visitor,
    diff,
    day,
    cap: intVar(env.DAILY_LLM_REVIEWS, 10),
    neuronBudget: intVar(env.DAILY_NEURON_BUDGET, DEFAULT_NEURON_BUDGET),
    ip: isEval ? null : await ipHash(req),
    ipCap: intVar(env.IP_DAILY_REVIEWS, 4),
    ipTotalCap: intVar(env.IP_DAILY_REVIEWS_TOTAL, 30),
  }
  // Admitted on a cache hit without a slot: if the workflow later misses the cache it must not call the AI.
  const cacheOnly = !isEval && !forceStaticOnly && !needsBudget

  // One atomic claim. A marker whose workflow died is released (slot refunded) and claimed again.
  let reviewId = ''
  let mode: ReviewMode = 'full'
  let notice: string | undefined
  let noticeCode: 'budget' | 'ip_limit' | undefined
  for (let attempt = 0; ; attempt++) {
    if (attempt === 3) return busy()
    reviewId = crypto.randomUUID()
    let claim = await control.claimReview({ ...base, reviewId, needsBudget, forceStatic: forceStaticOnly })
    if (claim.kind === 'ip-limit') {
      notice = IP_REVIEW_NOTICE
      noticeCode = 'ip_limit'
      claim = await control.claimReview({ ...base, reviewId, needsBudget: false, forceStatic: true })
    }
    if (claim.kind === 'total-limit') return err(429, "You've reached today's review limit", 'ip_limit')
    if (claim.kind === 'claimed') {
      mode = claim.mode
      if (mode === 'static-only' && !forceStaticOnly && !notice && needsBudget) {
        notice = BUDGET_NOTICE
        noticeCode = 'budget'
      }
      break
    }
    if (claim.kind === 'existing') {
      if (await stillRunning(env, control, memoryKey, claim)) return json({ reviewId: claim.reviewId, repo, mode: claim.mode }, 202)
      notice = undefined
      noticeCode = undefined
      continue
    }
    return busy() // an ip-limit on the static-only retry cannot happen; fail safe
  }

  const params: ReviewParams = { reviewId, repo, memoryKey, prNumber, title, diff, mode, ...(cacheOnly ? { cacheOnly: true } : {}) }
  try {
    await infra(() => env.REVIEW_WORKFLOW.create({ id: reviewId, params }))
  } catch (e) {
    try {
      await control.releaseReview(reviewId, true) // free the marker and give the budget slot back
    } catch {
      // the marker expires on its own after 10 minutes
    }
    throw e
  }
  return json({ reviewId, repo, mode, ...(notice ? { notice, noticeCode } : {}) }, 202)
}

/**
 * True when an in-flight review is genuinely still running. The Workflow is always asked: an explicit errored/terminated status
 * releases the marker (slot refunded). A not-found releases it only past GRACE_MS (before that the create may still be in
 * flight, so the marker counts as alive); any other Workflow error is an InfraError (503) and releases nothing.
 */
async function stillRunning(env: Env, control: ControlStub, memoryKey: string, existing: { reviewId: string; ageMs: number }): Promise<boolean> {
  try {
    if ((await memoryFor(env, memoryKey).getReview(existing.reviewId)) !== null) {
      await control.clearInflight(existing.reviewId) // finished; keep its index so the link keeps working
      return false
    }
  } catch {
    /* fall through */
  }
  const young = existing.ageMs < GRACE_MS
  let status: string
  try {
    status = ((await (await env.REVIEW_WORKFLOW.get(existing.reviewId)).status()) as { status: string }).status
  } catch (e) {
    if (!isNotFound(e)) throw new InfraError(e)
    status = 'unknown'
  }
  // Inside the grace window the Workflow may simply not exist yet (create in flight): not-found means alive there,
  // but an explicit errored/terminated status is a fast failure and is released.
  const dead = young ? ['errored', 'terminated'].includes(status) : ['errored', 'terminated', 'unknown'].includes(status)
  if (dead) await control.releaseReview(existing.reviewId, true)
  return !dead
}

type ReviewState = { state: 'complete'; result: unknown } | { state: 'running' } | { state: 'failed' } | { state: 'expired' }

/** The review's state: from the memory DO first, then the Workflow. Indexed but in neither place means it was evicted. */
async function reviewState(env: Env, id: string, memory: MemoryStub, createdAt: number): Promise<ReviewState> {
  // A Workflow not-found for a review indexed under GRACE_MS ago is most likely create() still in flight, not an eviction.
  const gone = (): ReviewState => (Date.now() - createdAt < GRACE_MS ? { state: 'running' } : { state: 'expired' })
  const done = await memory.getReview(id)
  if (done) return { state: 'complete', result: done }
  let st: { status: string; output?: unknown }
  try {
    st = (await (await env.REVIEW_WORKFLOW.get(id)).status()) as { status: string; output?: unknown }
  } catch (e) {
    if (isNotFound(e)) return gone()
    throw new InfraError(e)
  }
  if (st.status === 'complete' && st.output && typeof st.output === 'object') return { state: 'complete', result: st.output }
  if (st.status === 'unknown') return gone()
  if (['errored', 'terminated'].includes(st.status)) return { state: 'failed' }
  return { state: 'running' }
}

async function getReview(env: Env, id: string, memoryKey: string, createdAt: number): Promise<Response> {
  const st = await reviewState(env, id, memoryFor(env, memoryKey), createdAt)
  if (st.state === 'complete') return json({ status: 'complete', result: st.result })
  if (st.state === 'expired') return err(410, EXPIRED_MSG, 'expired')
  if (st.state === 'failed') return json({ status: 'failed', error: FAILED_MSG })
  return json({ status: 'running' })
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
    return getReview(env, id, idx.memoryKey, idx.createdAt)
  }

  if (sub === 'chat') {
    if (req.method !== 'POST') return err(404, 'Not found')
    const body = await readJson(req)
    const msg = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!msg) return err(400, 'Write a question first')
    if (msg.length > 2000) return err(400, 'Messages are limited to 2,000 characters')
    if (await limited(env.CHAT_LIMITER, req)) return err(429, 'Too many messages — wait a minute and try again')
    const st = await reviewState(env, id, memory, idx.createdAt)
    if (st.state === 'expired') return err(410, EXPIRED_MSG, 'expired')
    if (st.state !== 'complete') return err(409, st.state === 'failed' ? FAILED_MSG : 'The review is not finished yet', 'not_finished')
    const review = st.result as ReviewResult
    if (review.mode === 'static-only') return err(409, 'Chat is unavailable for static-only reviews (the daily AI budget was used up when this ran)', 'static_only')
    const day = today()
    const ip = await ipHash(req)
    const slot = await control.reserveChat({
      reviewId: id,
      day,
      dailyCap: intVar(env.DAILY_CHAT_TURNS, 40),
      perReviewCap: CHAT_TURNS_PER_REVIEW,
      ip,
      ipCap: intVar(env.IP_DAILY_CHATS, 15),
      neuronBudget: intVar(env.DAILY_NEURON_BUDGET, DEFAULT_NEURON_BUDGET),
    })
    if (slot === 'daily' || slot === 'budget') return err(429, BUDGET_MSG, 'budget')
    if (slot === 'ip') return err(429, "You've reached today's chat limit", 'ip_limit')
    if (slot === 'review') return err(429, `Chat limit reached for this review (${CHAT_TURNS_PER_REVIEW} questions)`, 'review_limit')
    const refund = async () => {
      try {
        await control.refundChat({ reviewId: id, day, ip })
      } catch {
        // counters reset daily
      }
    }
    let history: ChatTurn[]
    let reply: string
    let neurons = 0
    const nKey = `chat:${crypto.randomUUID()}`
    const settle = async (actual: number) => {
      try {
        await control.settleNeurons(nKey, actual)
      } catch {
        // the (higher) reservation stays charged
      }
    }
    try {
      history = await memory.getChat(id, 10)
      const diff = (await control.getDiff(id)) ?? ''
      // Reserve the worst case before the call; settle to actual usage after.
      reply = await answerChat(
        env.AI,
        review,
        history,
        msg,
        relevantCode(review, diff),
        (n) => (neurons = n),
        (amount) => control.reserveNeurons(day, nKey, amount, intVar(env.DAILY_NEURON_BUDGET, DEFAULT_NEURON_BUDGET)),
      )
    } catch (e) {
      await refund()
      await settle(0)
      if (e instanceof LlmBudgetError) return err(429, BUDGET_MSG, 'budget')
      throw e
    }
    await settle(neurons)
    if (reply === CHAT_FALLBACK) await refund() // the AI failed: the visitor did not get an answer, so no slot is spent
    const at = new Date().toISOString()
    const turns: ChatTurn[] = [
      { role: 'user', content: msg, at },
      { role: 'assistant', content: reply, at },
    ]
    let full: ChatTurn[]
    try {
      // A failed reply is not part of the conversation: keep it (and the question it answers) out of the stored history.
      if (reply !== CHAT_FALLBACK) await memory.appendChat(id, turns)
      full = reply === CHAT_FALLBACK ? [...history, ...turns].slice(-20) : await memory.getChat(id, 20)
    } catch (e) {
      console.error('chat history save failed', e) // the AI reply was already paid for: still return it
      full = [...history, ...turns].slice(-20)
    }
    return json({ reply, history: full })
  }

  if (sub === 'exceptions') {
    if (!exId && req.method === 'GET') {
      if ((visitorId(req) ?? 'anon') !== idx.visitor) return err(403, 'This review belongs to another visitor')
      return json(await memory.listExceptions())
    }
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
  } catch (e) {
    if (e instanceof InfraError) {
      console.error('infrastructure error', e.cause ?? e)
      return busy()
    }
    console.error('unexpected error', e)
    return err(500, 'Unexpected error')
  }
}
