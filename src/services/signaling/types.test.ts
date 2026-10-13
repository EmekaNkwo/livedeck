import { describe, expect, it } from 'vitest'
import type { SignalEnvelope } from '@/types/peer'
import { decodePayload, encodePayload, parseEnvelope } from './types'

/**
 * Signaling payload validation.
 *
 * Pasted connection codes are untrusted clipboard input and the single most
 * likely thing a user gets wrong — truncated, from the wrong direction, or not
 * a LiveDeck code at all. Every one of those has to produce a specific,
 * actionable message rather than reaching `setRemoteDescription` and failing
 * with a DOMException.
 */

const sdp = [
  'v=0',
  'o=- 123 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=candidate:1 1 udp 2113937151 192.168.1.5 50000 typ host',
].join('\r\n')

const envelope: SignalEnvelope = {
  v: 1,
  kind: 'offer',
  peerId: 'peer_abc',
  sessionId: 'abc123',
  sdp,
  label: 'Host',
  createdAt: 1_700_000_000_000,
}

describe('encode and decode', () => {
  it('round-trips an envelope', () => {
    const code = encodePayload(envelope)
    const result = parseEnvelope(code)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.envelope).toEqual(envelope)
  })

  it('produces a single-line, prefixed payload', () => {
    const code = encodePayload(envelope)
    // Raw multi-line SDP gets mangled by chat clients and email, so the code
    // must survive being pasted anywhere.
    expect(code.startsWith('LD1:')).toBe(true)
    expect(code).not.toContain('\n')
  })

  it('survives non-ASCII in the label', () => {
    const unicode = { ...envelope, label: 'Café — 日本語 🎥' }
    const result = parseEnvelope(encodePayload(unicode))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.envelope.label).toBe(unicode.label)
  })

  it('accepts raw JSON as a fallback for a hand-unwrapped payload', () => {
    const result = parseEnvelope(JSON.stringify(envelope))
    expect(result.ok).toBe(true)
  })

  it('passes through text without the prefix unchanged', () => {
    expect(decodePayload('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseEnvelope validation', () => {
  it('rejects empty input with a prompt to paste', () => {
    const result = parseEnvelope('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/paste/i)
  })

  it('rejects text that is not a LiveDeck code', () => {
    const result = parseEnvelope('hello world, this is not a code')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/does not look like/i)
  })

  it('rejects a payload from an incompatible version', () => {
    const result = parseEnvelope(JSON.stringify({ ...envelope, v: 99 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/incompatible version/i)
  })

  it('rejects a truncated SDP', () => {
    // The most common real failure: the user copied only part of the code.
    const result = parseEnvelope(
      JSON.stringify({ ...envelope, sdp: 'o=- 123 2 IN IP4 127.0.0.1' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/truncated/i)
  })

  it('rejects a missing SDP', () => {
    const result = parseEnvelope(JSON.stringify({ ...envelope, sdp: undefined }))
    expect(result.ok).toBe(false)
  })

  it('rejects a payload with no peer identifier', () => {
    const result = parseEnvelope(JSON.stringify({ ...envelope, peerId: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/peer identifier/i)
  })

  it('rejects an unknown kind', () => {
    const result = parseEnvelope(JSON.stringify({ ...envelope, kind: 'candidate' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/offer or an answer/i)
  })

  it('rejects a non-object payload', () => {
    const result = parseEnvelope(JSON.stringify('just a string'))
    expect(result.ok).toBe(false)
  })
})

describe('direction checking', () => {
  it('tells the user when they pasted an answer where an offer belongs', () => {
    const answer = encodePayload({ ...envelope, kind: 'answer' })
    const result = parseEnvelope(answer, 'offer')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/That is an answer code/i)
  })

  it('tells the user when they pasted an offer where an answer belongs', () => {
    const result = parseEnvelope(encodePayload(envelope), 'answer')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/That is an offer code/i)
  })

  it('accepts the expected direction', () => {
    expect(parseEnvelope(encodePayload(envelope), 'offer').ok).toBe(true)
    const answer = encodePayload({ ...envelope, kind: 'answer' })
    expect(parseEnvelope(answer, 'answer').ok).toBe(true)
  })
})

describe('field defaults', () => {
  it('supplies safe defaults for optional metadata', () => {
    const result = parseEnvelope(
      JSON.stringify({ v: 1, kind: 'offer', peerId: 'peer_x', sdp }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.sessionId).toBe('')
      expect(result.envelope.label).toBe('Peer')
      expect(typeof result.envelope.createdAt).toBe('number')
    }
  })
})
