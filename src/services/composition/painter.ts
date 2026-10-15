import type { TextStyle } from '@/types/source'

/**
 * Painting a program frame from a plain description.
 *
 * The compositor decides *what* is on screen on the main thread, where the
 * scene model and the media elements live. The pixels are drawn here, from a
 * {@link PaintPlan}: plain data plus image keys. Because the plan is data,
 * the same function paints on the main thread into the page's canvas or in a
 * worker into an OffscreenCanvas, and the two cannot draw differently.
 *
 * Nothing in this module touches the DOM.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type Rect = { x: number; y: number; width: number; height: number }

/** Where a layer lands: a box in canvas pixels, turned about its centre. */
export type LayerBox = Rect & { rotation: number; mirrored: boolean }

export type PaintLayer =
  | { kind: 'fill'; color: string; alpha: number; box: LayerBox }
  | { kind: 'text'; text: string; style: TextStyle; alpha: number; box: LayerBox }
  /** `key` names an image the caller supplies; `crop` is in source pixels. */
  | { kind: 'image'; key: string; crop: Rect; alpha: number; box: LayerBox }

export type PaintTransition = { type: 'cut' | 'fade' | 'crossfade'; t: number }

export type PaintPlan = {
  width: number
  height: number
  background: string
  current: PaintLayer[] | null
  outgoing: PaintLayer[] | null
  /** Eased progress; null when no transition is in flight. */
  transition: PaintTransition | null
}

/** The images a plan's `image` layers refer to. */
export type ImageLookup = (key: string) => CanvasImageSource | null

/** An offscreen surface of the plan's size, for compositing whole scenes. */
export type ScratchSurface = { ctx: Ctx2D; image: CanvasImageSource }
export type ScratchProvider = (slot: 'a' | 'b', width: number, height: number) => ScratchSurface | null

export function paintPlan(ctx: Ctx2D, plan: PaintPlan, images: ImageLookup, scratch: ScratchProvider): void {
  const transition = plan.transition
  if (!transition || !plan.outgoing || transition.type === 'cut') {
    paintScene(ctx, plan.current, plan, images)
    return
  }

  if (transition.type === 'crossfade') {
    // Direct A-over-B dissolve. Both scenes are rendered to scratch surfaces
    // first so that per-layer opacity inside a scene is not multiplied by the
    // transition alpha more than once.
    const from = renderToScratch(scratch, 'a', plan.outgoing, plan, images)
    const to = renderToScratch(scratch, 'b', plan.current, plan, images)
    ctx.save()
    ctx.globalAlpha = 1
    if (from) ctx.drawImage(from, 0, 0)
    ctx.globalAlpha = transition.t
    if (to) ctx.drawImage(to, 0, 0)
    ctx.restore()
    return
  }

  // 'fade' = dip through the background colour: outgoing fades out over the
  // first half, incoming fades in over the second. Reads as a deliberate
  // broadcast fade rather than a dissolve.
  fillBackground(ctx, plan)
  const t = transition.t
  const [slot, layers, alpha] =
    t < 0.5 ? (['a', plan.outgoing, 1 - t / 0.5] as const) : (['b', plan.current, (t - 0.5) / 0.5] as const)
  const surface = renderToScratch(scratch, slot, layers, plan, images)
  if (!surface) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.drawImage(surface, 0, 0)
  ctx.restore()
}

function renderToScratch(
  scratch: ScratchProvider,
  slot: 'a' | 'b',
  layers: PaintLayer[] | null,
  plan: PaintPlan,
  images: ImageLookup,
): CanvasImageSource | null {
  const surface = scratch(slot, plan.width, plan.height)
  if (!surface) return null
  paintScene(surface.ctx, layers, plan, images)
  return surface.image
}

function fillBackground(ctx: Ctx2D, plan: PaintPlan): void {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = plan.background
  ctx.fillRect(0, 0, plan.width, plan.height)
  ctx.restore()
}

function paintScene(ctx: Ctx2D, layers: PaintLayer[] | null, plan: PaintPlan, images: ImageLookup): void {
  fillBackground(ctx, plan)
  if (!layers) return
  for (const layer of layers) paintLayer(ctx, layer, images)
}

function paintLayer(ctx: Ctx2D, layer: PaintLayer, images: ImageLookup): void {
  const { box } = layer
  if (layer.alpha <= 0 || box.width <= 0 || box.height <= 0) return

  ctx.save()
  ctx.globalAlpha = layer.alpha
  // Rotation and mirroring are applied about the item's centre, so the box
  // the user dragged stays where they dragged it.
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  ctx.translate(cx, cy)
  if (box.rotation !== 0) ctx.rotate((box.rotation * Math.PI) / 180)
  if (box.mirrored) ctx.scale(-1, 1)
  ctx.translate(-cx, -cy)

  try {
    switch (layer.kind) {
      case 'fill':
        ctx.fillStyle = layer.color
        ctx.fillRect(box.x, box.y, box.width, box.height)
        break
      case 'text':
        drawText(ctx, layer.text, layer.style, box)
        break
      case 'image': {
        const image = images(layer.key)
        // The 9-argument form maps the cropped sub-rectangle of the source
        // onto the destination box, which is what makes crop affect real
        // output rather than being a UI-only overlay.
        if (image) {
          const { crop } = layer
          ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, box.x, box.y, box.width, box.height)
        }
        break
      }
    }
  } catch {
    // drawImage can still throw for a source that became invalid between
    // planning and drawing (tab discarded, track torn down, frame closed).
    // Skipping this layer keeps the rest of the frame, and the recording,
    // alive.
  }
  ctx.restore()
}

function drawText(ctx: Ctx2D, text: string, style: TextStyle, dest: Rect): void {
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

/** Greedy word wrap using real glyph metrics from the context. */
export function wrapText(ctx: Pick<Ctx2D, 'measureText'>, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = words[0] ?? ''
    for (const word of words.slice(1)) {
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
