import type { Env } from './types'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return json({ ok: true, githubToken: Boolean(env.GITHUB_TOKEN) })
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
  return env.ASSETS.fetch(req)
}
