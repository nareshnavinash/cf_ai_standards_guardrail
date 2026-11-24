export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const PASTE_HINT = 'Paste a link like https://github.com/owner/repo/pull/123'
const MAX_DIFF_BYTES = 100 * 1024
const MAX_CHANGED_FILES = 300

export function parsePrUrl(input: string): { owner: string; repo: string; number: number } | { error: string } {
  const raw = (input ?? '').trim()
  if (!raw) return { error: PASTE_HINT }
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw)
  } catch {
    return { error: PASTE_HINT }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: PASTE_HINT }
  const host = u.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return { error: 'Only github.com pull requests are supported' }
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/)
  if (!m) return { error: PASTE_HINT }
  const number = parseInt(m[3], 10)
  if (!Number.isSafeInteger(number) || number < 1) return { error: PASTE_HINT }
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), number }
}

function mapStatus(res: Response, isDiff: boolean): HttpError {
  const rateLimited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0'
  if (rateLimited || res.status === 429) return new HttpError(502, 'GitHub rate limit reached — try a sample PR')
  if (res.status === 404 || res.status === 403) return new HttpError(404, 'PR not found, or the repo is private')
  if (isDiff && (res.status === 406 || res.status === 422)) {
    return new HttpError(413, 'This PR is too large to review (limit 100 KB of diff)')
  }
  return new HttpError(502, 'GitHub is unavailable right now — try again or use a sample PR')
}

export async function fetchPrDiff(
  url: string,
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ repo: string; prNumber: number; title: string; diff: string }> {
  const parsed = parsePrUrl(url)
  if ('error' in parsed) throw new HttpError(400, parsed.error)
  const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`
  const headers = (accept: string): Record<string, string> => ({
    Accept: accept,
    'User-Agent': 'cf-ai-standards-guardrail',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })
  const get = async (accept: string): Promise<Response> => {
    try {
      return await fetchFn(api, { headers: headers(accept) })
    } catch {
      throw new HttpError(502, 'GitHub is unavailable right now — try again or use a sample PR')
    }
  }

  const metaRes = await get('application/vnd.github+json')
  if (!metaRes.ok) throw mapStatus(metaRes, false)
  let meta: { title?: unknown; changed_files?: unknown; private?: unknown; base?: { repo?: { private?: unknown } } }
  try {
    meta = (await metaRes.json()) as typeof meta
  } catch {
    throw new HttpError(502, 'GitHub returned an unexpected response')
  }
  if (meta.private === true || meta.base?.repo?.private === true) throw new HttpError(404, 'PR not found, or the repo is private')
  const changed = typeof meta.changed_files === 'number' ? meta.changed_files : 0
  if (changed === 0) throw new HttpError(422, 'This PR has no changed files')
  if (changed > MAX_CHANGED_FILES) throw new HttpError(413, `This PR changes more than ${MAX_CHANGED_FILES} files; it is too large to review`)

  const diffRes = await get('application/vnd.github.v3.diff')
  if (!diffRes.ok) throw mapStatus(diffRes, true)
  const tooLarge = new HttpError(413, 'This PR is too large to review (limit 100 KB of diff)')
  const len = parseInt(diffRes.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(len) && len > MAX_DIFF_BYTES) throw tooLarge
  const buf = await diffRes.arrayBuffer()
  if (buf.byteLength > MAX_DIFF_BYTES) throw tooLarge
  return {
    repo: `${parsed.owner}/${parsed.repo}`,
    prNumber: parsed.number,
    title: typeof meta.title === 'string' ? meta.title.slice(0, 300) : `PR #${parsed.number}`,
    diff: new TextDecoder().decode(buf),
  }
}
