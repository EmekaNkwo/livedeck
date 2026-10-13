/** Permission state for a capture device class. */
export type PermissionStatus = 'unknown' | 'prompt' | 'granted' | 'denied'

/** Lifecycle of a single capture attempt. */
export type CaptureStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'denied'
  | 'unavailable'
  | 'error'

export type MediaDeviceKind = 'videoinput' | 'audioinput' | 'audiooutput'

export type DeviceInfo = {
  deviceId: string
  /**
   * Browsers return an empty label until permission has been granted at least
   * once; callers should fall back to a positional name.
   */
  label: string
  kind: MediaDeviceKind
  groupId: string
}

export type MediaErrorCode =
  | 'not-allowed'
  | 'not-found'
  | 'not-readable'
  | 'overconstrained'
  | 'aborted'
  | 'insecure-context'
  | 'unsupported'
  | 'cancelled'
  | 'unknown'

export type MediaError = {
  code: MediaErrorCode
  /** Human-readable, safe to show in the UI. Never a stack trace. */
  message: string
  /** Original DOMException name, surfaced only in the diagnostics panel. */
  technical: string | null
  at: number
}

export type VideoConstraintPreference = {
  deviceId: string | null
  width: number
  height: number
  frameRate: number
}

/** Live, observable facts about a track. Polled, never persisted. */
export type TrackSnapshot = {
  id: string
  kind: 'audio' | 'video'
  label: string
  enabled: boolean
  muted: boolean
  readyState: MediaStreamTrackState
  settings: {
    width?: number
    height?: number
    frameRate?: number
    deviceId?: string
    sampleRate?: number
  }
}
