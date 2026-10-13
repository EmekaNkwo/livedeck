import { describe, expect, it, vi } from 'vitest'
import type { SignalEnvelope } from '@/types/peer'
import {
  buildAnswerLink,
  buildInviteLink,
  decodeSignalToken,
  encodeSignalToken,
  extractSignalFromText,
  readSignalFromFragment,
} from './invite-link'

/**
 * Invite links.
 *
 * The critical property is that a link survives a round trip intact — a
 * mangled SDP produces a connection that fails for reasons the user cannot
 * diagnose. The payload also has to stay in the *fragment*, because that is
 * what keeps it from reaching a server.
 */

const sdp = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
  'a=candidate:1 1 udp 2113937151 192.168.1.5 53421 typ host',
  'a=candidate:2 1 udp 1677729535 203.0.113.9 53422 typ srflx',
  'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89',
].join('\r\n')

const offer: SignalEnvelope = {
  v: 1,
  kind: 'offer',
  peerId: 'peer_abc123',
  sessionId: 'sunday-service',
  sdp,
  label: 'Host',
  createdAt: 1_700_000_000_000,
}

const answer: SignalEnvelope = { ...offer, kind: 'answer', label: 'Ana' }

describe('token round trip', () => {
  it('encodes and decodes an envelope losslessly', async () => {
    const token = await encodeSignalToken(offer)
    const json = await decodeSignalToken(token)
    expect(json).not.toBeNull()
    expect(JSON.parse(json!)).toEqual(offer)
  })

  it('produces a URL-safe token with no padding', async () => {
    const token = await encodeSignalToken(offer)
    // base64url: no +, /, or = — all of which would need escaping in a URL.
    expect(token).not.toMatch(/[+/=]/)
    expect(token).toMatch(/^LD1z?:/)
  })

  it('compresses, because an SDP with candidates is large and repetitive', async () => {
    const token = await encodeSignalToken(offer)
    // jsdom provides CompressionStream in recent versions; assert the win only
    // when the browser actually offered it.
    if (token.startsWith('LD1z:')) {
      const uncompressedSize = JSON.stringify(offer).length
      expect(token.length).toBeLessThan(uncompressedSize)
    } else {
      expect(token.startsWith('LD1:')).toBe(true)
    }
  })

  it('survives non-ASCII in the label', async () => {
    const unicode = { ...offer, label: 'Café — 日本語 🎥' }
    const json = await decodeSignalToken(await encodeSignalToken(unicode))
    expect(JSON.parse(json!).label).toBe(unicode.label)
  })

  it('rejects a malformed token rather than throwing', async () => {
    expect(await decodeSignalToken('')).toBeNull()
    expect(await decodeSignalToken('not-a-token')).toBeNull()
    expect(await decodeSignalToken('LD1:')).toBeNull()
    expect(await decodeSignalToken('LD1:!!!not-base64!!!')).toBeNull()
    expect(await decodeSignalToken('LDX:abcd')).toBeNull()
  })

  it('falls back to an uncompressed token when compression is unavailable', async () => {
    const original = globalThis.CompressionStream
    // @ts-expect-error deliberately removing the API
    delete globalThis.CompressionStream
    try {
      const token = await encodeSignalToken(offer)
      expect(token.startsWith('LD1:')).toBe(true)
      const json = await decodeSignalToken(token)
      expect(JSON.parse(json!)).toEqual(offer)
    } finally {
      globalThis.CompressionStream = original
    }
  })
})

describe('buildInviteLink', () => {
  it('puts the payload in the fragment, never the query', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'sunday-service',
      role: 'push',
      origin: 'https://example.com',
    })

    const url = new URL(link.url)
    expect(url.pathname).toBe('/push/sunday-service')
    // The fragment is the whole point: browsers never send it to a server.
    expect(url.hash.startsWith('#i=')).toBe(true)
    expect(url.search).toBe('')
  })

  it('carries guest parameters in the query', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'room1',
      role: 'push',
      origin: 'https://example.com',
      params: { label: 'Ana', muted: '' },
    })
    const url = new URL(link.url)
    expect(url.searchParams.get('label')).toBe('Ana')
    expect(url.searchParams.has('muted')).toBe(true)
    expect(url.hash.startsWith('#i=')).toBe(true)
  })

  it('normalizes a trailing slash on the origin', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'room1',
      role: 'push',
      origin: 'https://example.com/',
    })
    expect(link.url).not.toContain('com//')
  })

  it('escapes a room name that needs it', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'a b',
      role: 'push',
      origin: 'https://example.com',
    })
    expect(link.url).toContain('/push/a%20b')
  })

  it('reports its own length and compression, for the UI to show', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'room1',
      role: 'push',
      origin: 'https://example.com',
    })
    expect(link.length).toBe(link.url.length)
    expect(typeof link.compressed).toBe('boolean')
  })
})

describe('buildAnswerLink', () => {
  it('points back at the director room with an answer fragment', async () => {
    const link = await buildAnswerLink({
      envelope: answer,
      room: 'sunday-service',
      origin: 'https://example.com',
    })
    const url = new URL(link.url)
    expect(url.pathname).toBe('/director/sunday-service')
    expect(url.hash.startsWith('#a=')).toBe(true)
  })
})

describe('readSignalFromFragment', () => {
  it('reads an offer back out of a built link', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'room1',
      role: 'push',
      origin: 'https://example.com',
    })
    const hash = new URL(link.url).hash
    const result = await readSignalFromFragment(hash)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.signal.kind).toBe('offer')
      expect(result.signal.envelope.sdp).toBe(sdp)
      expect(result.signal.envelope.peerId).toBe('peer_abc123')
    }
  })

  it('reads an answer back out of an answer link', async () => {
    const link = await buildAnswerLink({
      envelope: answer,
      room: 'room1',
      origin: 'https://example.com',
    })
    const result = await readSignalFromFragment(new URL(link.url).hash)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.signal.kind).toBe('answer')
  })

  it('reports no signal for an empty or unrelated fragment', async () => {
    expect((await readSignalFromFragment('')).status).toBe('none')
    expect((await readSignalFromFragment('#')).status).toBe('none')
    expect((await readSignalFromFragment('#section=about')).status).toBe('none')
  })

  it('explains a truncated link, the most likely real failure', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'room1',
      role: 'push',
      origin: 'https://example.com',
    })
    const hash = new URL(link.url).hash
    const truncated = hash.slice(0, Math.floor(hash.length * 0.6))

    const result = await readSignalFromFragment(truncated)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.error).toMatch(/truncated|could not be read/i)
  })

  it('rejects a fragment whose decoded payload is not an envelope', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const token = `LD1:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

    const result = await readSignalFromFragment(`#i=${token}`)
    expect(result.status).toBe('invalid')
  })

  it('enforces direction: an answer in an offer slot is rejected', async () => {
    const token = await encodeSignalToken(answer)
    const result = await readSignalFromFragment(`#i=${token}`)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.error).toMatch(/answer code/i)
  })
})

describe('extractSignalFromText', () => {
  it('accepts a full link', async () => {
    const link = await buildAnswerLink({
      envelope: answer,
      room: 'room1',
      origin: 'https://example.com',
    })
    const result = await extractSignalFromText(link.url, 'answer')
    expect(result.status).toBe('ok')
  })

  it('accepts a bare token', async () => {
    const token = await encodeSignalToken(answer)
    const result = await extractSignalFromText(token, 'answer')
    expect(result.status).toBe('ok')
  })

  it('accepts raw JSON, for anyone who unwrapped it by hand', async () => {
    const result = await extractSignalFromText(JSON.stringify(answer), 'answer')
    expect(result.status).toBe('ok')
  })

  it('tolerates surrounding whitespace from a sloppy paste', async () => {
    const token = await encodeSignalToken(answer)
    const result = await extractSignalFromText(`\n  ${token}  \n`, 'answer')
    expect(result.status).toBe('ok')
  })

  it('prompts rather than erroring obscurely on empty input', async () => {
    const result = await extractSignalFromText('   ')
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.error).toMatch(/paste/i)
  })

  it('rejects arbitrary text with a readable message', async () => {
    const result = await extractSignalFromText('hey can you send me the link again')
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.error).toMatch(/does not look like/i)
  })

  it('enforces direction on a pasted link', async () => {
    const link = await buildInviteLink({
      envelope: offer,
      room: 'room1',
      role: 'push',
      origin: 'https://example.com',
    })
    const result = await extractSignalFromText(link.url, 'answer')
    expect(result.status).toBe('invalid')
  })
})

describe('link size', () => {
  it('keeps a realistic invite within a workable URL length', async () => {
    // A real offer with a full candidate set. Browsers accept far longer URLs,
    // but a link that cannot be pasted into a chat client is not much use.
    const big: SignalEnvelope = {
      ...offer,
      sdp: [sdp, ...Array.from({ length: 12 }, (_, i) => `a=candidate:${i} 1 udp 1 10.0.0.${i} 500${i} typ host`)].join(
        '\r\n',
      ),
    }
    const link = await buildInviteLink({
      envelope: big,
      room: 'sunday-service',
      role: 'push',
      origin: 'https://livedeck.example.com',
    })
    expect(link.url.length).toBeLessThan(8000)
  })
})

describe('clearSignalFragment', () => {
  it('strips the fragment without adding a history entry', async () => {
    const { clearSignalFragment } = await import('./invite-link')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    clearSignalFragment()
    // replaceState, not pushState: a consumed offer must not be reachable with
    // the back button.
    expect(replaceState).toHaveBeenCalled()
  })
})
