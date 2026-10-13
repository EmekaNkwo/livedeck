import type { AspectRatioId, FrameRateId, OutputResolutionId } from './scene'
import type { StudioMode } from './peer'

export type SessionStatus = 'idle' | 'ready' | 'live' | 'ended'

/** Serializable session metadata. Persisted to localStorage. */
export type StudioSession = {
  /**
   * Human-shareable session id. NOTE: this is a convenience label for
   * coordinating a production, *not* an authentication or authorization
   * credential — see README › Sessions are not access control.
   */
  id: string
  name: string
  mode: StudioMode
  createdAt: number
  lastOpenedAt: number
}

export type OutputSettings = {
  aspectRatio: AspectRatioId
  resolution: OutputResolutionId
  frameRate: FrameRateId
}

export type StudioSettings = {
  output: OutputSettings
  /** Snap dragged items to guides and to other items' edges. */
  snapToGuides: boolean
  snapThresholdPx: number
  showSafeAreas: boolean
  /** Interface animation. Production transitions are configured per scene. */
  reducedMotion: 'system' | 'always' | 'never'
  /** Cap the preview render rate independently of the recording rate. */
  previewFrameRate: FrameRateId
  /** Route mixer output to local speakers. Off by default (feedback risk). */
  monitorProgramAudio: boolean
  iceServerUrls: string[]

  /**
   * Which signaling transport to use.
   *
   * `server` is the default: guests join by opening the room link and appear
   * automatically, which is the workflow people expect from a meeting tool, and
   * it enables trickle ICE. It requires the relay in `server/` to be running.
   *
   * `manual` remains fully supported as the zero-infrastructure fallback —
   * connection details travel inside the invite link's fragment and the guest's
   * answer comes back by hand. See README › Signaling transports.
   */
  signalingTransport: 'manual' | 'server'
  /**
   * Base URL of the relay. Only used when `signalingTransport` is `server`.
   *
   * Blank means "work it out" — see `services/signaling/relay-url.ts`. It is
   * left blank by default rather than hardcoded so that a studio deployed
   * behind a proxy resolves to its own origin instead of someone's localhost.
   */
  signalingServerUrl: string
}

export const DEFAULT_SETTINGS: StudioSettings = {
  output: { aspectRatio: '16:9', resolution: '720p', frameRate: 30 },
  snapToGuides: true,
  snapThresholdPx: 8,
  showSafeAreas: false,
  reducedMotion: 'system',
  previewFrameRate: 30,
  monitorProgramAudio: false,
  iceServerUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  // Rooms by default: a guest opens the room link and appears, with no code to
  // carry back. Manual is one setting away for installs with no relay.
  signalingTransport: 'server',
  signalingServerUrl: '',
}

