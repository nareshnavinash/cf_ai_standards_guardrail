#!/usr/bin/env node
/**
 * Builds PROMPTS.md from Claude Code session logs: only prompts the human typed.
 *
 * node scripts/export-prompts.mjs [--modified-on YYYY-MM-DD] [--match text]... [--runtime] [--out file] <jsonl-or-dir>...
 *
 * --modified-on  keep only top-level *.jsonl files whose local modification date is that day
 * --match        keep only files whose raw text contains at least one of the given strings (repeatable)
 * --runtime      append the app's own system prompts (generated from src by scripts/runtime-prompts.ts)
 * --out          write to a file instead of stdout
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DROP_MARKERS = ['<command-', '<local-command-', '<bash-input>', '<bash-stdout>', '<bash-stderr>', '<task-notification>', '<agent-message']
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const PASTED_RE = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g

/** Turns a raw user message into clean prompt text, or null when it is not something the human typed. */
export function cleanMessage(content) {
  let text
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return null
    text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
  } else return null
  text = text.replace(REMINDER_RE, '').trim()
  if (!text) return null
  if (DROP_MARKERS.some((m) => text.includes(m))) return null
  if (text.startsWith('[Request interrupted')) return null
  const pasted = PASTED_RE.test(text)
  PASTED_RE.lastIndex = 0
  text = text.replace(PASTED_RE, (_, body) => '\n(pasted)\n' + body.trim().split('\n').map((l) => '> ' + l).join('\n') + '\n')
  return { text: text.trim(), pasted }
}

/** Extracts the human prompts from the text of one session jsonl file, in timestamp order. */
export function extractPrompts(jsonl) {
  const out = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type !== 'user' || e.isSidechain || e.isMeta || !e.message) continue
    const cleaned = cleanMessage(e.message.content)
    if (cleaned) out.push({ timestamp: e.timestamp ?? '', ...cleaned })
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

const pad = (n) => String(n).padStart(2, '0')

/** sessions: arrays of prompts. Times are UTC so the output does not depend on the machine's timezone. */
export function renderPrompts(sessions) {
  const lines = [
    '# Prompts',
    '',
    'Every prompt below was typed by the author in Claude Code while building this project (times are UTC). Tool output, subagent briefs, system reminders and slash-command noise are filtered out; pasted material is marked "(pasted)".',
    '',
  ]
  sessions.forEach((prompts, i) => {
    if (!prompts.length) return
    const day = prompts[0].timestamp.slice(0, 10)
    lines.push(`## Session ${i + 1} (${day})`, '')
    for (const p of prompts) {
      const d = new Date(p.timestamp)
      lines.push(`### ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, '', p.text, '')
    }
  })
  return lines.join('\n')
}

function collect(inputs) {
  const files = []
  for (const input of inputs) {
    const p = resolve(input)
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (f.endsWith('.jsonl')) files.push(join(p, f)) // top level only
    } else files.push(p)
  }
  return files
}

const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function main() {
  const args = process.argv.slice(2)
  const inputs = []
  const matches = []
  let modifiedOn = null
  let out = null
  let runtime = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--modified-on') modifiedOn = args[++i]
    else if (a === '--match') matches.push(args[++i])
    else if (a === '--out') out = args[++i]
    else if (a === '--runtime') runtime = true
    else inputs.push(a)
  }
  if (!inputs.length) {
    console.error('usage: export-prompts.mjs [--modified-on YYYY-MM-DD] [--match text]... [--runtime] [--out file] <jsonl-or-dir>...')
    process.exit(2)
  }
  const sessions = []
  const used = []
  for (const f of collect(inputs)) {
    if (modifiedOn && localDay(statSync(f).mtime) !== modifiedOn) continue
    const raw = readFileSync(f, 'utf8')
    if (matches.length && !matches.some((m) => raw.includes(m))) continue
    const prompts = extractPrompts(raw)
    if (prompts.length) {
      sessions.push(prompts)
      used.push(f)
    }
  }
  sessions.sort((a, b) => a[0].timestamp.localeCompare(b[0].timestamp))
  let md = renderPrompts(sessions)
  if (runtime) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    md += '\n' + execFileSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'scripts/runtime-prompts.ts')], { encoding: 'utf8' })
  }
  if (out) writeFileSync(out, md.endsWith('\n') ? md : md + '\n')
  else process.stdout.write(md)
  console.error(`used ${used.length} session file(s): ${used.map((f) => f.split('/').pop()).join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
