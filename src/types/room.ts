/**
 * Rooms and roles.
 *
 * Everything is a URL with a role baked into it:
 *
 *   /director/:room        the control room — see every guest, mix, record
 *   /push/:room            a guest's camera sender
 *   /scene/:room           a clean program output, meant to be screen-captured
 *   /solo/:room/:sourceId  one feed, clean
 *
 * The role decides what the page *is*, not just what it shows. A push view has
 * no mixer and no recorder; a scene view has no interface at all.
 *
 * A room name groups participants on the media server. It is not a password:
 * anyone who reaches the server joins as a guest. The director and producer
 * roles are granted by room keys the server issues — see
 * `shared/authorization.ts`.
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
 * What the control room knows about a participant's remote-control path and
 * their self-reported state. Never persisted.
 */
export type ControlChannelState = {
  peerId: string
  /** True when commands can reach this participant through the server. */
  open: boolean
  latencyMs: number | null
  /** What the participant last reported about its own tracks. */
  reportedMicMuted: boolean | null
  reportedCameraMuted: boolean | null
  sharing: boolean
  onAir: boolean
  lastMessageAt: number | null
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
