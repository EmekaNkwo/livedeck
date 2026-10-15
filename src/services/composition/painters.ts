import { paintPlan, type ScratchSurface } from './painter'
import type { PlannedFrame } from './paint-plan'
import type { FromPaintWorker, ToPaintWorker } from './paint-protocol'

/**
 * Where program frames are painted.
 *
 * {@link WorkerPainter} paints in a worker into the canvas's OffscreenCanvas,
 * so compositing, transitions and text layout cost the page nothing.
 * {@link MainThreadPainter} paints on the page, for browsers without
 * OffscreenCanvas transfer or VideoFrame. Both run the same `paintPlan`.
 */

export type PaintThread = 'main' | 'worker'

export interface Painter {
  readonly thread: PaintThread
  resize: (width: number, height: number) => void
  /** Paint a frame. False when the previous one is still being painted. */
  paint: (frame: PlannedFrame) => boolean
  /** How long the last frame took to paint, in milliseconds. */
  lastPaintMs: () => number
  dispose: () => void
}

export class MainThreadPainter implements Painter {
  readonly thread = 'main' as const
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly scratch = new Map<'a' | 'b', HTMLCanvasElement>()
  private lastMs = 0

  private constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas
    this.ctx = ctx
  }

  static create(canvas: HTMLCanvasElement): MainThreadPainter | null {
    /*
     * `alpha: false` lets the browser skip per-pixel blending with the page.
     * `desynchronized` is deliberately not used: in Chromium it makes
     * readback return a stale or empty buffer, and this canvas's pixels are
     * the product.
     */
    try {
      const ctx = canvas.getContext('2d', { alpha: false })
      return ctx ? new MainThreadPainter(canvas, ctx) : null
    } catch {
      // A canvas whose control was transferred to a worker refuses contexts.
      return null
    }
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return
    this.canvas.width = width
    this.canvas.height = height
  }

  paint(frame: PlannedFrame): boolean {
    const started = performance.now()
    paintPlan(this.ctx, frame.plan, (key) => frame.media.get(key)?.drawable ?? null, (slot, width, height) =>
      this.scratchSurface(slot, width, height),
    )
    this.lastMs = performance.now() - started
    return true
  }

  lastPaintMs(): number {
    return this.lastMs
  }

  dispose(): void {
    this.scratch.clear()
  }

  private scratchSurface(slot: 'a' | 'b', width: number, height: number): ScratchSurface | null {
    const canvas = this.scratch.get(slot) ?? document.createElement('canvas')
    this.scratch.set(slot, canvas)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    return ctx ? { ctx, image: canvas } : null
  }
}

/** True when this browser can hand the program canvas to a worker. */
export function canPaintInWorker(): boolean {
  return (
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof VideoFrame === 'function' &&
    typeof createImageBitmap === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  )
}

/** A frame the worker has not acknowledged after this long is given up on. */
const STALL_MS = 2000

export type WorkerPainterOptions = {
  /** A still image reached the worker; repaint so a static scene shows it. */
  onImageReady: () => void
  onError: (message: string) => void
  createWorker?: () => Worker
}

export class WorkerPainter implements Painter {
  readonly thread = 'worker' as const
  private readonly worker: Worker
  private readonly options: WorkerPainterOptions
  /** The element each cached image key was made from. */
  private readonly sentImages = new Map<string, CanvasImageSource>()
  private nextId = 1
  private inFlight: { id: number; since: number } | null = null
  private lastMs = 0
  private disposed = false

  private constructor(worker: Worker, options: WorkerPainterOptions) {
    this.worker = worker
    this.options = options
    worker.onmessage = (event: MessageEvent<FromPaintWorker>) => this.onMessage(event.data)
    worker.onerror = (event: ErrorEvent) => {
      this.inFlight = null
      options.onError(event.message || 'The paint worker failed.')
    }
  }

  /**
   * Take over the canvas. Null when the browser cannot, or the canvas was
   * already handed over; the caller then paints on the main thread.
   */
  static create(canvas: HTMLCanvasElement, options: WorkerPainterOptions): WorkerPainter | null {
    if (!canPaintInWorker()) return null
    let offscreen: OffscreenCanvas
    try {
      offscreen = canvas.transferControlToOffscreen()
    } catch {
      return null
    }
    const worker =
      options.createWorker?.() ??
      new Worker(new URL('./paint-worker.ts', import.meta.url), { type: 'module', name: 'livedeck-paint' })
    const painter = new WorkerPainter(worker, options)
    painter.post({ type: 'init', canvas: offscreen }, [offscreen])
    return painter
  }

  resize(width: number, height: number): void {
    this.post({ type: 'resize', width, height })
  }

  paint(frame: PlannedFrame): boolean {
    if (this.disposed) return false
    if (this.inFlight && performance.now() - this.inFlight.since < STALL_MS) return false

    const frames: Array<[string, VideoFrame]> = []
    const stillKeys = new Set<string>()
    for (const [key, media] of frame.media) {
      if (media.live) {
        const videoFrame = captureFrame(media.drawable)
        if (videoFrame) frames.push([key, videoFrame])
      } else {
        stillKeys.add(key)
        this.sendImage(key, media.drawable)
      }
    }
    // Images no longer on screen are released in the worker.
    for (const key of [...this.sentImages.keys()]) {
      if (stillKeys.has(key)) continue
      this.sentImages.delete(key)
      this.post({ type: 'drop', key })
    }

    const id = this.nextId++
    this.inFlight = { id, since: performance.now() }
    this.post(
      { type: 'paint', id, plan: frame.plan, frames },
      frames.map(([, videoFrame]) => videoFrame),
    )
    return true
  }

  lastPaintMs(): number {
    return this.lastMs
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.terminate()
    this.sentImages.clear()
  }

  private sendImage(key: string, drawable: CanvasImageSource): void {
    if (this.sentImages.get(key) === drawable) return
    this.sentImages.set(key, drawable)
    createImageBitmap(drawable as ImageBitmapSource).then(
      (bitmap) => {
        // The image may have changed or left the screen while decoding.
        if (this.disposed || this.sentImages.get(key) !== drawable) {
          bitmap.close()
          return
        }
        this.post({ type: 'image', key, bitmap }, [bitmap])
        this.options.onImageReady()
      },
      (error: unknown) => {
        this.sentImages.delete(key)
        this.options.onError(`An image could not be prepared for painting: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }

  private onMessage(message: FromPaintWorker): void {
    if (message.type === 'painted') {
      if (this.inFlight?.id === message.id) this.inFlight = null
      this.lastMs = message.durationMs
      return
    }
    this.options.onError(message.message)
  }

  private post(message: ToPaintWorker, transfer: Transferable[] = []): void {
    if (this.disposed) {
      for (const item of transfer) {
        if (item instanceof VideoFrame || item instanceof ImageBitmap) item.close()
      }
      return
    }
    this.worker.postMessage(message, transfer)
  }
}

/** This instant's frame of a video element, or null when it has none. */
function captureFrame(drawable: CanvasImageSource): VideoFrame | null {
  try {
    return new VideoFrame(drawable as HTMLVideoElement)
  } catch {
    // Not yet decodable, or torn down since planning. Skip it this frame.
    return null
  }
}
