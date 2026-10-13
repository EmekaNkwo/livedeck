/**
 * Rooms and roles — the VDO.Ninja mental model.
 *
 * VDO.Ninja has no notion of a "project file". Instead everything is a URL with
 * a role baked into it:
 *
 *   /director/:room        the control room — see every guest, mix, record
 *   /push/:room            a guest's camera sender
 *   /scene/:room           a clean program output, meant to be screen-captured
 *   /solo/:room/:guestId   one guest's feed, clean
 *
 * The role decides what the page *is*, not just what it shows. A push view has
 * no mixer and no recorder; a scene view has no interface at all.
 *
 * IMPORTANT HONESTY NOTE
 * ----------------------
 * In real VDO.Ninja, a room name is enough to connect because a signaling
 * server matches peers inside it. This project has **no backend**, so a room
 * name alone cannot connect anybody. Rooms here group the local production and
 * label the roles; the actual connection is still established by exchanging an
 * invite link that carries the session description. See
 * `services/signaling/invite-link.ts`.
 */

export type RoomRole = 'director' | 'push' | 'scene' | 'solo'

export const ROLE_LABEL: Record<RoomRole, string> = {
  director: 'Director',
  push: 'Guest',
  scene: 'Scene output',
  solo: 'Solo view',
}

export const ROLE_DESCRIPTION: Record<RoomRole, string> = {
  director:
    'The control room. See every guest, arrange scenes, mix audio and record the program output.',
  push: 'Send your camera and microphone to the director. No controls, no recording.',
  scene:
    'A clean program output with no interface, sized to the logical canvas — capture this window in OBS or any screen recorder.',
  solo: 'A single guest’s feed with no interface.',
}

/**
 * Director → guest control messages, sent over the peer connection's data
 * channel.
 *
 * This is what makes director controls *real* rather than local-only: muting a
 * guest from the control room disables the track on **their** machine, exactly
 * as VDO.Ninja's director does. Without a data channel the best a director
 * could do is drop the guest from its own mix, which the remote participant
 * would never know about.
 */
export type ControlMessage =
  | { v: 1; type: 'mute-mic'; muted: boolean }
  | { v: 1; type: 'mute-camera'; muted: boolean }
  /** Ask the guest to display a short message (a cue, a countdown). */
  | { v: 1; type: 'cue'; text: string }
  /** Tell the guest whether they are currently live in the program output. */
  | { v: 1; type: 'on-air'; onAir: boolean }
  /** Rename request — the director renamed them in the control room. */
  | { v: 1; type: 'label'; label: string }
  /** Keepalive, so a stalled data channel is detectable. */
  | { v: 1; type: 'ping'; at: number }

/** Guest → director acknowledgements and state reports. */
export type GuestMessage =
  | { v: 1; type: 'hello'; label: string; hasVideo: boolean; hasAudio: boolean }
  /** The guest's *actual* track state after applying a control message. */
  | { v: 1; type: 'state'; micMuted: boolean; cameraMuted: boolean }
  | { v: 1; type: 'pong'; at: number }

export type AnyChannelMessage = ControlMessage | GuestMessage

/** Live state of a guest's control channel. Never persisted. */
export type ControlChannelState = {
  peerId: string
  open: boolean
  /** Round-trip of the last ping, or null if never measured. */
  latencyMs: number | null
  /** What the guest last reported about its own tracks. */
  reportedMicMuted: boolean | null
  reportedCameraMuted: boolean | null
  lastMessageAt: number | null
}

/**
 * Validate a message arriving over the data channel.
 *
 * Data-channel payloads are remote input and are not trustworthy: a peer could
 * send anything. Everything is structurally checked before it can touch local
 * state or a MediaStreamTrack.
 */
export function parseChannelMessage(raw: string): AnyChannelMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const message = parsed as Record<string, unknown>
  if (message.v !== 1 || typeof message.type !== 'string') return null

  switch (message.type) {
    case 'mute-mic':
    case 'mute-camera':
      return typeof message.muted === 'boolean'
        ? ({ v: 1, type: message.type, muted: message.muted } as ControlMessage)
        : null
    case 'cue':
      // Bounded so a hostile peer cannot push an unbounded string into the DOM.
      return typeof message.text === 'string'
        ? { v: 1, type: 'cue', text: message.text.slice(0, 280) }
        : null
    case 'on-air':
      return typeof message.onAir === 'boolean'
        ? { v: 1, type: 'on-air', onAir: message.onAir }
        : null
    case 'label':
      return typeof message.label === 'string'
        ? { v: 1, type: 'label', label: message.label.slice(0, 60) }
        : null
    case 'ping':
      return typeof message.at === 'number' ? { v: 1, type: 'ping', at: message.at } : null
    case 'pong':
      return typeof message.at === 'number' ? { v: 1, type: 'pong', at: message.at } : null
    case 'hello':
      return typeof message.label === 'string' &&
        typeof message.hasVideo === 'boolean' &&
        typeof message.hasAudio === 'boolean'
        ? {
            v: 1,
            type: 'hello',
            label: message.label.slice(0, 60),
            hasVideo: message.hasVideo,
            hasAudio: message.hasAudio,
          }
        : null
    case 'state':
      return typeof message.micMuted === 'boolean' && typeof message.cameraMuted === 'boolean'
        ? { v: 1, type: 'state', micMuted: message.micMuted, cameraMuted: message.cameraMuted }
        : null
    default:
      return null
  }
}

/** Room names are user-visible and go in URLs, so they are normalized. */
export function normalizeRoomName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}
