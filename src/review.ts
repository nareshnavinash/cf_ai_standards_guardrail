import type { ExceptionRecord, Finding } from './types'
import { RULES_VERSION, ruleById } from './rules'
import { LLM_MODEL, PROMPT_HASH } from './checks/llm'

const MAX_GLOB = 200
const CATCH_ALL = /^(?:\*\*\/)*\*{1,2}$/

export function validateGlob(glob: string): string | null {
  if (typeof glob !== 'string' || glob.trim() === '') return 'Path glob is required.'
  if (glob.length > MAX_GLOB) return `Path glob must be at most ${MAX_GLOB} characters.`
  if (CATCH_ALL.test(glob.trim())) return 'Path glob is too broad; scope it to a directory or file pattern such as test/**.'
  return null
}

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (glob[i] === '*') {
      re += '[^/]*'
      i++
    } else if (glob[i] === '?') {
      re += '[^/]'
      i++
    } else {
      re += glob[i].replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&')
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

export function globMatch(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path)
}

export function applyExceptions(
  findings: Finding[],
  exceptions: ExceptionRecord[],
): { kept: Finding[]; suppressed: Finding[] } {
  const kept: Finding[] = []
  const suppressed: Finding[] = []
  for (const f of findings) {
    const hit = exceptions.some((e) => e.ruleId === f.ruleId && globMatch(f.path, e.pathGlob))
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
