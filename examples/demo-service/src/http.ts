export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`request to ${url} failed with status ${status}`)
    this.name = 'HttpError'
  }
}

const DEFAULT_TIMEOUT_MS = 5_000

/** GET a JSON document. Times out, and turns a non-2xx response into an HttpError. */
export async function getJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn: typeof fetch = fetch): Promise<T> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
  if (!res.ok) throw new HttpError(res.status, url)
  return (await res.json()) as T
}
