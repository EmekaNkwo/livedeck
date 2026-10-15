import type { CropInsets, Size } from '@/types/geometry'
import type { MediaSource, SceneItem, TextStyle } from '@/types/source'
import { resolveCropRect } from '@/utils/geometry'
import type { Frame } from './frame-providers'
import { resolveFrame } from './frame-providers'
import type { CompositionSnapshot, ResolvedScene } from './composition-model'
import {
  EMPTY_SNAPSHOT,
  easeTransition,
  hasLiveMedia,
  transitionProgress,
} from './composition-model'

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
 * SCHEDULING
 * ----------
 * Driven by `requestAnimationFrame` but gated to a target frame rate, and
 * skipped entirely when nothing is animating and no live media is on screen.
 */

export type CompositorStats = {
  /** Frames actually painted in the last second. */
  fps: number
  framesRendered: number
  framesSkipped: number
  lastFrameDurationMs: number
}

type SnapshotSource = () => CompositionSnapshot

export class CanvasCompositor {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null

  /** Scratch canvases used only while a transition is in flight. */
  private scratchA: HTMLCanvasElement | null = null
  private scratchB: HTMLCanvasElement | null = null

  private getSnapshot: SnapshotSource = () => EMPTY_SNAPSHOT
  private rafId = 0
  private running = false
  private sizeLocked = false

  private targetFps = 30
  private lastPaintAt = 0
  private lastRevision = -1

  private framesRendered = 0
  private framesSkipped = 0
  private fpsWindowStart = 0
  private fpsWindowFrames = 0
  private stats: CompositorStats = {
    fps: 0,
    framesRendered: 0,
    framesSkipped: 0,
    lastFrameDurationMs: 0,
  }

  /** Attach the canvas the compositor paints into. */
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    /*
     * `alpha: false` lets the browser skip per-pixel blending with the page,
     * which measurably reduces compositing cost for a full-frame opaque
     * program feed.
     *
     * `desynchronized: true` is deliberately NOT used. It lets the canvas
     * bypass the normal commit path, and in Chromium that makes `getImageData`
     * read back a stale or empty buffer — verified by a browser test that drew
     * a white frame and read back transparent black. For a canvas whose pixels
     * are the product (captured for recording and for peer senders), reliable
     * readback matters far more than the small latency win.
     */
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.lastRevision = -1
  }

  detach(): void {
    this.stop()
    this.canvas = null
    this.ctx = null
    this.scratchA = null
    this.scratchB = null
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas
  }

  setSnapshotSource(source: SnapshotSource): void {
    this.getSnapshot = source
  }

  setTargetFps(fps: number): void {
    this.targetFps = Math.max(1, Math.min(60, fps))
  }

  /** Resize the logical output. No-op when the size is unchanged. */
  resize(size: Size): void {
    const canvas = this.canvas
    if (!canvas) return
    if (this.sizeLocked) return
    if (canvas.width === size.width && canvas.height === size.height) return
    canvas.width = size.width
    canvas.height = size.height
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
    const tick = () => {
      if (!this.running) return
      this.rafId = requestAnimationFrame(tick)
      this.onAnimationFrame()
    }
    this.rafId = requestAnimationFrame(tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
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

    this.lastPaintAt = now
    this.lastRevision = snapshot.revision
    this.paint(snapshot, now)
  }

  private paint(snapshot: CompositionSnapshot, now: number): void {
    const canvas = this.canvas
    const ctx = this.ctx
    if (!canvas || !ctx) return

    if (!this.sizeLocked) this.resize(snapshot.canvas)
    const started = performance.now()

    const transition = snapshot.transition
    if (transition && snapshot.outgoing) {
      const raw = transitionProgress(transition, now)
      const t = easeTransition(raw)
      this.paintTransition(ctx, snapshot, t, transition.type)
    } else {
      this.paintScene(ctx, snapshot.current, snapshot, 1)
    }

    this.framesRendered += 1
    this.fpsWindowFrames += 1
    const elapsedWindow = now - this.fpsWindowStart
    if (elapsedWindow >= 1000) {
      this.stats = {
        fps: Math.round((this.fpsWindowFrames * 1000) / elapsedWindow),
        framesRendered: this.framesRendered,
        framesSkipped: this.framesSkipped,
        lastFrameDurationMs: performance.now() - started,
      }
      this.fpsWindowStart = now
      this.fpsWindowFrames = 0
    } else {
      this.stats = {
        ...this.stats,
        framesRendered: this.framesRendered,
        framesSkipped: this.framesSkipped,
        lastFrameDurationMs: performance.now() - started,
      }
    }
  }

  private paintTransition(
    ctx: CanvasRenderingContext2D,
    snapshot: CompositionSnapshot,
    t: number,
    type: 'cut' | 'fade' | 'crossfade',
  ): void {
    if (type === 'cut') {
      this.paintScene(ctx, snapshot.current, snapshot, 1)
      return
    }

    if (type === 'crossfade') {
      // Direct A-over-B dissolve. Both scenes are rendered to scratch canvases
      // first so that per-layer opacity inside a scene is not multiplied by the
      // transition alpha more than once.
      const from = this.renderToScratch('a', snapshot.outgoing, snapshot)
      const to = this.renderToScratch('b', snapshot.current, snapshot)
      ctx.save()
      ctx.globalAlpha = 1
      if (from) ctx.drawImage(from, 0, 0)
      ctx.globalAlpha = t
      if (to) ctx.drawImage(to, 0, 0)
      ctx.restore()
      return
    }

    // 'fade' = dip through the background colour: outgoing fades out over the
    // first half, incoming fades in over the second. Reads as a deliberate
    // broadcast fade rather than a dissolve.
    this.fillBackground(ctx, snapshot)
    if (t < 0.5) {
      const alpha = 1 - t / 0.5
      const from = this.renderToScratch('a', snapshot.outgoing, snapshot)
      if (from) {
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.drawImage(from, 0, 0)
        ctx.restore()
      }
    } else {
      const alpha = (t - 0.5) / 0.5
      const to = this.renderToScratch('b', snapshot.current, snapshot)
      if (to) {
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.drawImage(to, 0, 0)
        ctx.restore()
      }
    }
  }

  private renderToScratch(
    slot: 'a' | 'b',
    scene: ResolvedScene | null,
    snapshot: CompositionSnapshot,
  ): HTMLCanvasElement | null {
    const canvas = this.ensureScratch(slot, snapshot.canvas)
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    this.paintScene(ctx, scene, snapshot, 1)
    return canvas
  }

  private ensureScratch(slot: 'a' | 'b', size: Size): HTMLCanvasElement | null {
    const current = slot === 'a' ? this.scratchA : this.scratchB
    const canvas = current ?? document.createElement('canvas')
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width
      canvas.height = size.height
    }
    if (slot === 'a') this.scratchA = canvas
    else this.scratchB = canvas
    return canvas
  }

  private fillBackground(ctx: CanvasRenderingContext2D, snapshot: CompositionSnapshot): void {
    ctx.save()
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = snapshot.background
    ctx.fillRect(0, 0, snapshot.canvas.width, snapshot.canvas.height)
    ctx.restore()
  }

  private paintScene(
    ctx: CanvasRenderingContext2D,
    scene: ResolvedScene | null,
    snapshot: CompositionSnapshot,
    sceneAlpha: number,
  ): void {
    this.fillBackground(ctx, snapshot)
    if (!scene) return
    for (const layer of scene.layers) {
      this.paintLayer(ctx, layer.item, layer.source, snapshot.canvas, sceneAlpha)
    }
  }

  private paintLayer(
    ctx: CanvasRenderingContext2D,
    item: SceneItem,
    source: MediaSource,
    canvas: Size,
    sceneAlpha: number,
  ): void {
    const frame = resolveFrame(source)
    if (frame.kind === 'empty') return

    const alpha = item.opacity * sceneAlpha
    if (alpha <= 0) return

    const dx = item.transform.x * canvas.width
    const dy = item.transform.y * canvas.height
    const dw = item.transform.width * canvas.width
    const dh = item.transform.height * canvas.height
    if (dw <= 0 || dh <= 0) return

    ctx.save()
    ctx.globalAlpha = alpha

    // Rotation and mirroring are applied about the item's centre, so the box
    // the user dragged stays where they dragged it.
    const cx = dx + dw / 2
    const cy = dy + dh / 2
    ctx.translate(cx, cy)
    if (item.transform.rotation !== 0) {
      ctx.rotate((item.transform.rotation * Math.PI) / 180)
    }
    if (item.mirrored) ctx.scale(-1, 1)
    ctx.translate(-cx, -cy)

    try {
      this.drawFrame(ctx, frame, item, { x: dx, y: dy, width: dw, height: dh })
    } catch {
      // drawImage can still throw for a source that became invalid between
      // resolveFrame and the draw (tab discarded, track torn down). Skipping
      // this layer keeps the rest of the frame — and the recording — alive.
    }

    ctx.restore()
  }

  private drawFrame(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    item: SceneItem,
    dest: { x: number; y: number; width: number; height: number },
  ): void {
    switch (frame.kind) {
      case 'fill': {
        ctx.fillStyle = frame.color
        ctx.fillRect(dest.x, dest.y, dest.width, dest.height)
        return
      }
      case 'text': {
        drawText(ctx, frame.source, dest)
        return
      }
      case 'drawable': {
        const crop = resolveCropRect(frame.intrinsic, item.transform.crop)
        if (!crop) return
        // The 9-argument form maps the cropped sub-rectangle of the source onto
        // the destination box, which is what makes crop affect real output
        // rather than being a UI-only overlay.
        ctx.drawImage(
          frame.drawable,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          dest.x,
          dest.y,
          dest.width,
          dest.height,
        )
        return
      }
      case 'empty':
        return
    }
  }
}

function drawText(
  ctx: CanvasRenderingContext2D,
  source: MediaSource,
  dest: { x: number; y: number; width: number; height: number },
): void {
  if (source.settings.kind !== 'text') return
  const { text, style } = source.settings

  if (style.backgroundColor) {
    ctx.fillStyle = style.backgroundColor
    ctx.fillRect(dest.x, dest.y, dest.width, dest.height)
  }

  const weight = style.bold ? '700' : '400'
  ctx.font = `${weight} ${style.fontSize}px ${style.fontFamily}`
  ctx.fillStyle = style.color
  ctx.textBaseline = 'middle'
  ctx.textAlign = style.align === 'center' ? 'center' : style.align === 'right' ? 'right' : 'left'

  const padding = style.fontSize * 0.4
  const originX =
    style.align === 'center'
      ? dest.x + dest.width / 2
      : style.align === 'right'
        ? dest.x + dest.width - padding
        : dest.x + padding

  const lines = wrapText(ctx, text, dest.width - padding * 2)
  const lineHeight = style.fontSize * 1.25
  const totalHeight = lines.length * lineHeight
  let y = dest.y + dest.height / 2 - totalHeight / 2 + lineHeight / 2

  for (const line of lines) {
    ctx.fillText(line, originX, y)
    y += lineHeight
  }
}

/** Greedy word wrap using real glyph metrics from the canvas context. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]
  const paragraphs = text.split('\n')
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = words[0] ?? ''
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i] ?? ''
      const candidate = `${line} ${word}`
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate
      } else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 64,
  fontFamily: 'system-ui, sans-serif',
  color: '#ffffff',
  backgroundColor: null,
  align: 'center',
  bold: true,
}

export type { CropInsets }

/** One compositor per document, mirroring the single program output. */
export const compositor = new CanvasCompositor()
