import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTurnRoute } from './turn-route'
import type { TurnProvider } from './turn'

/**
 * SCOPE: drives the route over a real HTTP server, because the behaviour under
 * test is HTTP behaviour — status codes a browser acts on and CORS headers a
 * browser enforces. A hand-rolled request/response double would assert our own
 * assumptions about Node rather than the wire.
 */

let server: Server | null = null

afterEach(async () => {
  if (!server) return
  const current = server
  server = null
  await new Promise<void>((resolve) => current.close(() => resolve()))
})

async function listen(
  provider: TurnProvider | null,
  allowedOrigins: string[] = [],
): Promise<string> {
  const route = createTurnRoute({ provider, allowedOrigins, log: () => {} })
  server = createServer((request, response) => {
    if (route.handle(request, response)) return
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('No port')
  return `http://127.0.0.1:${address.port}`
}

const GRANT = {
  iceServers: [
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'user',
      credential: 'secret',
    },
  ],
  expiresAt: 1_700_000_000_000,
}

describe('createTurnRoute', () => {
  it('serves the grant as JSON', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) })
    const response = await fetch(`${base}/ice-servers`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ configured: true, ...GRANT })
    // Credentials expire; a shared cache holding them would hand one browser
    // another's lapsed grant.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 200 with an empty list when TURN is not configured', async () => {
    const base = await listen(null)
    const response = await fetch(`${base}/ice-servers`)

    // Deliberately not a 4xx: running without TURN is the default deployment,
    // and the studio must not report the default as a fault.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ configured: false, iceServers: [] })
  })

  it('answers 502 with the cause when minting fails', async () => {
    const base = await listen({
      get: vi.fn().mockRejectedValue(new Error('Cloudflare TURN API returned 403.')),
    })
    const response = await fetch(`${base}/ice-servers`)

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string; iceServers: unknown[] }
    expect(body.error).toContain('403')
    expect(body.iceServers).toEqual([])
  })

  it('echoes an allowed origin and withholds the header from others', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) }, [
      'http://localhost:5173',
    ])

    const allowed = await fetch(`${base}/ice-servers`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const refused = await fetch(`${base}/ice-servers`, {
      headers: { origin: 'http://evil.example' },
    })
    // The body is still written — withholding the header is what stops the
    // page reading it, and that is the browser's job to enforce.
    expect(refused.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('normalizes a trailing slash in the allow-list', async () => {
    // The mistake an operator makes every time: pasting the studio address out
    // of a browser address bar, which carries a trailing slash no browser ever
    // sends in an Origin header.
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) }, [
      'http://localhost:5173/',
    ])
    const response = await fetch(`${base}/ice-servers`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('reflects any origin when the allow-list is empty', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) })
    const response = await fetch(`${base}/ice-servers`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('answers a preflight', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) })
    const response = await fetch(`${base}/ice-servers`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('rejects a non-GET method', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) })
    const response = await fetch(`${base}/ice-servers`, { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('declines other paths so the next handler sees them', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) })
    expect((await fetch(`${base}/healthz`)).status).toBe(404)
  })

  it('ignores a query string on its own path', async () => {
    const base = await listen({ get: vi.fn().mockResolvedValue(GRANT) })
    expect((await fetch(`${base}/ice-servers?cachebust=1`)).status).toBe(200)
  })
})
