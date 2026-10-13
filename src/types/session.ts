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
}

/** Which injected failure paths the demo panel has switched on. */
export type SimulationFlags = {
  cameraInterruption: boolean
  guestDisconnect: boolean
  poorConnection: boolean
  recordingFailure: boolean
  sourceUnavailable: boolean
}

export const NO_SIMULATIONS: SimulationFlags = {
  cameraInterruption: false,
  guestDisconnect: false,
  poorConnection: false,
  recordingFailure: false,
  sourceUnavailable: false,
}
