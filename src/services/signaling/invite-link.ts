import type { SignalEnvelope } from '@/types/peer'
import type { RoomRole } from '@/types/room'
import { parseEnvelope } from './types'

/**
 * Invite links — signaling payloads carried in a URL fragment.
 *
 * WHY A LINK AND NOT A BLOB
 * -------------------------
 * VDO.Ninja's entire workflow is "send someone a link". With no backend we
 * cannot match peers by room name, but we *can* put the session description
 * into the link itself, which gets most of the way there: the host sends one
 * URL, the guest opens it, and their browser already has everything it needs to
 * answer. That turns an intimidating wall of base64 into something you can
 * paste into a chat window.
 *
 * WHY THE FRAGMENT SPECIFICALLY
 * -----------------------------
 * The payload lives after `#`. Fragments are **never sent to the server** in an
 * HTTP request — not in the request line, not in logs, not in a `Referer`. So
 * even if this app is hosted on someone else's static host, the offer never
 * reaches them. Putting it in a query string would leak it into access logs.
 *
 * COMPRESSION
 * -----------
 * An SDP with all ICE candidates embedded runs to several kilobytes, and
 * base64 inflates that by a third. SDP is extremely repetitive, so DEFLATE
 * typically takes 60–75% off. `CompressionStream` is used where available, with
 * an uncompressed fallback so the feature degrades instead of breaking.
 */

/** Marker prefixes. `z` denotes a DEFLATE-compressed payload. */
const PLAIN_PREFIX = 'LD1'
const COMPRESSED_PREFIX = 'LD1z'

/** Fragment keys, kept terse because they are user-visible in a URL. */
export const INVITE_FRAGMENT_KEY = 'i'
export const ANSWER_FRAGMENT_KEY = 'a'

export type InviteLink = {
  url: string
  /** Characters in the whole URL — shown so the user knows what to expect. */
  length: number
  compressed: boolean
}

/* ------------------------------------------------------------ base64url */

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  // Chunked so a multi-kilobyte SDP cannot blow the argument limit of
  // String.fromCharCode via spread.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  // Restore the padding btoa stripped.
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/* ---------------------------------------------------------- compression */

function compressionAvailable(): boolean {
  return (
    typeof globalThis.CompressionStream === 'function' &&
    typeof globalThis.DecompressionStream === 'function'
  )
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/* -------------------------------------------------------------- encoding */

/**
 * Encode an envelope into a transportable token.
 * Compresses when the browser supports it, and falls back transparently.
 */
export async function encodeSignalToken(envelope: SignalEnvelope): Promise<string> {
  const json = JSON.stringify(envelope)
  const raw = new TextEncoder().encode(json)

  if (compressionAvailable()) {
    try {
      const packed = await deflate(raw)
      // Only keep the compressed form if it actually won; a pathological input
      // could in principle grow.
      if (packed.length < raw.length) {
        return `${COMPRESSED_PREFIX}:${toBase64Url(packed)}`
      }
    } catch {
      // Fall through to the uncompressed path rather than failing the invite.
    }
  }
  return `${PLAIN_PREFIX}:${toBase64Url(raw)}`
}

/** Decode a token produced by {@link encodeSignalToken}. */
export async function decodeSignalToken(token: string): Promise<string | null> {
  const trimmed = token.trim()
  const separator = trimmed.indexOf(':')
  if (separator === -1) return null

  const prefix = trimmed.slice(0, separator)
  const body = trimmed.slice(separator + 1)
  if (!body) return null

  try {
    const bytes = fromBase64Url(body)
    if (prefix === COMPRESSED_PREFIX) {
      if (!compressionAvailable()) return null
      return new TextDecoder().decode(await inflate(bytes))
    }
    if (prefix === PLAIN_PREFIX) {
      return new TextDecoder().decode(bytes)
    }
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ links */

export type BuildInviteOptions = {
  envelope: SignalEnvelope
  room: string
  /** The role the recipient will open in. */
  role: RoomRole
  /** Origin + base path, e.g. `https://example.com`. */
  origin: string
  /** Extra VDO.Ninja-style query parameters to pre-apply for the guest. */
  params?: Record<string, string>
}

/**
 * Build the link a host sends to a guest.
 *
 * Shape: `{origin}/push/{room}?label=Ana#i={token}`
 *
 * Query parameters configure the guest's experience up front (see
 * `useUrlParameters`); the fragment carries the offer.
 */
export async function buildInviteLink(options: BuildInviteOptions): Promise<InviteLink> {
  const token = await encodeSignalToken(options.envelope)
  const query = new URLSearchParams(options.params ?? {})
  const search = query.toString()
  const origin = options.origin.replace(/\/+$/, '')
  const url =
    `${origin}/${options.role}/${encodeURIComponent(options.room)}` +
    (search ? `?${search}` : '') +
    `#${INVITE_FRAGMENT_KEY}=${token}`

  return {
    url,
    length: url.length,
    compressed: token.startsWith(`${COMPRESSED_PREFIX}:`),
  }
}

/**
 * Build the link a guest sends back with their answer.
 *
 * Returning a *link* rather than a bare code means the host can click it and
 * land in their own control room with the answer already applied, which removes
 * the most error-prone step of manual signaling: pasting into the right box.
 */
export async function buildAnswerLink(options: {
  envelope: SignalEnvelope
  room: string
  origin: string
}): Promise<InviteLink> {
  const token = await encodeSignalToken(options.envelope)
  const origin = options.origin.replace(/\/+$/, '')
  const url = `${origin}/director/${encodeURIComponent(options.room)}#${ANSWER_FRAGMENT_KEY}=${token}`
  return {
    url,
    length: url.length,
    compressed: token.startsWith(`${COMPRESSED_PREFIX}:`),
  }
}

/* ---------------------------------------------------------------- reading */

export type FragmentSignal = {
  kind: 'offer' | 'answer'
  envelope: SignalEnvelope
}

export type FragmentReadResult =
  | { status: 'none' }
  | { status: 'ok'; signal: FragmentSignal }
  | { status: 'invalid'; error: string }

/**
 * Read a signaling payload out of a URL fragment.
 *
 * Tolerates both `#i=token` and a fragment with several `key=value` pairs, and
 * validates the decoded envelope with the same checks as a pasted code — a URL
 * is no more trustworthy than the clipboard.
 */
export async function readSignalFromFragment(hash: string): Promise<FragmentReadResult> {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment) return { status: 'none' }

  const params = new URLSearchParams(fragment)
  const offerToken = params.get(INVITE_FRAGMENT_KEY)
  const answerToken = params.get(ANSWER_FRAGMENT_KEY)
  const token = offerToken ?? answerToken
  if (!token) return { status: 'none' }

  // The fragment key declares the direction; it is not inferred from content.
  const declared = offerToken ? 'offer' : 'answer'

  const TRUNCATED =
    'The connection details in this link could not be read. The link may have been truncated — ' +
    'links are long, so make sure the whole thing was copied.'

  const json = await decodeSignalToken(token)
  if (json === null) return { status: 'invalid', error: TRUNCATED }

  /*
   * Distinguish a damaged link from a valid-but-wrong one.
   *
   * A truncated token often still base64-decodes into partial JSON, which
   * `parseEnvelope` would reject with its generic "that does not look like a
   * connection code" message. For something that arrived as a *link* the far
   * likelier cause is a clipped copy, so say that instead.
   */
  try {
    JSON.parse(json)
  } catch {
    return { status: 'invalid', error: TRUNCATED }
  }

  const parsed = parseEnvelope(json, declared)
  if (!parsed.ok) return { status: 'invalid', error: parsed.error }

  // Guard against a mismatch between the fragment key and the payload.
  if (parsed.envelope.kind !== declared) {
    return {
      status: 'invalid',
      error: 'This link’s contents do not match the kind of link it claims to be.',
    }
  }

  return { status: 'ok', signal: { kind: declared, envelope: parsed.envelope } }
}

/**
 * Remove the signaling payload from the address bar.
 *
 * Done immediately after a fragment is consumed so a reload does not re-apply a
 * stale offer, and so the user is not left looking at a multi-kilobyte URL.
 * `replaceState` keeps it out of the back history too.
 */
export function clearSignalFragment(): void {
  if (typeof window === 'undefined') return
  const { pathname, search } = window.location
  window.history.replaceState(null, '', `${pathname}${search}`)
}

/**
 * Accept whatever the user pasted and extract a signaling envelope.
 *
 * People paste all three of these, so all three are handled rather than
 * demanding one exact shape:
 *  - a full link  — `https://host/director/room#a=LD1z:...`
 *  - a bare token — `LD1z:...`
 *  - raw JSON     — for anyone who unwrapped it themselves
 *
 * Validated exactly like a pasted code, because none of these are trustworthy.
 */
export async function extractSignalFromText(
  text: string,
  expect?: 'offer' | 'answer',
): Promise<FragmentReadResult> {
  const trimmed = text.trim()
  if (!trimmed) {
    return { status: 'invalid', error: 'Paste the link or code before continuing.' }
  }

  // A link: pull the payload out of its fragment.
  const hashIndex = trimmed.indexOf('#')
  if (hashIndex !== -1) {
    const result = await readSignalFromFragment(trimmed.slice(hashIndex))
    if (result.status === 'invalid') return result
    if (result.status === 'ok') {
      // `readSignalFromFragment` trusts the fragment key for direction, so the
      // caller's expectation still has to be enforced here — otherwise pasting
      // an invite link into the "answer" box would silently be accepted.
      if (expect && result.signal.kind !== expect) {
        return { status: 'invalid', error: wrongDirection(expect) }
      }
      return result
    }
  }

  // A bare token.
  if (/^LD1z?:/.test(trimmed)) {
    const json = await decodeSignalToken(trimmed)
    if (json === null) {
      return {
        status: 'invalid',
        error:
          'That code could not be read. It may have been truncated — make sure the whole thing ' +
          'was copied.',
      }
    }
    const parsed = parseEnvelope(json, expect)
    return parsed.ok
      ? { status: 'ok', signal: { kind: parsed.envelope.kind, envelope: parsed.envelope } }
      : { status: 'invalid', error: parsed.error }
  }

  // Raw JSON, or something that is not a LiveDeck payload at all.
  const parsed = parseEnvelope(trimmed, expect)
  return parsed.ok
    ? { status: 'ok', signal: { kind: parsed.envelope.kind, envelope: parsed.envelope } }
    : { status: 'invalid', error: parsed.error }
}

/** The message for a payload pasted into the wrong box. */
function wrongDirection(expected: 'offer' | 'answer'): string {
  return expected === 'offer'
    ? 'That is an answer link. Paste the host’s invite link here instead.'
    : 'That is an invite link, not an answer. Paste the link your guest sent back.'
}

/** Current origin, or a sensible placeholder when rendering outside a browser. */
export function currentOrigin(): string {
  if (typeof window === 'undefined') return 'https://livedeck.local'
  return window.location.origin
}
