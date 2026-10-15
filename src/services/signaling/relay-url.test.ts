import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEV_RELAY_PORT, defaultRelayUrl, resolveRelayUrl } from './relay-url'

describe('resolveRelayUrl', () => {
  // The developer's own .env may point at a deployed server; these tests
  // describe the fallback, so the variable is cleared for them.
  beforeEach(() => vi.stubEnv('VITE_SIGNALING_URL', ''))
  afterEach(() => vi.unstubAllEnvs())

  it('prefers a configured address', () => {
    expect(resolveRelayUrl('wss://media.example.com')).toBe('wss://media.example.com')
    expect(resolveRelayUrl('  wss://media.example.com  ')).toBe('wss://media.example.com')
  })

  it('falls back to the default when blank', () => {
    expect(resolveRelayUrl('')).toBe(defaultRelayUrl())
  })

  it('assumes the dev server port when the page has a port', () => {
    // jsdom serves tests from http://localhost:3000.
    expect(defaultRelayUrl()).toBe(`ws://localhost:${DEV_RELAY_PORT}`)
  })
})
