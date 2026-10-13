/** Logical grouping used to label and order mixer channels. */
export type AudioChannelKind = 'host-mic' | 'guest' | 'display' | 'media'

/**
 * Serializable mixer channel configuration.
 *
 * MUTE SEMANTICS — these are deliberately distinct states, never conflated:
 *  - `mutedInMix`   : excluded from the program mix and the recording. Capture
 *                     keeps running, levels keep metering.
 *  - `monitoring`   : whether this channel is routed to the local speakers.
 *                     Off by default to avoid acoustic feedback.
 *  - stopping capture is a *source* operation (see sourceStore), not a mixer
 *    operation, and is reached from the source controls instead.
 */
export type AudioChannelConfig = {
  /** Equals the owning source id, so the mixer and sources stay in lockstep. */
  id: string
  sourceId: string
  kind: AudioChannelKind
  label: string
  /** Fader position, 0..1. Applied to the program mix gain node. */
  volume: number
  /** Extra input gain in dB, -12..+12, applied before the fader. */
  gainDb: number
  mutedInMix: boolean
  monitoring: boolean
}

/** Live meter reading. Published outside React at a throttled rate. */
export type AudioLevel = {
  /** RMS, 0..1. */
  rms: number
  /** Peak, 0..1. */
  peak: number
  /** RMS in dBFS, clamped to >= -60. */
  db: number
  /** True when the signal hit or exceeded 0 dBFS recently. */
  clipping: boolean
}

export const SILENT_LEVEL: AudioLevel = {
  rms: 0,
  peak: 0,
  db: -60,
  clipping: false,
}

export type AudioContextStatus = 'uninitialized' | 'suspended' | 'running' | 'unavailable'

export const MIN_GAIN_DB = -12
export const MAX_GAIN_DB = 12
export const METER_FLOOR_DB = -60
