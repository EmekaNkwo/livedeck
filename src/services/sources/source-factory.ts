import type { SceneItem, SourceType } from '@/types/source'
import type { NormalizedRect, Size, SourceTransform } from '@/types/geometry'
import { centerRect, coverRect, fitRect } from '@/utils/geometry'

/**
 * Default placement for newly added sources.
 *
 * A source that arrives stretched or centred on top of everything else makes
 * the editor feel broken, so each type gets a sensible starting transform:
 * backgrounds fill the frame, screen shares fill it, and cameras arrive as a
 * picture-in-picture in the lower-right so they do not hide what is underneath.
 */

export type PlacementContext = {
  canvasAspect: number
  /** Intrinsic size of the media, when already known. */
  intrinsic: Size | null
  /** How many items the scene already has — used to cascade new items. */
  existingCount: number
  /**
   * Layers already in use in the scene.
   *
   * Needed so a new item gets a *unique* layer. Assigning every background a
   * fixed -1 made two backgrounds collide, and tied layers cannot be reordered
   * relative to each other.
   */
  existingLayers: number[]
}

/**
 * The aspect to assume for a video source whose real size is not known yet.
 *
 * 16:9 is what every webcam and every `getUserMedia` default produces, and a
 * source placed on this assumption is corrected by the compositor's own
 * letterboxing once the first frame decodes.
 */
const ASSUMED_VIDEO_SIZE: Size = { width: 16, height: 9 }

export function defaultTransform(type: SourceType, context: PlacementContext): SourceTransform {
  const rect = defaultRect(type, context)
  return { ...rect, rotation: 0 }
}

function defaultRect(type: SourceType, context: PlacementContext): NormalizedRect {
  switch (type) {
    case 'color-background':
      return { x: 0, y: 0, width: 1, height: 1 }

    case 'screen':
      // Screen content is information-dense; letterbox it rather than crop.
      return context.intrinsic
        ? fitRect(context.intrinsic, context.canvasAspect, 1)
        : { x: 0, y: 0, width: 1, height: 1 }

    case 'camera':
    case 'remote-video': {
      // Picture-in-picture, bottom-right, with a small margin. Each additional
      // camera-like source steps left so they do not stack invisibly.
      const width = 0.28
      /*
       * The fallback goes through `fitRect` too, rather than computing a
       * height directly.
       *
       * Normalized space is a unit square while the canvas is not, so
       * `width * 0.5625` is not a 16:9 box — on a 16:9 canvas it is 3.2:1,
       * which is what made an arriving guest feed a stretched letterbox slot.
       * A 16:9 box on a 16:9 canvas is a *square* in normalized units, and
       * `fitRect` is the function that already knows that.
       *
       * This path is the common one for a guest: a remote track's intrinsic
       * size is not known until its first frame decodes, well after the
       * source is placed.
       */
      const base = fitRect(
        context.intrinsic ?? ASSUMED_VIDEO_SIZE,
        context.canvasAspect,
        width,
      )
      const margin = 0.04
      const step = (context.existingCount % 3) * (base.width + margin * 0.5)
      return {
        ...base,
        x: Math.max(margin, 1 - margin - base.width - step),
        y: 1 - margin - base.height,
      }
    }

    case 'image':
    case 'video':
      return context.intrinsic
        ? fitRect(context.intrinsic, context.canvasAspect, 0.6)
        : centerRect(0.6, 0.4)

    case 'text':
      // A wide, shallow band — lower third, the usual home for a caption.
      return { x: 0.08, y: 0.72, width: 0.84, height: 0.14 }

    case 'microphone':
    case 'remote-audio':
      // Audio-only: never drawn, but a transform keeps the model uniform.
      return { x: 0, y: 0, width: 1, height: 1 }
  }
}

/** Build a scene item for a source that is being placed into a scene. */
export function createSceneItem(options: {
  sourceId: string
  type: SourceType
  context: PlacementContext
  mirrored?: boolean
}): SceneItem {
  return {
    sourceId: options.sourceId,
    transform: defaultTransform(options.type, options.context),
    visible: true,
    locked: false,
    // Backgrounds go behind everything; anything else goes on top of what is
    // already there.
    layer: nextLayer(options.type, options.context.existingLayers),
    mirrored: options.mirrored ?? false,
    opacity: 1,
  }
}

/**
 * Pick a unique layer for a new item.
 *
 * Backgrounds go one step below everything present, anything else one step
 * above — so a new source is immediately visible, a background never covers
 * what is already there, and no two items ever share a layer.
 */
function nextLayer(type: SourceType, existingLayers: number[]): number {
  if (existingLayers.length === 0) return 0
  if (type === 'color-background') return Math.min(...existingLayers) - 1
  return Math.max(...existingLayers) + 1
}

/** "Fit to canvas" — letterbox the source inside the frame. */
export function fitToCanvas(
  transform: SourceTransform,
  intrinsic: Size | null,
  canvasAspect: number,
): SourceTransform {
  const rect = intrinsic ? fitRect(intrinsic, canvasAspect, 1) : { x: 0, y: 0, width: 1, height: 1 }
  return { ...transform, ...rect }
}

/** "Fill canvas" — cover the frame, allowing overflow. */
export function fillCanvas(
  transform: SourceTransform,
  intrinsic: Size | null,
  canvasAspect: number,
): SourceTransform {
  const rect = intrinsic ? coverRect(intrinsic, canvasAspect) : { x: 0, y: 0, width: 1, height: 1 }
  return { ...transform, ...rect }
}

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  screen: 'Screen share',
  'remote-video': 'Guest video',
  'remote-audio': 'Guest audio',
  image: 'Image',
  video: 'Video file',
  text: 'Text',
  'color-background': 'Colour background',
}

/** Stream-registry keys. Stable per capture target so sources can share one. */
export const streamKeys = {
  camera: (deviceId: string | null) => `camera:${deviceId ?? 'default'}`,
  microphone: (deviceId: string | null) => `mic:${deviceId ?? 'default'}`,
  screen: () => 'screen:primary',
  guest: (guestId: string) => `guest:${guestId}`,
  guestScreen: (guestId: string) => `guest-screen:${guestId}`,
}
