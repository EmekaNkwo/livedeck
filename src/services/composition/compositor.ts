import type { Size } from '@/types/geometry'
import type { TextStyle } from '@/types/source'
import { assetCache } from './asset-cache'
import { FrameClock } from './frame-clock'
import { resolveFrame } from './frame-providers'
import type { CompositionSnapshot } from './composition-model'
import { EMPTY_SNAPSHOT, hasLiveMedia } from './composition-model'
import { planFrame } from './paint-plan'
import { MainThreadPainter, WorkerPainter, type PaintThread, type Painter } from './painters'

/**
 * The program compositor.
 *
 * OWNERSHIP
 * ---------
 * This class owns the program canvas and the render loop. React components
 * never drive it: a component mounts the canvas element into the DOM and the
 * compositor writes to it. That is why the editor overlay (selection handles,
 * snap guides) is a separate DOM layer rather than being drawn here — overlay
 * chrome must not end up in the recording.
 *
 * ONE RENDER PATH
 * ---------------
 * `captureStream()` is taken from this same canvas, so the recording is
 * literally the pixels the user is previewing. There is no second compositor
 * and therefore no possibility of preview and output diverging.
 *
 * WHERE PIXELS ARE PAINTED
 * ------------------------
 * Each tick, the main thread plans the frame (which sources, where, which
 * video frame) and a painter draws it. Where the browser allows, the canvas
 * is handed to a worker as an OffscreenCanvas and painting happens there, so
 * compositing, transitions and text layout never block the page. Otherwise
 * it paints here. Both run the same painter over the same plan.
 *
 * SCHEDULING
 * ----------
 * Driven by a {@link FrameClock}: `requestAnimationFrame` while the tab is
 * visible, a worker-timed metronome while it is hidden, so a recording or a
 * mirror window keeps receiving frames when the operator switches tabs.
 * Gated to a target frame rate, and skipped entirely when nothing is
 * animating and no live media is on screen.
 */

export type CompositorStats = {
  /** Frames actually painted in the last second. */
  fps: number
  framesRendered: number
  framesSkipped: number
  lastFrameDurationMs: number
  /** Where frames are painted; null when no canvas is attached. */
  paintThread: PaintThread | null
  /** The last error the painter reported, if any. */
  paintError: string | null
}

type SnapshotSource = () => CompositionSnapshot

/** How long a released worker waits for its canvas to be attached again. */
const WORKER_RELEASE_MS = 10_000

/**
 * Workers that own a canvas. A canvas can be handed to a worker only once,
 * so when React detaches and re-attaches the same element (StrictMode does
 * this on every mount) the existing worker must be reused.
 */
const workerByCanvas = new WeakMap<HTMLCanvasElement, { painter: WorkerPainter; release: ReturnType<typeof setTimeout> | null }>()

/** `?paint=main` keeps painting on the page, for diagnosing the worker path. */
function workerPaintingAllowed(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('paint') !== 'main'
  } catch {
    return true
  }
}

export class CanvasCompositor {
  private canvas: HTMLCanvasElement | null = null
  private painter: Painter | null = null
  private outputSize: Size = { width: 0, height: 0 }

  private getSnapshot: SnapshotSource = () => EMPTY_SNAPSHOT
  private readonly clock = new FrameClock()
  private unsubscribeAssets: (() => void) | null = null
  private running = false
  private sizeLocked = false

  private targetFps = 30
  private lastPaintAt = 0
  private lastRevision = -1

  private framesRendered = 0
  private framesSkipped = 0
  private fpsWindowStart = 0
  private fpsWindowFrames = 0
  private paintError: string | null = null
  private stats: CompositorStats = {
    fps: 0,
    framesRendered: 0,
    framesSkipped: 0,
    lastFrameDurationMs: 0,
    paintThread: null,
    paintError: null,
  }

  /** Attach the canvas the compositor paints into. */
  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas && this.canvas !== canvas) this.detach()
    this.canvas = canvas
    this.outputSize = { width: canvas.width, height: canvas.height }
    this.painter = this.createPainter(canvas)
    this.paintError = this.painter ? null : 'The program canvas could not be painted.'
    this.stats = { ...this.stats, paintThread: this.painter?.thread ?? null, paintError: this.paintError }
    this.lastRevision = -1
    // A decoded image or a video's first frame changes what a static scene
    // looks like without any store revision moving; invalidate so the next
    // tick repaints it.
    this.unsubscribeAssets?.()
    this.unsubscribeAssets = assetCache.onReady(() => this.invalidate())
  }

  /** Force a repaint on the next tick, whatever the revision says. */
  invalidate(): void {
    this.lastRevision = -1
  }

  detach(): void {
    this.stop()
    this.unsubscribeAssets?.()
    this.unsubscribeAssets = null
    const canvas = this.canvas
    const painter = this.painter
    this.canvas = null
    this.painter = null
    if (painter instanceof WorkerPainter && canvas) {
      const entry = workerByCanvas.get(canvas)
      if (entry) {
        // Keep the worker briefly: the same element may be attached again.
        entry.release = setTimeout(() => {
          workerByCanvas.delete(canvas)
          entry.painter.dispose()
        }, WORKER_RELEASE_MS)
      }
    } else {
      painter?.dispose()
    }
    this.stats = { ...this.stats, paintThread: null }
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas
  }

  /** The program's output size: what is painted, captured and recorded. */
  getOutputSize(): Size {
    return this.outputSize
  }

  setSnapshotSource(source: SnapshotSource): void {
    this.getSnapshot = source
  }

  setTargetFps(fps: number): void {
    this.targetFps = Math.max(1, Math.min(60, fps))
    this.clock.setFps(this.targetFps)
  }

  /** Resize the logical output. No-op when the size is unchanged. */
  resize(size: Size): void {
    if (!this.canvas || !this.painter) return
    if (this.sizeLocked) return
    if (this.outputSize.width === size.width && this.outputSize.height === size.height) return
    this.outputSize = { width: size.width, height: size.height }
    this.painter.resize(size.width, size.height)
    // Changing the backing store clears it, so force a repaint.
    this.lastRevision = -1
  }

  /**
   * While locked, the backing store keeps its size whatever the snapshot says.
   *
   * The recorder captures the canvas, and a capture's encoded dimensions are
   * whatever the canvas is at the time of each frame. A settings change or a
   * window-driven resize mid-recording would change the file's resolution
   * part way through, which editors reject. Locked at record start, released
   * at stop.
   */
  lockSize(locked: boolean): void {
    this.sizeLocked = locked
  }

  isSizeLocked(): boolean {
    return this.sizeLocked
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.fpsWindowStart = performance.now()
    this.fpsWindowFrames = 0
    this.clock.setFps(this.targetFps)
    this.clock.start(() => {
      if (this.running) this.onAnimationFrame()
    })
  }

  stop(): void {
    this.running = false
    this.clock.stop()
  }

  /** Which clock is driving frames right now, for diagnostics. */
  getClockMode(): 'raf' | 'worker' | 'interval' {
    return this.clock.currentMode
  }

  isRunning(): boolean {
    return this.running
  }

  getStats(): CompositorStats {
    return this.stats
  }

  /** Paint one frame immediately, outside the loop. Used for thumbnails. */
  renderOnce(): void {
    this.paint(this.getSnapshot(), performance.now())
  }

  private createPainter(canvas: HTMLCanvasElement): Painter | null {
    const existing = workerByCanvas.get(canvas)
    if (existing) {
      if (existing.release) clearTimeout(existing.release)
      existing.release = null
      return existing.painter
    }
    if (workerPaintingAllowed()) {
      const worker = WorkerPainter.create(canvas, {
        onImageReady: () => this.invalidate(),
        onError: (message) => {
          this.paintError = message
          this.stats = { ...this.stats, paintError: message }
        },
      })
      if (worker) {
        workerByCanvas.set(canvas, { painter: worker, release: null })
        return worker
      }
    }
    return MainThreadPainter.create(canvas)
  }

  private onAnimationFrame(): void {
    const now = performance.now()
    const minInterval = 1000 / this.targetFps
    // Allow a small tolerance so a 30fps target on a 60Hz display does not
    // alternate between 1 and 2 vsync intervals and visibly judder.
    if (now - this.lastPaintAt < minInterval - 1) return

    const snapshot = this.getSnapshot()
    const animating =
      snapshot.transition !== null ||
      hasLiveMedia(snapshot.current) ||
      hasLiveMedia(snapshot.outgoing)

    // Static composition that has not changed: nothing to repaint. The
    // captured stream simply holds its last frame, which is correct.
    if (!animating && snapshot.revision === this.lastRevision) {
      this.framesSkipped += 1
      return
    }

    // A painter still busy with the previous frame drops this one; the
    // revision is not recorded, so a static change is retried next tick.
    if (!this.paint(snapshot, now)) {
      this.framesSkipped += 1
      return
    }
    this.lastPaintAt = now
    this.lastRevision = snapshot.revision
  }

  private paint(snapshot: CompositionSnapshot, now: number): boolean {
    const painter = this.painter
    if (!this.canvas || !painter) return false

    if (!this.sizeLocked) this.resize(snapshot.canvas)
    const planned = planFrame(
      { ...snapshot, canvas: this.outputSize },
      now,
      resolveFrame,
    )
    if (!painter.paint(planned)) return false

    this.framesRendered += 1
    this.fpsWindowFrames += 1
    const elapsedWindow = now - this.fpsWindowStart
    const common = {
      framesRendered: this.framesRendered,
      framesSkipped: this.framesSkipped,
      lastFrameDurationMs: painter.lastPaintMs(),
      paintThread: painter.thread,
      paintError: this.paintError,
    }
    if (elapsedWindow >= 1000) {
      this.stats = { ...common, fps: Math.round((this.fpsWindowFrames * 1000) / elapsedWindow) }
      this.fpsWindowStart = now
      this.fpsWindowFrames = 0
    } else {
      this.stats = { ...this.stats, ...common }
    }
    return true
  }
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 64,
  fontFamily: 'system-ui, sans-serif',
  color: '#ffffff',
  backgroundColor: null,
  align: 'center',
  bold: true,
}

/** One compositor per document, mirroring the single program output. */
export const compositor = new CanvasCompositor()
