import type { ExceptionRecord, Finding } from './types'
import { RULES_VERSION, ruleById } from './rules'
import { LLM_MODEL, PROMPT_HASH } from './checks/llm'

export interface CachedReview {
  findings: Finding[]
  filesReviewed: number
  skippedFiles: string[]
  truncated: boolean
}

function isCachedReview(v: unknown): v is CachedReview {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    Array.isArray(c.findings) &&
    c.findings.every((f) => f && typeof f === 'object' && typeof (f as any).ruleId === 'string' && typeof (f as any).path === 'string') &&
    typeof c.filesReviewed === 'number' &&
    Array.isArray(c.skippedFiles) &&
    c.skippedFiles.every((p) => typeof p === 'string') &&
    typeof c.truncated === 'boolean'
  )
}

/** Reads and validates a cached result; anything missing, unparseable or malformed is a miss. */
export async function readCachedReview(kv: KVNamespace, key: string): Promise<CachedReview | null> {
  try {
    const raw = await kv.get(key)
    if (raw === null || raw === undefined) return null
    const v = JSON.parse(raw)
    return isCachedReview(v) ? v : null
  } catch {
    return null
  }
}

const MAX_GLOB = 100
const MAX_WILDCARDS = 4
const CATCH_ALL = /^(?:\*\*\/)*\*{1,2}$/
const PROBES = ['a', 'a/b.ts', 'x/y/z.js']

type Token = { t: 'lit'; c: string } | { t: 'q' } | { t: 's1' } | { t: 's2' } | { t: 'ds' }

/** Test hook: how many globs have been tokenized. */
export const globStats = { compiles: 0 }

function tokenize(glob: string): Token[] {
  globStats.compiles++
  const out: Token[] = []
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      out.push({ t: 'ds' })
      i += 3
    } else if (glob.startsWith('**', i)) {
      out.push({ t: 's2' })
      i += 2
    } else if (glob[i] === '*') {
      out.push({ t: 's1' })
      i++
    } else if (glob[i] === '?') {
      out.push({ t: 'q' })
      i++
    } else {
      out.push({ t: 'lit', c: glob[i] })
      i++
    }
  }
  return out
}

/**
 * Linear-time (O(path x glob)) wildcard matcher; no regex is built from user input.
 * `**` crosses `/`; `**` followed by `/` also matches zero directories; `*` and `?` never cross `/`.
 */
export function globMatch(path: string, glob: string): boolean {
  return matchTokens(path, tokenize(glob))
}

function matchTokens(path: string, toks: Token[]): boolean {
  const n = path.length
  let next = new Array<boolean>(n + 1).fill(false)
  next[n] = true // dp for j = toks.length: only the empty remainder matches
  for (let j = toks.length - 1; j >= 0; j--) {
    const tok = toks[j]
    const cur = new Array<boolean>(n + 1).fill(false)
    let dsAcc = false // exists k >= i with path[k] === '/' and next[k + 1]
    for (let i = n; i >= 0; i--) {
      switch (tok.t) {
        case 'lit':
          cur[i] = i < n && path[i] === tok.c && next[i + 1]
          break
        case 'q':
          cur[i] = i < n && path[i] !== '/' && next[i + 1]
          break
        case 's1':
          cur[i] = next[i] || (i < n && path[i] !== '/' && cur[i + 1])
          break
        case 's2':
          cur[i] = next[i] || (i < n && cur[i + 1])
          break
        case 'ds':
          if (i < n && path[i] === '/' && next[i + 1]) dsAcc = true
          cur[i] = next[i] || dsAcc
          break
      }
    }
    next = cur
  }
  return next[0]
}

export function validateGlob(glob: string): string | null {
  if (typeof glob !== 'string' || glob.trim() === '') return 'Path glob is required.'
  if (glob.length > MAX_GLOB) return `Path glob must be at most ${MAX_GLOB} characters.`
  const g = glob.trim()
  const tooBroad = 'Path glob is too broad; scope it to a directory or file pattern such as test/**.'
  if (CATCH_ALL.test(g)) return tooBroad
  if (tokenize(g).filter((t) => t.t !== 'lit').length > MAX_WILDCARDS) return `Path glob may use at most ${MAX_WILDCARDS} wildcards.`
  if (PROBES.filter((p) => globMatch(p, g)).length >= 2) return tooBroad
  return null
}

export function applyExceptions(
  findings: Finding[],
  exceptions: ExceptionRecord[],
): { kept: Finding[]; suppressed: Finding[] } {
  const kept: Finding[] = []
  const suppressed: Finding[] = []
  // Compile every exception once, not once per finding.
  const compiled = exceptions.map((e) => ({ ruleId: e.ruleId, toks: tokenize(e.pathGlob) }))
  for (const f of findings) {
    const hit = compiled.some((e) => e.ruleId === f.ruleId && matchTokens(f.path, e.toks))
    ;(hit ? suppressed : kept).push(f)
  }
  return { kept, suppressed }
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const k = `${f.ruleId}\0${f.path}\0${f.line}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function sortFindings(findings: Finding[]): Finding[] {
  const sev = (f: Finding) => (ruleById(f.ruleId)?.severity === 'error' ? 0 : 1)
  return [...findings].sort((a, b) => {
    if (sev(a) !== sev(b)) return sev(a) - sev(b)
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    if (a.line === b.line) return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0
    if (a.line === null) return 1
    if (b.line === null) return -1
    return a.line - b.line
  })
}

export async function cacheKey(diff: string): Promise<string> {
  const data = new TextEncoder().encode(`${RULES_VERSION}|${LLM_MODEL}|${PROMPT_HASH}|${diff}`)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return 'review:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
