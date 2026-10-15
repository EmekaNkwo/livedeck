import type { SourceTransform } from './geometry'

export type SourceType =
  | 'camera'
  | 'microphone'
  | 'screen'
  | 'remote-video'
  | 'remote-audio'
  | 'image'
  | 'video'
  | 'text'
  | 'color-background'

/** Source types that contribute pixels to the program canvas. */
export const VISUAL_SOURCE_TYPES = [
  'camera',
  'screen',
  'remote-video',
  'image',
  'video',
  'text',
  'color-background',
] as const satisfies readonly SourceType[]

/** Source types that contribute samples to the program audio mix. */
export const AUDIO_SOURCE_TYPES = [
  'microphone',
  'remote-audio',
  'screen',
  'video',
] as const satisfies readonly SourceType[]

export function isVisualSource(type: SourceType): boolean {
  return (VISUAL_SOURCE_TYPES as readonly SourceType[]).includes(type)
}

export function isAudioSource(type: SourceType): boolean {
  return (AUDIO_SOURCE_TYPES as readonly SourceType[]).includes(type)
}

/**
 * Type-specific, *serializable* source configuration. Live objects
 * (MediaStream, HTMLVideoElement, AudioNode) are never stored here — they live
 * in the StreamRegistry, keyed by `streamKey`.
 */
export type SourceSettings =
  | { kind: 'camera'; deviceId: string | null; mirrored: boolean }
  | { kind: 'microphone'; deviceId: string | null }
  | { kind: 'screen'; withSystemAudio: boolean }
  | { kind: 'remote-video'; guestId: string; screen?: boolean }
  | { kind: 'remote-audio'; guestId: string; screen?: boolean }
  | { kind: 'image'; dataUrl: string; fit: ObjectFit }
  | { kind: 'video'; dataUrl: string; loop: boolean; fit: ObjectFit }
  | { kind: 'text'; text: string; style: TextStyle }
  | { kind: 'color-background'; color: string }

export type ObjectFit = 'contain' | 'cover' | 'fill'

export type TextStyle = {
  fontSize: number
  fontFamily: string
  color: string
  backgroundColor: string | null
  align: 'left' | 'center' | 'right'
  bold: boolean
}

/**
 * The library-level definition of a source.
 *
 * `visible`, `locked` and `layer` here are the **defaults applied when the
 * source is placed into a scene**. The authoritative per-scene values live on
 * the matching {@link SceneItem}, because the same source can appear in several
 * scenes with different visibility and stacking. The Sources panel edits the
 * current scene's item; see README › Source model.
 */
export type MediaSource = {
  id: string
  name: string
  type: SourceType
  visible: boolean
  locked: boolean
  muted: boolean
  layer: number
  settings: SourceSettings
  /**
   * Key into the StreamRegistry for this source's live media, or `null` for
   * sources that need no capture (text, colour) or that are not yet acquired.
   * Several sources may legitimately share one key — the registry refcounts.
   */
  streamKey: string | null
  /** Program-mix level, 0..1.5 (values > 1 apply makeup gain). */
  volume: number
  createdAt: number
}

/** Placement of a source within one scene. */
export type SceneItem = {
  sourceId: string
  transform: SourceTransform
  visible: boolean
  locked: boolean
  /** Higher = drawn on top. */
  layer: number
  /** Horizontal flip applied at draw time. */
  mirrored: boolean
  /** 0..1 */
  opacity: number
}

export type SourceCreationError = {
  sourceId: string | null
  message: string
  at: number
}
