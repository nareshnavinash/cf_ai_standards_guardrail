import { describe, expect, it, vi } from 'vitest'
import { HttpError, fetchPrDiff, parsePrUrl } from '../src/github'

describe('parsePrUrl', () => {
  const ok = { owner: 'cloudflare', repo: 'workers-sdk', number: 123 }
  for (const u of [
    'https://github.com/Cloudflare/Workers-SDK/pull/123',
    'https://github.com/Cloudflare/Workers-SDK/pull/123/files',
    'https://github.com/Cloudflare/Workers-SDK/pull/123/commits',
    'https://github.com/Cloudflare/Workers-SDK/pull/123/',
    'https://github.com/Cloudflare/Workers-SDK/pull/123?diff=split',
    'https://github.com/Cloudflare/Workers-SDK/pull/123#discussion_r1',
    'https://www.github.com/Cloudflare/Workers-SDK/pull/123',
    'github.com/Cloudflare/Workers-SDK/pull/123',
    '  https://github.com/Cloudflare/Workers-SDK/pull/123  ',
  ]) {
    it(`accepts ${u}`, () => expect(parsePrUrl(u)).toEqual(ok))
  }
  it('rejects other hosts', () => {
    expect(parsePrUrl('github.example.com/a/b/pull/1')).toEqual({ error: 'Only github.com pull requests are supported' })
    expect(parsePrUrl('https://gitlab.com/a/b/pull/1')).toEqual({ error: 'Only github.com pull requests are supported' })
  })
  it('rejects non-PR links', () => {
    const e = { error: 'Paste a link like https://github.com/owner/repo/pull/123' }
    expect(parsePrUrl('https://github.com/a/b/issues/1')).toEqual(e)
    expect(parsePrUrl('https://github.com/a/b/pull/abc')).toEqual(e)
    expect(parsePrUrl('not a url')).toEqual(e)
    expect(parsePrUrl('')).toEqual(e)
  })
})

const URL_OK = 'https://github.com/o/r/pull/7'
type Reply = { status?: number; headers?: Record<string, string>; body?: unknown; text?: string }
function mockFetch(meta: Reply, diff: Reply) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const accept = (init?.headers as Record<string, string>).Accept
    const r = accept.includes('diff') ? diff : meta
    const text = r.text ?? JSON.stringify(r.body ?? {})
    return new Response(text, { status: r.status ?? 200, headers: r.headers })
  })
}
const META = { body: { title: 'Fix it', changed_files: 2 } }
const DIFF = { text: 'diff --git a/a b/a\n' }
const rejects = async (p: Promise<unknown>, status: number, msg?: string) => {
  const e = await p.then(
    () => null,
    (x) => x,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect((e as HttpError).status).toBe(status)
  if (msg) expect((e as HttpError).message).toBe(msg)
}

describe('fetchPrDiff', () => {
  it('returns repo, number, title and diff, sending auth headers', async () => {
    const f = mockFetch(META, DIFF)
    const r = await fetchPrDiff(URL_OK, 'tok', f as any)
    expect(r).toEqual({ repo: 'o/r', prNumber: 7, title: 'Fix it', diff: DIFF.text })
    const h = f.mock.calls[0][1]!.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer tok')
    expect(h['User-Agent']).toBe('cf-ai-standards-guardrail')
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/7')
  })
  it('omits Authorization without a token', async () => {
    const f = mockFetch(META, DIFF)
    await fetchPrDiff(URL_OK, undefined, f as any)
    expect((f.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBeUndefined()
  })
  it('rejects bad urls with 400', async () => {
    await rejects(fetchPrDiff('https://github.com/a/b/issues/1', undefined, vi.fn() as any), 400)
  })
  it('maps 404 and plain 403 to 404', async () => {
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch({ status: 404 }, DIFF) as any), 404, 'PR not found, or the repo is private')
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch({ status: 403 }, DIFF) as any), 404)
  })
  it('maps rate limiting to 502', async () => {
    for (const status of [403, 429]) {
      await rejects(
        fetchPrDiff(URL_OK, 't', mockFetch({ status, headers: { 'x-ratelimit-remaining': '0' } }, DIFF) as any),
        502,
        'GitHub rate limit reached — try a sample PR',
      )
    }
  })
  it('maps 406/422 on the diff request to 413', async () => {
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch(META, { status: 406 }) as any), 413)
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch(META, { status: 422 }) as any), 413)
  })
  it('maps other failures to 502', async () => {
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch({ status: 500 }, DIFF) as any), 502)
    const boom = vi.fn().mockRejectedValue(new Error('net'))
    await rejects(fetchPrDiff(URL_OK, 't', boom as any), 502)
  })
  it('422 for zero changed files, 413 for more than 300', async () => {
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch({ body: { title: 't', changed_files: 0 } }, DIFF) as any), 422)
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch({ body: { title: 't', changed_files: 301 } }, DIFF) as any), 413)
  })
  it('413 on content-length over 100 KB without reading the body', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      if ((init!.headers as Record<string, string>).Accept.includes('diff')) {
        const res = new Response('x', { status: 200, headers: { 'content-length': String(100 * 1024 + 1) } })
        res.text = vi.fn(async () => 'x')
        res.arrayBuffer = vi.fn(async () => new ArrayBuffer(1))
        ;(f as any).res = res
        return res
      }
      return new Response(JSON.stringify(META.body))
    })
    await rejects(fetchPrDiff(URL_OK, 't', f as any), 413)
    expect(((f as any).res.text as any).mock.calls).toHaveLength(0)
    expect(((f as any).res.arrayBuffer as any).mock.calls).toHaveLength(0)
  })
  it('413 when a multibyte body exceeds 100 KB in bytes', async () => {
    const text = 'é'.repeat(60 * 1024) // 60K chars, 120 KB
    await rejects(fetchPrDiff(URL_OK, 't', mockFetch(META, { text }) as any), 413)
  })
})
