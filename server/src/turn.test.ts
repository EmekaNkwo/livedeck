import { describe, expect, it, vi } from 'vitest'
import {
  createTurnProvider,
  DEFAULT_TTL_SECONDS,
  hasRelay,
  parseIceServers,
  readTurnConfig,
} from './turn'

/**
 * SCOPE: this drives a fake `fetch`. It proves the caching, parsing and
 * failure behaviour of the credential provider — not that Cloudflare's API
 * responds, which no unit test can.
 *
 * The caching assertions matter more than they look: without them a 12-guest
 * room becomes 12 API calls per join round, and that is invisible locally
 * where rooms have one guest.
 */

const GRANT = {
  iceServers: {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ],
    username: 'g0a1b2c3',
    credential: 'c3JldA==',
  },
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('readTurnConfig', () => {
  it('returns null when either credential is missing', () => {
    expect(readTurnConfig({})).toBeNull()
    expect(readTurnConfig({ CLOUDFLARE_TURN_KEY_ID: 'key' })).toBeNull()
    expect(readTurnConfig({ CLOUDFLARE_TURN_API_TOKEN: 'token' })).toBeNull()
  })

  it('reads both values and defaults the ttl', () => {
    const config = readTurnConfig({
      CLOUDFLARE_TURN_KEY_ID: ' key ',
      CLOUDFLARE_TURN_API_TOKEN: ' token ',
    })
    expect(config).toEqual({ keyId: 'key', apiToken: 'token', ttlSeconds: DEFAULT_TTL_SECONDS })
  })

  it('falls back when the ttl is out of range or not a number', () => {
    for (const ttl of ['30', '999999', 'soon', '']) {
      const config = readTurnConfig({
        CLOUDFLARE_TURN_KEY_ID: 'key',
        CLOUDFLARE_TURN_API_TOKEN: 'token',
        CLOUDFLARE_TURN_TTL_SECONDS: ttl,
      })
      expect(config?.ttlSeconds).toBe(DEFAULT_TTL_SECONDS)
    }
  })

  it('honours a ttl inside the accepted range', () => {
    const config = readTurnConfig({
      CLOUDFLARE_TURN_KEY_ID: 'key',
      CLOUDFLARE_TURN_API_TOKEN: 'token',
      CLOUDFLARE_TURN_TTL_SECONDS: '3600',
    })
    expect(config?.ttlSeconds).toBe(3600)
  })
})

describe('parseIceServers', () => {
  it('accepts the documented single-object shape', () => {
    expect(parseIceServers(GRANT)).toEqual([
      {
        urls: GRANT.iceServers.urls,
        username: 'g0a1b2c3',
        credential: 'c3JldA==',
      },
    ])
  })

  it('accepts an array of servers, in case the shape changes', () => {
    const servers = parseIceServers({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' },
      ],
    })
    expect(servers).toHaveLength(2)
    // A bare string URL is legal per the WebRTC spec and is normalized.
    expect(servers[1]).toEqual({
      urls: ['turn:turn.cloudflare.com:3478'],
      username: 'u',
      credential: 'c',
    })
  })

  it('throws rather than returning an empty list', () => {
    // An empty list would silently reinstate the STUN-only failure this
    // whole feature exists to remove, so it must be loud.
    expect(() => parseIceServers({ iceServers: [] })).toThrow(/no usable ICE servers/)
    expect(() => parseIceServers({})).toThrow(/no usable ICE servers/)
    expect(() => parseIceServers(null)).toThrow(/not a JSON object/)
  })

  it('omits absent credentials instead of emitting empty strings', () => {
    const [server] = parseIceServers({ iceServers: { urls: ['stun:a:3478'] } })
    expect(server).not.toHaveProperty('username')
    expect(server).not.toHaveProperty('credential')
  })
})

describe('hasRelay', () => {
  it('distinguishes a relay grant from a STUN-only one', () => {
    expect(hasRelay(parseIceServers(GRANT))).toBe(true)
    expect(hasRelay([{ urls: ['stun:stun.cloudflare.com:3478'] }])).toBe(false)
  })
})

describe('createTurnProvider', () => {
  it('posts the ttl to the key-scoped endpoint with a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GRANT))
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    const grant = await provider.get()
    expect(grant.iceServers[0]?.username).toBe('g0a1b2c3')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/KEY/credentials/generate-ice-servers',
    )
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer TOKEN')
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 3600 })
  })

  it('caches a grant instead of minting per request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GRANT))
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await provider.get()
    await provider.get()
    await provider.get()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent requests on a cold cache', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GRANT))
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    // A room full of guests joining at once must not be a burst of API calls.
    await Promise.all([provider.get(), provider.get(), provider.get()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('re-mints once the grant nears expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GRANT))
    let clock = 1_000_000
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock },
    )

    await provider.get()
    // Inside the ttl but within the 10-minute refresh margin: a credential
    // handed out here would expire mid-allocation.
    clock += 3595 * 1000
    await provider.get()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('names the token on a 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await expect(provider.get()).rejects.toThrow(/CLOUDFLARE_TURN_API_TOKEN/)
  })

  it('names the key id on a 404', async () => {
    /*
     * Verified against the live API: a nonexistent key id returns
     * `404 {"error":"cannot find specified key"}`, not a 403. Without this
     * branch the two setup mistakes — wrong key id, wrong token — are
     * indistinguishable, and both present downstream as "no relay candidates".
     */
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"cannot find specified key"}', { status: 404 }),
      )
    const provider = createTurnProvider(
      { keyId: 'WRONG', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await expect(provider.get()).rejects.toThrow(/CLOUDFLARE_TURN_KEY_ID/)
  })

  it('never leaks the api token into an error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'super-secret-token', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await expect(provider.get()).rejects.toThrow(
      expect.not.stringContaining('super-secret-token') as unknown as string,
    )
  })

  it('serves a still-valid stale grant when a refresh fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(GRANT))
      .mockRejectedValueOnce(new Error('network down'))
    let clock = 1_000_000
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock },
    )

    const first = await provider.get()
    clock += 3595 * 1000
    // Within the refresh margin but not yet expired: the old grant still
    // allocates, so a brief Cloudflare outage is not an outage for us.
    const second = await provider.get()
    expect(second.expiresAt).toBe(first.expiresAt)
  })

  it('propagates the failure when there is no usable cache', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const provider = createTurnProvider(
      { keyId: 'KEY', apiToken: 'TOKEN', ttlSeconds: 3600 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    await expect(provider.get()).rejects.toThrow(/network down/)
    // A failed mint must not latch: the next request retries.
    fetchImpl.mockResolvedValue(jsonResponse(GRANT))
    await expect(provider.get()).resolves.toMatchObject({ iceServers: expect.any(Array) })
  })
})
