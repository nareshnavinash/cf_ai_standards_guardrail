import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(import.meta.dirname, '../public/app.js'), 'utf8')
const slice = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to))

describe('public/app.js chat lock', () => {
  const shouldLockChat = new Function(slice('function shouldLockChat', 'async function sendChat') + '; return shouldLockChat')() as (s: number, m: string) => boolean
  it('locks on 409 and on cap-style 429s', () => {
    expect(shouldLockChat(409, 'Chat is unavailable for static-only reviews')).toBe(true)
    expect(shouldLockChat(410, 'This review has expired. Run it again.')).toBe(true)
    expect(shouldLockChat(429, 'Daily AI budget used — AI resumes tomorrow (UTC)')).toBe(true)
    expect(shouldLockChat(429, "You've reached today's chat limit")).toBe(true)
    expect(shouldLockChat(429, 'Chat limit reached for this review (10 questions)')).toBe(true)
  })
  it('stays enabled for 400 validation errors and per-minute rate limits', () => {
    expect(shouldLockChat(400, 'Write a question first')).toBe(false)
    expect(shouldLockChat(400, 'Messages are limited to 2,000 characters')).toBe(false)
    expect(shouldLockChat(429, 'Too many messages — wait a minute and try again')).toBe(false)
  })
})

describe('public/app.js visitor id storage', () => {
  const code = slice('function uuid', 'function h(')
  const run = (win: Record<string, unknown>) => new Function('window', 'crypto', code + '; return { visitorId, persistent }')(win, win.crypto) as { visitorId: string; persistent: boolean }
  const mem = () => {
    const m: Record<string, string> = {}
    return { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => void (m[k] = v) }
  }
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  const forgetful = { getItem: () => null, setItem: () => {} }
  const crypto = { randomUUID: () => '11111111-2222-4333-8444-555555555555' }
  it('uses localStorage when it works', () => expect(run({ localStorage: mem(), sessionStorage: mem(), crypto }).persistent).toBe(true))
  it('falls back to sessionStorage, then memory, and reports not persistent', () => {
    expect(run({ localStorage: broken, sessionStorage: mem(), crypto }).persistent).toBe(false)
    const r = run({ localStorage: forgetful, sessionStorage: broken, crypto })
    expect(r.persistent).toBe(false)
    expect(r.visitorId).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('index.html carries the notice element', () => {
    const html = readFileSync(join(import.meta.dirname, '../public/index.html'), 'utf8')
    expect(html).toContain('Exceptions last only for this tab')
  })
})
