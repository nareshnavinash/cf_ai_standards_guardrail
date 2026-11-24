import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error plain ESM script without types
import { cleanMessage, extractPrompts, renderPrompts } from '../scripts/export-prompts.mjs'

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/session.jsonl'), 'utf8')

describe('export-prompts', () => {
  const prompts = extractPrompts(fixture) as { timestamp: string; text: string; pasted: boolean }[]

  it('keeps only human-typed prompts, in time order', () => {
    expect(prompts.map((p) => p.text.split('\n')[0])).toEqual(['first prompt', 'got this', 'second prompt'])
  })
  it('strips system reminders', () => {
    expect(prompts[0]!.text).toBe('first prompt')
    expect(JSON.stringify(prompts)).not.toContain('secret context')
  })
  it('drops sidechain, meta, tool results, command, bash, task and agent noise and interrupts', () => {
    const all = JSON.stringify(prompts)
    for (const s of ['subagent brief', 'meta caveat', 'output', 'clear', 'bash-input', 'done', 'agent-message', 'interrupted', 'only a reminder', 'an answer']) {
      expect(all).not.toContain(s)
    }
  })
  it('labels pasted content', () => {
    expect(prompts[1]!.pasted).toBe(true)
    expect(prompts[1]!.text).toContain('(pasted)')
    expect(prompts[1]!.text).toContain('> line one')
    expect(prompts[1]!.text).not.toContain('<pasted_content')
  })
  it('rejects non-string, non-array content', () => {
    expect(cleanMessage(undefined)).toBeNull()
    expect(cleanMessage([{ type: 'image' }])).toBeNull()
  })
  it('renders sessions with UTC time headings', () => {
    const md = renderPrompts([prompts]) as string
    expect(md).toContain('## Session 1 (2026-11-24)')
    expect(md).toContain('### 06:04')
    expect(md).toContain('### 06:13')
  })
})
