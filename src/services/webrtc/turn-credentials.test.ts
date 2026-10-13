import { describe, expect, it, vi } from 'vitest'
import { createTurnCredentialSource, parseIceServers } from './turn-credentials'

/**
 * SCOPE: drives a fake `fetch`. The property under test is that losing TURN
 * never breaks a handshake — every failure path must resolve to an empty list
 * and report once, because throwing here would abort connections that never
 * needed a relay.
 */

const PAYLOAD = {
  configured: true,
  iceServers: [
    {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'user',
      credential: 'c3Vw:ZXI=',
    },
  ],
  expiresAt: 0,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseIceServers', () => {
  it('keeps credentials verbatim, colons included', () => {
    // The reason these bypass the `turn:host:port|user:pass` settings format:
    // that parser splits the credential pair on the first colon and would
    // truncate a generated secret into a 401.
    const [server] = parseIceServers(PAYLOAD.iceServers)
    expect(server?.credential).toBe('c3Vw:ZXI=')
  })

  it('drops entries without a recognizable ICE scheme', () => {
    const servers = parseIceServers([
      { urls: ['https://turn.example.com'] },
      { urls: ['turn:ok.example:3478'] },
      { urls: [] },
      null,
      'nonsense',
    ])
    expect(servers).toEqual([{ urls: ['turn:ok.example:3478'] }])
  })

  it('returns an empty list for a non-array payload', () => {
    expect(parseIceServers(undefined)).toEqual([])
    expect(parseIceServers({ urls: ['turn:a:3478'] })).toEqual([])
  })
})

describe('createTurnCredentialSource', () => {
  it('fetches and returns the relay grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD))
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const servers = await source.resolve()
    expect(servers[0]?.username).toBe('user')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://relay.test/ice-servers',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('does nothing at all without an endpoint', async () => {
    const fetchImpl = vi.fn()
    const source = createTurnCredentialSource({
      endpoint: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(source.resolve()).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('caches until the grant nears expiry', async () => {
    let clock = 1_000_000
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...PAYLOAD, expiresAt: clock + 3600_000 }))
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    })

    await source.resolve()
    await source.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Inside the 5-minute refresh margin, so the cached grant is too close to
    // expiry to hand to a new connection.
    clock += 3598_000
    await source.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('shares one request between simultaneous callers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(PAYLOAD))
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await Promise.all([source.resolve(), source.resolve(), source.resolve()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the relay has no TURN key', async () => {
    const onError = vi.fn()
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ configured: false, iceServers: [] }),
        ) as unknown as typeof fetch,
      onError,
    })

    await expect(source.resolve()).resolves.toEqual([])
    // STUN-only is the project's default, not a fault to toast about.
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a relay error and degrades to STUN rather than throwing', async () => {
    const onError = vi.fn()
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'TURN credentials could not be issued: 403' }, 502),
        ) as unknown as typeof fetch,
      onError,
    })

    await expect(source.resolve()).resolves.toEqual([])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('403'))
  })

  it('reports a network failure without throwing', async () => {
    const onError = vi.fn()
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: vi.fn().mockRejectedValue(new Error('Failed to fetch')) as unknown as typeof fetch,
      onError,
    })

    await expect(source.resolve()).resolves.toEqual([])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'))
  })

  it('reports a given failure once, not per handshake', async () => {
    const onError = vi.fn()
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: vi.fn().mockRejectedValue(new Error('Failed to fetch')) as unknown as typeof fetch,
      onError,
    })

    // Credentials are resolved per offer and per answer, so a down relay would
    // otherwise raise one toast per guest per attempt.
    await source.resolve()
    await source.resolve()
    await source.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('reports again after a recovery, so a second outage is not silenced', async () => {
    const onError = vi.fn()
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(PAYLOAD))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError,
      // Expiry in the past, so each resolve re-fetches instead of caching.
      now: () => 10_000_000,
    })

    await source.resolve()
    await source.resolve()
    await source.resolve()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('warns when TURN is configured but the list is unusable', async () => {
    const onError = vi.fn()
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ configured: true, iceServers: [] }),
        ) as unknown as typeof fetch,
      onError,
    })

    await expect(source.resolve()).resolves.toEqual([])
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('no usable ICE servers'))
  })

  it('drops the cache on reset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...PAYLOAD, expiresAt: 9e15 }))
    const source = createTurnCredentialSource({
      endpoint: 'http://relay.test/ice-servers',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await source.resolve()
    source.reset()
    await source.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
