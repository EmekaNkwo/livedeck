import type { SignalEnvelope } from '@/types/peer'

/**
 * The signaling seam.
 *
 * Every transport the studio could ever use — manual copy/paste, a WebSocket
 * service, a QR code, BroadcastChannel between tabs — implements this one
 * interface. The studio UI and the PeerConnectionManager only know about this
 * type, so a networked adapter can be dropped in later without touching either.
 *
 * `ManualSignalingAdapter` is the only adapter that establishes *real* remote
 * connections without a backend. There is deliberately no mock adapter that
 * pretends to connect two devices: an in-memory bus cannot carry SDP between
 * browsers, and presenting one as if it could would be a lie.
 */

export type SignalingTransportId = 'manual' | 'broadcast-channel' | 'external'

export type SignalingCapabilities = {
  id: SignalingTransportId
  label: string
  /** True when the transport can reach a *different device*. */
  crossDevice: boolean
  /** True when the user must move payloads by hand. */
  requiresManualExchange: boolean
  description: string
}

export type SignalingEvents = {
  /** An offer arrived and should be answered. */
  onOffer: (envelope: SignalEnvelope) => void
  /** An answer arrived for an offer we sent. */
  onAnswer: (envelope: SignalEnvelope) => void
  onError: (message: string) => void
}

export interface SignalingAdapter {
  readonly capabilities: SignalingCapabilities

  connect(events: Partial<SignalingEvents>): Promise<void>

  /**
   * Publish a local description to the other side. For manual adapters this
   * means "make it available for the user to copy", not "transmit it".
   */
  publish(envelope: SignalEnvelope): Promise<void>

  /** Feed in a payload received out of band. */
  ingest(raw: string): Promise<void>

  disconnect(): void
}

/** Validation result for a pasted signaling payload. */
export type ParseResult =
  | { ok: true; envelope: SignalEnvelope }
  | { ok: false; error: string }

/**
 * Parse and validate a pasted envelope.
 *
 * Pasted text is untrusted input from the system clipboard and is the single
 * most likely thing a user gets wrong (truncated copy, wrong direction,
 * pasting an offer where an answer belongs), so this validates structurally
 * before anything reaches `setRemoteDescription`.
 */
export function parseEnvelope(raw: string, expect?: 'offer' | 'answer'): ParseResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: 'Paste the connection code before continuing.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(decodePayload(text))
  } catch {
    return {
      ok: false,
      error: 'That does not look like a LiveDeck connection code. Copy the whole code and retry.',
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'The connection code is malformed.' }
  }
  const candidate = parsed as Partial<SignalEnvelope>

  if (candidate.v !== 1) {
    return {
      ok: false,
      error: 'This connection code was produced by an incompatible version of LiveDeck.',
    }
  }
  if (candidate.kind !== 'offer' && candidate.kind !== 'answer') {
    return { ok: false, error: 'The connection code does not declare whether it is an offer or an answer.' }
  }
  if (expect && candidate.kind !== expect) {
    return {
      ok: false,
      error:
        expect === 'offer'
          ? 'That is an answer code. Paste the host’s offer code here instead.'
          : 'That is an offer code. Paste the guest’s answer code here instead.',
    }
  }
  if (typeof candidate.sdp !== 'string' || !candidate.sdp.includes('v=0')) {
    return {
      ok: false,
      error: 'The session description is missing or truncated. Copy the entire code and retry.',
    }
  }
  if (typeof candidate.peerId !== 'string' || !candidate.peerId) {
    return { ok: false, error: 'The connection code is missing a peer identifier.' }
  }

  return {
    ok: true,
    envelope: {
      v: 1,
      kind: candidate.kind,
      peerId: candidate.peerId,
      sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : '',
      sdp: candidate.sdp,
      label: typeof candidate.label === 'string' ? candidate.label : 'Peer',
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    },
  }
}

/**
 * Encode an envelope for transport by hand.
 *
 * Base64 keeps the payload on one line and makes it survive chat clients and
 * email, which happily reflow and mangle raw multi-line SDP. The `LD1:` prefix
 * lets us give a precise error when someone pastes the wrong thing entirely.
 */
export function encodePayload(envelope: SignalEnvelope): string {
  const json = JSON.stringify(envelope)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `LD1:${btoa(binary)}`
}

export function decodePayload(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('LD1:')) {
    // Tolerate a raw JSON paste too — some users will unwrap it themselves.
    return trimmed
  }
  const binary = atob(trimmed.slice(4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
