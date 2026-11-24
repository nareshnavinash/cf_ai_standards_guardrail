import { describe, expect, it } from 'vitest'
import { getJson, HttpError } from '../src/http'

const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

describe('getJson', () => {
  it('returns the parsed body on success', async () => {
    expect(await getJson('https://x.test/a', 100, respond(200, { ok: 1 }))).toEqual({ ok: 1 })
  })
  it('throws HttpError on a non-2xx response', async () => {
    await expect(getJson('https://x.test/a', 100, respond(503))).rejects.toBeInstanceOf(HttpError)
  })
  it('passes an abort signal', async () => {
    let signal: AbortSignal | null | undefined
    await getJson('https://x.test/a', 100, (async (_u: unknown, init?: RequestInit) => {
      signal = init?.signal
      return new Response('{}')
    }) as typeof fetch)
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})
