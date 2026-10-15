import { resolveCropRect } from '@/utils/geometry'
import type { CompositionSnapshot, ResolvedScene } from './composition-model'
import { easeTransition, transitionProgress } from './composition-model'
import type { Frame } from './frame-providers'
import type { PaintLayer, PaintPlan } from './painter'

/**
 * Turning a composition snapshot into a {@link PaintPlan}.
 *
 * This is the main-thread half of a frame: it resolves every visible source
 * to what can be drawn right now and lays the layers out in canvas pixels.
 * Images and video frames are not copied into the plan; each `image` layer
 * names a key, and the media behind each key is returned beside the plan so
 * the painter (here or in a worker) can be handed exactly what it needs.
 */

/** What an `image` layer's key stands for. */
export type PlannedMedia = {
  drawable: CanvasImageSource
  /** Video changes every frame; an image is the same until its element is. */
  live: boolean
}

export type PlannedFrame = {
  plan: PaintPlan
  media: Map<string, PlannedMedia>
}

export type FrameResolver = (source: ResolvedScene['layers'][number]['source']) => Frame

export function planFrame(snapshot: CompositionSnapshot, now: number, resolve: FrameResolver): PlannedFrame {
  const media = new Map<string, PlannedMedia>()
  const width = snapshot.canvas.width
  const height = snapshot.canvas.height
  const transition = snapshot.transition && snapshot.outgoing ? snapshot.transition : null
  return {
    plan: {
      width,
      height,
      background: snapshot.background,
      current: planScene(snapshot.current, width, height, resolve, media),
      outgoing: transition ? planScene(snapshot.outgoing, width, height, resolve, media) : null,
      transition: transition
        ? { type: transition.type, t: easeTransition(transitionProgress(transition, now)) }
        : null,
    },
    media,
  }
}

function planScene(
  scene: ResolvedScene | null,
  width: number,
  height: number,
  resolve: FrameResolver,
  media: Map<string, PlannedMedia>,
): PaintLayer[] | null {
  if (!scene) return null
  const layers: PaintLayer[] = []
  for (const { item, source } of scene.layers) {
    const box = {
      x: item.transform.x * width,
      y: item.transform.y * height,
      width: item.transform.width * width,
      height: item.transform.height * height,
      rotation: item.transform.rotation,
      mirrored: item.mirrored,
    }
    if (item.opacity <= 0 || box.width <= 0 || box.height <= 0) continue
    // A source that cannot be resolved must not cost the rest of the frame.
    let frame: Frame
    try {
      frame = resolve(source)
    } catch {
      continue
    }
    switch (frame.kind) {
      case 'fill':
        layers.push({ kind: 'fill', color: frame.color, alpha: item.opacity, box })
        break
      case 'text':
        if (frame.source.settings.kind === 'text') {
          layers.push({
            kind: 'text',
            text: frame.source.settings.text,
            style: frame.source.settings.style,
            alpha: item.opacity,
            box,
          })
        }
        break
      case 'drawable': {
        const crop = resolveCropRect(frame.intrinsic, item.transform.crop)
        if (!crop) break
        media.set(source.id, { drawable: frame.drawable, live: isLiveDrawable(frame.drawable) })
        layers.push({ kind: 'image', key: source.id, crop, alpha: item.opacity, box })
        break
      }
      case 'empty':
        break
    }
  }
  return layers
}

function isLiveDrawable(drawable: CanvasImageSource): boolean {
  return typeof HTMLVideoElement !== 'undefined' && drawable instanceof HTMLVideoElement
}
