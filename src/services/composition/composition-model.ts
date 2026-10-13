import type { ActiveTransition, Scene } from '@/types/scene'
import type { MediaSource, SceneItem } from '@/types/source'
import type { Size } from '@/types/geometry'
import { ASPECT_RATIOS, RESOLUTION_SHORT_EDGE } from '@/types/scene'
import type { AspectRatioId, OutputResolutionId } from '@/types/scene'
import { isVisualSource } from '@/types/source'

/**
 * The composition model: the one description of "what the program output looks
 * like right now".
 *
 * The preview and the recording both render from this, through the same
 * compositor, onto the same canvas — so there is no second implementation that
 * could drift. See README › Program canvas.
 */

export type ResolvedLayer = {
  item: SceneItem
  source: MediaSource
}

export type ResolvedScene = {
  sceneId: string
  /** Sorted back-to-front; index 0 is drawn first. */
  layers: ResolvedLayer[]
}

export type CompositionSnapshot = {
  /** Logical output size in pixels. Independent of the browser window. */
  canvas: Size
  background: string
  current: ResolvedScene | null
  /** Non-null only while a transition is in flight. */
  outgoing: ResolvedScene | null
  transition: ActiveTransition | null
  /**
   * Bumped whenever anything *static* changed. Lets the compositor skip
   * redundant draws when no source is producing new frames.
   */
  revision: number
}

export const EMPTY_SNAPSHOT: CompositionSnapshot = {
  canvas: { width: 1280, height: 720 },
  background: '#08090c',
  current: null,
  outgoing: null,
  transition: null,
  revision: 0,
}

/**
 * Resolve a logical output size from the user's aspect-ratio and resolution
 * settings.
 *
 * Dimensions are forced to even numbers: most hardware H.264/VP9 encoders
 * require even dimensions and will either refuse the stream or silently pad it.
 */
export function resolveCanvasSize(
  aspectRatio: AspectRatioId,
  resolution: OutputResolutionId,
): Size {
  const aspect = ASPECT_RATIOS[aspectRatio]
  const shortEdge = RESOLUTION_SHORT_EDGE[resolution]
  // The named resolution always describes the *short* edge, so 720p in 9:16 is
  // 720 wide, matching how vertical video is normally specified.
  if (aspect >= 1) {
    return { width: makeEven(shortEdge * aspect), height: makeEven(shortEdge) }
  }
  return { width: makeEven(shortEdge), height: makeEven(shortEdge / aspect) }
}

function makeEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * Turn a scene plus the source library into draw-ordered layers.
 *
 * Filters out hidden items, audio-only sources, and items whose source has
 * been deleted (a dangling reference, which is tolerated rather than fatal).
 * Sorting is stable on `layer` then on the item's position in the scene, so
 * two items on the same layer keep a deterministic order instead of flickering.
 */
export function resolveScene(
  scene: Scene | null,
  sourcesById: ReadonlyMap<string, MediaSource>,
): ResolvedScene | null {
  if (!scene) return null
  const layers: Array<ResolvedLayer & { index: number }> = []
  scene.items.forEach((item, index) => {
    if (!item.visible) return
    const source = sourcesById.get(item.sourceId)
    if (!source) return
    if (!isVisualSource(source.type)) return
    layers.push({ item, source, index })
  })
  layers.sort((a, b) => (a.item.layer === b.item.layer ? a.index - b.index : a.item.layer - b.item.layer))
  return { sceneId: scene.id, layers: layers.map(({ item, source }) => ({ item, source })) }
}

/**
 * Progress of a transition, 0..1. Returns 1 once finished, which lets the
 * compositor render the final frame correctly before the transition is cleared.
 */
export function transitionProgress(transition: ActiveTransition, now: number): number {
  if (transition.durationMs <= 0) return 1
  const elapsed = now - transition.startedAt
  if (elapsed <= 0) return 0
  if (elapsed >= transition.durationMs) return 1
  return elapsed / transition.durationMs
}

export function isTransitionComplete(transition: ActiveTransition | null, now: number): boolean {
  if (!transition) return true
  return transitionProgress(transition, now) >= 1
}

/** Smootherstep easing — avoids the mechanical feel of a linear dissolve. */
export function easeTransition(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * True when at least one layer is backed by continuously-updating media, which
 * tells the compositor it cannot skip frames.
 */
export function hasLiveMedia(scene: ResolvedScene | null): boolean {
  if (!scene) return false
  return scene.layers.some(({ source }) => {
    switch (source.type) {
      case 'camera':
      case 'screen':
      case 'remote-video':
      case 'video':
        return true
      default:
        return false
    }
  })
}
