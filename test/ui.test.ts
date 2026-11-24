import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(import.meta.dirname, '../public/app.js'), 'utf8')
const slice = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to))

describe('public/app.js chat lock', () => {
  const shouldLockChat = new Function(slice('const LOCKING_CODES', 'async function sendChat') + '; return shouldLockChat')() as (s: number, code?: string) => boolean
  it('locks on the codes that mean the chat cannot work for this review or today', () => {
    for (const code of ['static_only', 'budget', 'ip_limit', 'review_limit', 'expired']) expect(shouldLockChat(code === 'budget' ? 429 : 409, code), code).toBe(true)
  })
  it('does not lock for not_finished 409s, 400 validation errors, per-minute 429s or unknown codes', () => {
    expect(shouldLockChat(409, 'not_finished')).toBe(false)
    expect(shouldLockChat(400, undefined)).toBe(false)
    expect(shouldLockChat(429, undefined)).toBe(false)
    expect(shouldLockChat(409, undefined)).toBe(false)
  })
})

describe('public/app.js static-only messaging', () => {
  const src2 = src
  it('decides on the error code, not the message text, and shows the server notice instead of the generic banner', () => {
    expect(src2).not.toMatch(/resumes tomorrow\|/)
    expect(src2).toContain('state.notice')
    expect(src2).toContain("noticeCode === 'budget'")
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

describe('public/app.js poll tolerance', () => {
  it('tolerates up to 2 consecutive 410s before showing the expired message', async () => {
    const code = slice('function poll(', 'function finishFailed')
    const run = async (statuses: number[]) => {
      const failed: string[] = []
      const calls = { n: 0 }
      const timers: Array<() => unknown> = []
      const ctx = {
        POLL_MAX_MS: 1e9, POLL_MS: 0, Date, Math, clearInterval: () => {}, setInterval: () => 0,
        setTimeout: (f: () => unknown) => void timers.push(f),
        setStatus: () => {}, state: { reviewId: 'r' }, stopPolling: () => {}, renderResult: () => failed.push('rendered'),
        finishFailed: (m: string) => failed.push(m), errText: () => 'expired!',
        api: async () => ({ status: statuses[Math.min(calls.n++, statuses.length - 1)], body: null }),
      }
      new Function(...Object.keys(ctx), code + '; poll(Date.now(), 0)')(...Object.values(ctx))
      while (timers.length) await timers.shift()!()
      return failed
    }
    expect(await run([410, 410, 404])).not.toContain('expired!')
    expect(await run([410, 410, 410])).toEqual(['expired!'])
    expect(await run([410, 410, 410, 410])).toEqual(['expired!'])
  })
})
