import type { MediaSource } from '@/types/source'
import type { Size } from '@/types/geometry'
import { streamRegistry } from '@/services/media/stream-registry'
import { assetCache } from './asset-cache'

/**
 * Resolving a source into something drawable.
 *
 * The compositor knows nothing about source types. It asks for a `Frame` and
 * draws whatever it gets back, which is what keeps "add a new source type" from
 * touching the render loop.
 */

export type Frame =
  /** A decoded bitmap the compositor can `drawImage`. */
  | { kind: 'drawable'; drawable: CanvasImageSource; intrinsic: Size }
  /** A flat colour fill. */
  | { kind: 'fill'; color: string }
  /** Text to lay out and paint. */
  | { kind: 'text'; source: MediaSource }
  /** Nothing to draw yet, with a reason the UI can show. */
  | { kind: 'empty'; reason: FrameEmptyReason }

export type FrameEmptyReason =
  | 'not-acquired'
  | 'loading'
  | 'ended'
  | 'decode-error'
  | 'no-dimensions'
  | 'unsupported'

export const FRAME_EMPTY_LABEL: Record<FrameEmptyReason, string> = {
  'not-acquired': 'Not started',
  loading: 'Loading…',
  ended: 'Source ended',
  'decode-error': 'Could not decode',
  'no-dimensions': 'Waiting for video',
  unsupported: 'Unsupported source',
}

/**
 * Resolve the current frame for a source.
 *
 * Called once per source per rendered frame, so it must stay allocation-light
 * and must never throw — a single bad source has to degrade to a placeholder
 * rather than take down the whole render loop.
 */
export function resolveFrame(source: MediaSource): Frame {
  switch (source.settings.kind) {
    case 'color-background':
      return { kind: 'fill', color: source.settings.color }

    case 'text':
      return { kind: 'text', source }

    case 'image': {
      const entry = assetCache.load(source.id, 'image', source.settings)
      if (entry.error) return { kind: 'empty', reason: 'decode-error' }
      if (!entry.ready) return { kind: 'empty', reason: 'loading' }
      const element = entry.element as HTMLImageElement
      if (element.naturalWidth === 0) return { kind: 'empty', reason: 'no-dimensions' }
      return {
        kind: 'drawable',
        drawable: element,
        intrinsic: { width: element.naturalWidth, height: element.naturalHeight },
      }
    }

    case 'video': {
      const entry = assetCache.load(source.id, 'video', source.settings, source.settings.loop)
      if (entry.error) return { kind: 'empty', reason: 'decode-error' }
      const element = entry.element as HTMLVideoElement
      return fromVideoElement(element, entry.ready)
    }

    case 'camera':
    case 'screen':
    case 'remote-video': {
      if (!source.streamKey) return { kind: 'empty', reason: 'not-acquired' }
      const element = streamRegistry.getElement(source.streamKey)
      if (!element) {
        // The registry entry is gone: the track ended, or the capture was
        // never started. Either way there is nothing to draw.
        return { kind: 'empty', reason: 'ended' }
      }
      return fromVideoElement(element, true)
    }

    // Audio-only sources contribute no pixels.
    case 'microphone':
    case 'remote-audio':
      return { kind: 'empty', reason: 'unsupported' }
  }
}

/**
 * A `<video>` is only safe to draw once it has real dimensions and has left
 * the HAVE_NOTHING/HAVE_METADATA readyStates. Drawing earlier throws
 * `InvalidStateError` in some browsers and paints a black rectangle in others.
 */
function fromVideoElement(element: HTMLVideoElement, loaded: boolean): Frame {
  if (!loaded) return { kind: 'empty', reason: 'loading' }
  if (element.videoWidth === 0 || element.videoHeight === 0) {
    return { kind: 'empty', reason: 'no-dimensions' }
  }
  if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return { kind: 'empty', reason: 'loading' }
  }
  return {
    kind: 'drawable',
    drawable: element,
    intrinsic: { width: element.videoWidth, height: element.videoHeight },
  }
}

/** Intrinsic size of a source, for "fit to canvas" and initial placement. */
export function intrinsicSize(source: MediaSource): Size | null {
  const frame = resolveFrame(source)
  if (frame.kind === 'drawable') return frame.intrinsic
  return null
}
