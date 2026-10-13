import { afterEach, describe, expect, it, vi } from 'vitest'
import { ICE_SERVERS_PATH, iceServersUrl, resolveRelayUrl } from './relay-url'

/**
 * SCOPE: the TURN endpoint is *derived* from the relay address rather than
 * configured separately, so this covers the derivation. A mismatch between the
 * two would present to an operator as "TURN is configured but no relay
 * candidates appear" — a failure with no visible cause.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('iceServersUrl', () => {
  it('swaps a ws scheme for http', () => {
    expect(iceServersUrl('ws://localhost:3001')).toBe(`http://localhost:3001${ICE_SERVERS_PATH}`)
  })

  it('swaps wss for https, keeping the secure context', () => {
    expect(iceServersUrl('wss://signal.example.com')).toBe(
      `https://signal.example.com${ICE_SERVERS_PATH}`,
    )
  })

  it('replaces an existing path rather than appending to it', () => {
    // A relay address commonly carries `/signal`; appending would ask for
    // `/signal/ice-servers`, which the relay does not serve.
    expect(iceServersUrl('wss://signal.example.com/signal')).toBe(
      `https://signal.example.com${ICE_SERVERS_PATH}`,
    )
  })

  it('drops a query string and fragment', () => {
    expect(iceServersUrl('ws://localhost:3001/signal?token=x#y')).toBe(
      `http://localhost:3001${ICE_SERVERS_PATH}`,
    )
  })

  it('honours an explicit override', () => {
    vi.stubEnv('VITE_ICE_SERVERS_URL', 'https://turn.example.com/creds')
    expect(iceServersUrl('ws://localhost:3001')).toBe('https://turn.example.com/creds')
  })

  it('returns empty for an unparseable address instead of guessing', () => {
    expect(iceServersUrl('not a url')).toBe('')
  })

  it('falls back to the resolved default when nothing is configured', () => {
    // Whatever the relay resolves to is where credentials live, because they
    // are the same process.
    const expected = resolveRelayUrl('')
    if (!expected) {
      expect(iceServersUrl('')).toBe('')
      return
    }
    expect(iceServersUrl('')).toContain(ICE_SERVERS_PATH)
  })
})
