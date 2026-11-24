import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { RepoMemory } from './memory'
import type { DiffFile, Env, ExceptionRecord, Finding, ReviewMode, ReviewParams, ReviewResult } from './types'
import { RULES, RULES_VERSION } from './rules'
import { limitFiles, parseUnifiedDiff } from './diff'
import { runStaticChecks } from './checks/static'
import { checkFileWithLlm } from './checks/llm'
import { applyExceptions, cacheKey, dedupeFindings, sortFindings } from './review'

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
}

interface CachedReview {
  findings: Finding[]
  filesReviewed: number
  skippedFiles: string[]
  truncated: boolean
}

const BATCH = 4
const CACHE_TTL = 30 * 24 * 60 * 60
const LLM_STEP = { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '2 minutes' }

/** The workflow's logic as a plain function so it can be unit-tested. Step results stay small: never the diff. */
export async function runReview(params: ReviewParams, deps: ReviewDeps): Promise<ReviewResult> {
  const { step, ai, cache, memory } = deps

  // Files are recomputed from the payload inside steps rather than returned from one,
  // so no step result carries the diff.
  let memo: { files: DiffFile[]; skipped: string[]; truncated: boolean; allPaths: string[] } | null = null
  const load = () => {
    if (!memo) {
      const parsed = parseUnifiedDiff(params.diff)
      memo = { ...limitFiles(parsed), allPaths: parsed.map((f) => f.path) }
    }
    return memo
  }

  const meta = await step.do('parse', async () => {
    const m = load()
    return { filesReviewed: m.files.length, skippedFiles: m.skipped, truncated: m.truncated }
  })

  const key = await cacheKey(params.diff)
  const cachedHit = await step.do('cache-lookup', async () => (await cache.get<CachedReview>(key, 'json')) ?? null)

  let raw: Finding[]
  let degradedFiles: string[] = []
  let info = meta
  const cached = cachedHit !== null

  if (cachedHit) {
    raw = cachedHit.findings
    info = { filesReviewed: cachedHit.filesReviewed, skippedFiles: cachedHit.skippedFiles, truncated: cachedHit.truncated }
  } else {
    const staticFindings = await step.do('static-checks', async () => {
      const m = load()
      return runStaticChecks(m.files, m.allPaths)
    })
    const llmFindings: Finding[] = []
    if (params.mode === 'full') {
      const files = load().files
      for (let start = 0; start < files.length; start += BATCH) {
        const batch = files.slice(start, start + BATCH)
        const results = await Promise.all(
          batch.map(async (file, j) => {
            const i = start + j
            try {
              const found = await step.do('llm-check:' + i, LLM_STEP, async () => checkFileWithLlm(ai, load().files[i], RULES))
              return { found, degraded: false as const }
            } catch {
              return { found: [] as Finding[], degraded: true as const, path: file.path }
            }
          }),
        )
        for (const r of results) {
          llmFindings.push(...r.found)
          if (r.degraded) degradedFiles.push((r as { path: string }).path)
        }
      }
    }
    raw = sortFindings(dedupeFindings([...staticFindings, ...llmFindings]))

    if (params.mode === 'full' && degradedFiles.length === 0) {
      await step.do('cache-store', async () => {
        const body: CachedReview = { findings: raw, ...info }
        await cache.put(key, JSON.stringify(body), { expirationTtl: CACHE_TTL })
        return true
      })
    }
  }

  const { kept, suppressed } = await step.do('apply-exceptions', async () => {
    const exceptions = await memory.listExceptions()
    return applyExceptions(raw, exceptions)
  })

  const mode: ReviewMode = cached ? 'full' : params.mode
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
      truncated: info.truncated,
      rulesVersion: RULES_VERSION,
      cached,
      createdAt: new Date().toISOString(),
    }
    await memory.saveReview(result)
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
    })
  }
}
