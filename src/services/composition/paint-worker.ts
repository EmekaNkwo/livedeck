import { paintPlan, type Ctx2D, type ScratchSurface } from './painter'
import type { FromPaintWorker, ToPaintWorker } from './paint-protocol'

/**
 * The program painter, off the main thread.
 *
 * Owns the program canvas as an OffscreenCanvas. The page's `<canvas>` is its
 * placeholder: what is painted here appears there, and `captureStream()` on
 * the placeholder records it, so recording and the scene window are unchanged.
 *
 * Each `paint` brings the video frames it needs; they are closed as soon as
 * the frame is drawn, because an open VideoFrame holds a decoder buffer and
 * a camera stalls when they run out. Still images are sent once and cached.
 */

let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null
const images = new Map<string, ImageBitmap>()
const scratch = new Map<'a' | 'b', { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }>()

function send(message: FromPaintWorker): void {
  postMessage(message)
}

function scratchSurface(slot: 'a' | 'b', width: number, height: number): ScratchSurface | null {
  let surface = scratch.get(slot)
  if (!surface) {
    const created = new OffscreenCanvas(width, height)
    const ctx = created.getContext('2d')
    if (!ctx) return null
    surface = { canvas: created, ctx }
    scratch.set(slot, surface)
  }
  if (surface.canvas.width !== width || surface.canvas.height !== height) {
    surface.canvas.width = width
    surface.canvas.height = height
  }
  return { ctx: surface.ctx as Ctx2D, image: surface.canvas }
}

function handle(message: ToPaintWorker): void {
  switch (message.type) {
    case 'init':
      canvas = message.canvas
      context = canvas.getContext('2d', { alpha: false })
      if (!context) send({ type: 'error', message: 'The worker could not get a 2D context.' })
      return
    case 'resize':
      if (canvas && (canvas.width !== message.width || canvas.height !== message.height)) {
        canvas.width = message.width
        canvas.height = message.height
      }
      return
    case 'image':
      images.get(message.key)?.close()
      images.set(message.key, message.bitmap)
      return
    case 'drop':
      images.get(message.key)?.close()
      images.delete(message.key)
      return
    case 'paint': {
      const started = performance.now()
      const frames = new Map(message.frames)
      try {
        if (context) {
          paintPlan(context, message.plan, (key) => frames.get(key) ?? images.get(key) ?? null, scratchSurface)
        }
      } finally {
        for (const frame of frames.values()) frame.close()
      }
      send({ type: 'painted', id: message.id, durationMs: performance.now() - started })
      return
    }
  }
}

onmessage = (event: MessageEvent<ToPaintWorker>) => {
  try {
    handle(event.data)
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    // Never leave the compositor waiting on a frame that will not finish.
    if (event.data.type === 'paint') send({ type: 'painted', id: event.data.id, durationMs: 0 })
  }
}
