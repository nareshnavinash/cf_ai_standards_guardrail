/**
 * Eval runner. `npm run eval` runs every case static-only (no AI spend) and rewrites evals/RESULTS.md.
 * `npm run eval -- --llm` runs only the cases marked "llm": true with the model enabled and records the outcome.
 * The EVAL_KEY comes from the environment or the gitignored .eval-key file; it is never printed.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULES, RULES_VERSION } from '../src/rules'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const STATIC_IDS = RULES.filter((r) => r.kind === 'static').map((r) => r.id)
const LLM_IDS = RULES.filter((r) => r.kind === 'llm').map((r) => r.id)

export interface EvalCase { name: string; source: 'synthetic' | 'real'; origin?: string; llm?: boolean; note?: string; diff: string; expected: string[] }
export interface CaseRun { name: string; mode: string; found: string[]; degradedFiles: string[]; degradedReason?: string; seconds: number; rulesVersion: string; error?: string }
interface RunFile { at: string; base: string; rulesVersion: string; runs: CaseRun[] }
export interface Counts { tp: number; fp: number; fn: number }

export function score(cases: EvalCase[], runs: CaseRun[], ids: string[]): Record<string, Counts> {
  const out: Record<string, Counts> = Object.fromEntries(ids.map((id) => [id, { tp: 0, fp: 0, fn: 0 }]))
  for (const run of runs) {
    const c = cases.find((x) => x.name === run.name)
    if (!c || run.error) continue
    for (const id of ids) {
      const want = c.expected.includes(id)
      const got = run.found.includes(id)
      if (want && got) out[id]!.tp++
      else if (!want && got) out[id]!.fp++
      else if (want && !got) out[id]!.fn++
    }
  }
  return out
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b)
const fmt = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(2))
export function prf(c: Counts): { p: number | null; r: number | null; f1: number | null } {
  const p = ratio(c.tp, c.tp + c.fp)
  const r = ratio(c.tp, c.tp + c.fn)
  const f1 = p === null || r === null || p + r === 0 ? null : (2 * p * r) / (p + r)
  return { p, r, f1 }
}

function table(counts: Record<string, Counts>, nCases: number): string {
  const rows = Object.entries(counts).map(([id, c]) => {
    const { p, r, f1 } = prf(c)
    return `| ${id} | ${c.tp} | ${c.fp} | ${c.fn} | ${fmt(p)} | ${fmt(r)} | ${fmt(f1)} | ${nCases} |`
  })
  return ['| Rule | TP | FP | FN | Precision | Recall | F1 | Cases |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n')
}

function loadCases(): EvalCase[] {
  const dir = join(HERE, 'cases')
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase)
}

function evalKey(): string {
  if (process.env.EVAL_KEY) return process.env.EVAL_KEY
  const p = join(ROOT, '.eval-key')
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  throw new Error('Set EVAL_KEY or create the gitignored .eval-key file')
}

async function runCase(base: string, key: string, c: EvalCase, staticOnly: boolean): Promise<CaseRun> {
  const t0 = Date.now()
  const fail = (error: string): CaseRun => ({ name: c.name, mode: staticOnly ? 'static-only' : 'full', found: [], degradedFiles: [], seconds: (Date.now() - t0) / 1000, rulesVersion: '', error })
  const res = await fetch(`${base}/api/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-eval-key': key },
    body: JSON.stringify({ evalDiff: c.diff, repo: `eval/${c.name}`, ...(staticOnly ? { evalMode: 'static-only' } : {}) }),
  })
  if (!res.ok) return fail(`create failed: ${res.status}`)
  const { reviewId } = (await res.json()) as { reviewId: string }
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const g = await fetch(`${base}/api/reviews/${reviewId}`)
    if (!g.ok) return fail(`poll failed: ${g.status}`)
    const body = (await g.json()) as { status: string; result?: any; error?: string }
    if (body.status === 'failed') return fail(body.error ?? 'failed')
    if (body.status === 'complete') {
      const r = body.result
      return {
        name: c.name,
        mode: r.mode,
        found: [...new Set<string>(r.findings.map((f: { ruleId: string }) => f.ruleId))].sort(),
        degradedFiles: r.degradedFiles,
        ...(r.degradedReason ? { degradedReason: r.degradedReason } : {}),
        seconds: (Date.now() - t0) / 1000,
        rulesVersion: r.rulesVersion,
      }
    }
  }
  return fail('timed out')
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!) } }))
  return out
}

const readRun = (name: string): RunFile | null => {
  const p = join(HERE, 'results', name)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as RunFile) : null
}

function caseTable(cases: EvalCase[], runs: CaseRun[], ids: string[]): string {
  const rows = runs.map((r) => {
    const c = cases.find((x) => x.name === r.name)!
    const want = c.expected.filter((i) => ids.includes(i))
    const got = r.found.filter((i) => ids.includes(i))
    const ok = r.error ? 'error' : JSON.stringify(want) === JSON.stringify(got) ? 'match' : 'MISMATCH'
    const deg = r.degradedFiles.length ? ` (degraded: ${r.degradedReason ?? 'error'})` : ''
    return `| ${c.name} | ${c.source} | ${want.join(', ') || '-'} | ${r.error ? r.error : got.join(', ') || '-'}${deg} | ${ok} | ${r.seconds.toFixed(1)} |`
  })
  return ['| Case | Source | Expected | Found | Result | Seconds |', '|---|---|---|---|---|---|', ...rows].join('\n')
}

export function renderResults(cases: EvalCase[], st: RunFile | null, llm: RunFile | null): string {
  const L: string[] = ['# Eval results', '']
  L.push(`${cases.length} cases (${cases.filter((c) => c.source === 'real').length} from real public GitHub PRs, ${cases.filter((c) => c.source === 'synthetic').length} synthetic). Labels were written by hand by the author from the diffs; the real diffs are stored in \`evals/cases/\` with their \`origin\` URL.`, '')
  if (st) {
    const runs = st.runs.filter((r) => !r.error)
    L.push(`## Static rules (STD-001 to STD-004), static-only mode`, '', `Run ${st.at} against ${st.base}, rules version ${st.rulesVersion}. No AI spend.`, '')
    L.push(table(score(cases, runs, STATIC_IDS), runs.length), '', caseTable(cases, st.runs, STATIC_IDS), '')
  }
  if (llm) {
    const clean = llm.runs.filter((r) => !r.error && r.degradedFiles.length === 0)
    const degraded = llm.runs.filter((r) => !r.error && r.degradedFiles.length > 0)
    const errs = llm.runs.filter((r) => r.error)
    L.push(`## LLM rules (STD-005 to STD-007), full mode, run once`, '', `Run ${llm.at} against ${llm.base}, rules version ${llm.rulesVersion}. ${llm.runs.length} cases sent to the model. Degraded: ${degraded.length}. Errors: ${errs.length}.`, '')
    if (degraded.some((r) => r.degradedReason === 'budget')) {
      L.push('**Some cases came back degraded because the daily neuron budget was exhausted (reason "budget").** This run was not retried, so those cases are excluded from the precision and recall figures below rather than counted as misses.', '')
    }
    if (clean.length > 0) L.push(table(score(cases, clean, LLM_IDS), clean.length), '')
    else L.push('No LLM case completed without degradation, so there are no LLM precision or recall figures.', '')
    L.push(caseTable(cases, llm.runs, LLM_IDS), '')
  } else {
    L.push('## LLM rules', '', 'The LLM run has not been executed yet (`npm run eval -- --llm`).', '')
  }
  const all = [...(st?.runs ?? []), ...(llm?.runs ?? [])].filter((r) => !r.error)
  if (all.length) {
    const avg = (xs: CaseRun[]) => (xs.length ? (xs.reduce((s, r) => s + r.seconds, 0) / xs.length).toFixed(1) : 'n/a')
    L.push('## Timing', '', `Mean seconds per review: static-only ${avg(st?.runs.filter((r) => !r.error) ?? [])}, with LLM ${avg(llm?.runs.filter((r) => !r.error) ?? [])}.`, '')
  }
  L.push(
    '## What this eval does not show',
    '',
    '- **Small n.** 27 cases in total, and the LLM rules saw only 8, with exactly one positive example each (STD-005, STD-006, STD-007). A perfect LLM score here is 3 for 3 on positives and 5 correct silences, which is far too little to claim a precision or recall. These are smoke-test numbers, not estimates of production accuracy.',
    '- **Author-labelled.** One person wrote the standards, the cases and the labels, with no second rater, so the scores measure agreement with the author, not with a team.',
    '- **Synthetic bias.** Most cases were written to exercise a rule, which makes them easier than organic code. Static rules scoring 1.00 on them mostly proves the regexes match the cases they were written for.',
    '- **Real PRs are mostly clean.** The five real PRs come from well-run open source projects and are mostly violation-free, so they test false positives far more than recall. One (`real-express-7512`, comment-only edits) deliberately records a known static false positive on STD-004.',
    '- **LLM variance.** The model ran once per case at low temperature. Re-running could change results, and the Llama 3.3 70B behaviour can shift with Cloudflare model updates.',
    '- **No line-level scoring.** A case matches when the set of rule ids matches; whether the right line was flagged is not scored.',
    '- **Not the real standards.** The catalog is a seven-rule demo, not any company policy.',
    '',
  )
  return L.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const withLlm = args.includes('--llm')
  if (args.includes('--report')) {
    writeFileSync(join(HERE, 'RESULTS.md'), renderResults(loadCases(), readRun('static.json'), readRun('llm.json')))
    return
  }
  const base = (process.env.EVAL_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '')
  const cases = loadCases()
  const key = evalKey()
  mkdirSync(join(HERE, 'results'), { recursive: true })
  const subset = withLlm ? cases.filter((c) => c.llm) : cases
  console.log(`running ${subset.length} cases ${withLlm ? 'with the LLM' : 'static-only'} against ${base}`)
  const runs = await pool(subset, 3, (c) => runCase(base, key, c, !withLlm))
  const file: RunFile = { at: new Date().toISOString(), base, rulesVersion: RULES_VERSION, runs }
  writeFileSync(join(HERE, 'results', withLlm ? 'llm.json' : 'static.json'), JSON.stringify(file, null, 2) + '\n')
  writeFileSync(join(HERE, 'RESULTS.md'), renderResults(cases, readRun('static.json'), readRun('llm.json')))
  for (const r of runs) console.log(`${r.error ? 'ERR ' : 'ok  '} ${r.name} -> ${r.error ?? (r.found.join(',') || '-')}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
}
