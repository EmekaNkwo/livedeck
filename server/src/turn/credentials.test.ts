import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createTurnProvider, hasRelay, parseIceServers, readTurnConfig } from './credentials'

describe('readTurnConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(readTurnConfig({})).toBeNull()
    expect(readTurnConfig({ TURN_URLS: 'turn:x' })).toBeNull()
  })

  it('prefers Cloudflare and clamps the TTL', () => {
    expect(
      readTurnConfig({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't', TURN_TTL_SECONDS: '99999' }),
    ).toEqual({ kind: 'cloudflare', keyId: 'k', apiToken: 't', ttlSeconds: 7200 })
    expect(readTurnConfig({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't', TURN_TTL_SECONDS: '5' })).toMatchObject({ ttlSeconds: 600 })
  })

  it('reads a static coturn configuration', () => {
    expect(
      readTurnConfig({ TURN_URLS: 'turn:t.example.com:3478, turns:t.example.com:5349, junk', TURN_STATIC_AUTH_SECRET: 's' }),
    ).toEqual({ kind: 'static', urls: ['turn:t.example.com:3478', 'turns:t.example.com:5349'], secret: 's', ttlSeconds: 3600 })
  })
})

describe('static provider', () => {
  it('issues a distinct, HMAC-signed, expiring credential per call', async () => {
    const provider = createTurnProvider(
      { kind: 'static', urls: ['turn:t:3478'], secret: 'shh', ttlSeconds: 600 },
      { now: () => 1_000_000 },
    )
    const a = await provider.issue()
    const b = await provider.issue()
    const server = a.iceServers[0]
    expect(server?.username?.startsWith('1600:')).toBe(true)
    expect(server?.credential).toBe(createHmac('sha1', 'shh').update(server?.username ?? '').digest('base64'))
    expect(a.iceServers[0]?.username).not.toBe(b.iceServers[0]?.username)
    expect(a.expiresAt).toBe(1_600_000)
    expect(hasRelay(a.iceServers)).toBe(true)
  })
})

describe('cloudflare provider', () => {
  it('mints with the token and never caches across sessions', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ iceServers: { urls: ['turn:cf:3478'], username: 'u', credential: 'c' } }), { status: 200 }),
    )
    const provider = createTurnProvider(
      { kind: 'cloudflare', keyId: 'key', apiToken: 'tok', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 },
    )
    await provider.issue()
    await provider.issue()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/keys/key/credentials/generate-ice-servers')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 3600 })
  })

  it('explains auth and key-id failures', async () => {
    const make = (status: number) =>
      createTurnProvider(
        { kind: 'cloudflare', keyId: 'key', apiToken: 'tok', ttlSeconds: 3600 },
        { fetchImpl: (async () => new Response('nope', { status })) as unknown as typeof fetch },
      )
    await expect(make(403).issue()).rejects.toThrow(/CLOUDFLARE_TURN_API_TOKEN/)
    await expect(make(404).issue()).rejects.toThrow(/CLOUDFLARE_TURN_KEY_ID/)
  })
})

describe('parseIceServers', () => {
  it('accepts object or array forms and rejects empty', () => {
    expect(parseIceServers({ iceServers: { urls: 'turn:a' } })).toEqual([{ urls: ['turn:a'] }])
    expect(parseIceServers({ iceServers: [{ urls: ['stun:a'], username: 'u', credential: 'c' }] })).toEqual([
      { urls: ['stun:a'], username: 'u', credential: 'c' },
    ])
    expect(() => parseIceServers({ iceServers: [] })).toThrow()
    expect(() => parseIceServers(null)).toThrow()
  })
})
