import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { RepoMemory } from './memory'
import type { DiffFile, Env, ExceptionRecord, Finding, ReviewMode, ReviewParams, ReviewResult } from './types'
import { RULES, RULES_VERSION } from './rules'
import { limitFiles, parseUnifiedDiff } from './diff'
import { isTestPath, runStaticChecks, type PathInfo } from './checks/static'
import { LlmParseError, checkFileWithLlm } from './checks/llm'
import { DEFAULT_NEURON_BUDGET, LlmBudgetError } from './budget'
import { applyExceptions, cacheKey, dedupeFindings, readCachedReview, sortFindings, type CachedReview } from './review'

export interface StepLike {
  do<T>(name: string, opts: object | (() => Promise<T>), fn?: () => Promise<T>): Promise<T>
}
export interface MemoryLike {
  listExceptions(): Promise<ExceptionRecord[]>
  saveReview(r: ReviewResult): Promise<void>
}
export interface ReviewDeps {
  step: StepLike
  ai: Ai
  cache: KVNamespace
  memory: MemoryLike
  control?: {
    clearInflight(reviewId: string): Promise<void>
    reserveNeurons?(day: string, key: string, amount: number, budget: number): Promise<boolean>
    settleNeurons?(key: string, actual: number): Promise<void>
  }
  /** Daily neuron budget for per-call reservations (default 9000). */
  neuronBudget?: number
}

const BATCH = 4
const CACHE_TTL = 30 * 24 * 60 * 60
const LLM_STEP = { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '2 minutes' }

/** The workflow's logic as a plain function so it can be unit-tested. Step results stay small: never the diff. */
export async function runReview(params: ReviewParams, deps: ReviewDeps): Promise<ReviewResult> {
  const { step, ai, cache, memory } = deps

  // Files are recomputed from the payload inside steps rather than returned from one,
  // so no step result carries the diff.
  let memo: { files: DiffFile[]; skipped: string[]; truncated: boolean; allPaths: PathInfo[] } | null = null
  const load = () => {
    if (!memo) {
      const parsed = parseUnifiedDiff(params.diff)
      memo = { ...limitFiles(parsed), allPaths: parsed.map((f) => ({ path: f.path, status: f.status, added: f.added.length })) }
    }
    return memo
  }

  const meta = await step.do('parse', async () => {
    const m = load()
    return { filesReviewed: m.files.length, skippedFiles: m.skipped, truncated: m.truncated }
  })

  const key = await cacheKey(params.diff)
  // A static-only run must never be answered from a cached full result.
  const cachedHit: CachedReview | null =
    params.mode === 'static-only' ? null : await step.do('cache-lookup', async () => readCachedReview(cache, key))

  let raw: Finding[]
  let degradedFiles: string[] = []
  let budgetHit = false
  let runMode: ReviewMode = params.mode
  let info = meta
  const cached = cachedHit !== null

  if (cachedHit) {
    raw = cachedHit.findings
    info = { filesReviewed: cachedHit.filesReviewed, skippedFiles: cachedHit.skippedFiles, truncated: cachedHit.truncated }
  } else {
    // Admitted on a cache hit (no budget slot) but the cache missed now: never spend AI without a slot.
    if (params.cacheOnly) runMode = 'static-only'
    const staticFindings = await step.do('static-checks', async () => {
      const m = load()
      return runStaticChecks(m.files, m.allPaths)
    })
    const llmFindings: Finding[] = []
    if (runMode === 'full') {
      const files = load().files
      // Test files are only checked by the static rules (no LLM spend, no STD-005..007 noise).
      const idxs = files.map((_, i) => i).filter((i) => !isTestPath(files[i].path))
      for (let start = 0; start < idxs.length; start += BATCH) {
        const batch = idxs.slice(start, start + BATCH)
        const results = await Promise.all(
          batch.map(async (i) => {
            try {
              // Transport errors throw (and are retried by Workflows); an unparseable reply degrades without a retry.
              const stepName = 'llm-check:' + i
              const key = `${params.reviewId}:${stepName}`
              const out = await step.do(stepName, LLM_STEP, async () => {
                let neurons = 0
                let settleToZero = false
                // Reserve the worst case before the call (idempotent per key, so retries do not double charge); refused means no AI call.
                const reserve = async (amount: number) =>
                  deps.control?.reserveNeurons
                    ? deps.control.reserveNeurons(new Date().toISOString().slice(0, 10), key, amount, deps.neuronBudget ?? DEFAULT_NEURON_BUDGET)
                    : true
                try {
                  return { findings: await checkFileWithLlm(ai, load().files[i], RULES, (n) => (neurons = n), reserve), degraded: false, budget: false }
                } catch (e) {
                  if (e instanceof LlmParseError) return { findings: [] as Finding[], degraded: true, budget: false }
                  if (e instanceof LlmBudgetError) return { findings: [] as Finding[], degraded: true, budget: true }
                  settleToZero = true // transport error: nothing was used, so release the reservation before the retry
                  throw e
                } finally {
                  // Settle the reservation to the real usage; a failure leaves the (higher) reservation charged.
                  if (settleToZero || neurons > 0) {
                    try {
                      await deps.control?.settleNeurons?.(key, neurons)
                    } catch {
                      // accounting is best effort; the review itself must not fail
                    }
                  }
                }
              })
              return { found: out.findings, degraded: out.degraded, budget: out.budget, path: files[i].path }
            } catch {
              return { found: [] as Finding[], degraded: true, budget: false, path: files[i].path }
            }
          }),
        )
        for (const r of results) {
          llmFindings.push(...r.found)
          if (r.degraded) degradedFiles.push(r.path)
          if (r.budget) budgetHit = true
        }
      }
    }
    raw = sortFindings(dedupeFindings([...staticFindings, ...llmFindings]))

    if (runMode === 'full' && degradedFiles.length === 0) {
      await step.do('cache-store', async () => {
        const body: CachedReview = { findings: raw, ...info }
        try {
          await cache.put(key, JSON.stringify(body), { expirationTtl: CACHE_TTL })
        } catch {
          // KV write quota exhausted: the review is still valid, it just will not be cached.
        }
        return true
      })
    }
  }

  const { kept, suppressed } = await step.do('apply-exceptions', async () => {
    const exceptions = await memory.listExceptions()
    return applyExceptions(raw, exceptions)
  })

  const mode: ReviewMode = cached ? 'full' : runMode
  return step.do('persist', async () => {
    const result: ReviewResult = {
      id: params.reviewId,
      repo: params.repo,
      prNumber: params.prNumber,
      title: params.title,
      mode,
      findings: kept,
      suppressed,
      filesReviewed: info.filesReviewed,
      skippedFiles: info.skippedFiles,
      degradedFiles,
      ...(budgetHit ? { degradedReason: 'budget' as const } : {}),
      truncated: info.truncated,
      rulesVersion: RULES_VERSION,
      cached,
      createdAt: new Date().toISOString(),
    }
    await memory.saveReview(result)
    try {
      await deps.control?.clearInflight(params.reviewId)
    } catch {
      // the in-flight marker expires on its own
    }
    return result
  })
}

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep): Promise<ReviewResult> {
    const ns = this.env.REPO_MEMORY
    const memory = ns.get(ns.idFromName(event.payload.memoryKey)) as unknown as DurableObjectStub<RepoMemory>
    return runReview(event.payload, {
      step: step as unknown as StepLike,
      ai: this.env.AI,
      cache: this.env.CACHE,
      memory: memory as unknown as MemoryLike,
      neuronBudget: parseInt(this.env.DAILY_NEURON_BUDGET ?? '', 10) || DEFAULT_NEURON_BUDGET,
      control: this.env.CONTROL.get(this.env.CONTROL.idFromName('global')) as unknown as NonNullable<ReviewDeps['control']>,
    })
  }
}
