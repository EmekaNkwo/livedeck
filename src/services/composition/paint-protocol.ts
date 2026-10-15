import type { PaintPlan } from './painter'

/** Messages between the compositor and its paint worker. */

export type ToPaintWorker =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'resize'; width: number; height: number }
  /** A still image, cached in the worker under `key` until dropped. */
  | { type: 'image'; key: string; bitmap: ImageBitmap }
  | { type: 'drop'; key: string }
  /** Paint one frame. `frames` are this frame's video frames, closed after use. */
  | { type: 'paint'; id: number; plan: PaintPlan; frames: Array<[string, VideoFrame]> }

export type FromPaintWorker =
  | { type: 'painted'; id: number; durationMs: number }
  | { type: 'error'; message: string }
