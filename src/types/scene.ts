import type { SceneItem } from './source'

export type TransitionType = 'cut' | 'fade' | 'crossfade'

export type SceneTransition = {
  type: TransitionType
  durationMs: number
}

export const DEFAULT_TRANSITION: SceneTransition = { type: 'fade', durationMs: 300 }

export type Scene = {
  /** Stable identifier. Scenes are always referenced by id, never by name. */
  id: string
  name: string
  /** Display order in the scene strip. */
  order: number
  transition: SceneTransition
  items: SceneItem[]
  createdAt: number
}

/** A transition in flight, owned by the compositor rather than React. */
export type ActiveTransition = {
  fromSceneId: string
  toSceneId: string
  type: TransitionType
  durationMs: number
  startedAt: number
}

export type AspectRatioId = '16:9' | '9:16' | '1:1' | '4:3'

export type OutputResolutionId = '480p' | '720p' | '1080p'

export type FrameRateId = 24 | 30 | 60

export const ASPECT_RATIOS: Record<AspectRatioId, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
}

/** Short edge in pixels for each named resolution. */
export const RESOLUTION_SHORT_EDGE: Record<OutputResolutionId, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
}
