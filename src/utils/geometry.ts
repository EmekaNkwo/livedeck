import type {
  CropInsets,
  NormalizedRect,
  PixelRect,
  Point,
  Size,
  SourceTransform,
} from '@/types/geometry'
import { ZERO_CROP } from '@/types/geometry'

/** Smallest allowed normalized extent, so items can never collapse to zero. */
export const MIN_NORMALIZED_EXTENT = 0.02

/** Items may hang off-canvas by at most this fraction, so they stay reachable. */
const MAX_OVERHANG = 0.9

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Constrain a transform to the canvas.
 *
 * Extents are clamped to a sane minimum and to at most one canvas. Position is
 * clamped so that a usable part of the item always stays on canvas, which keeps
 * an item from being dragged somewhere the user can no longer grab it.
 */
export function normalizeTransform(transform: SourceTransform): SourceTransform {
  const width = clamp(transform.width, MIN_NORMALIZED_EXTENT, 1)
  const height = clamp(transform.height, MIN_NORMALIZED_EXTENT, 1)
  const next: SourceTransform = {
    x: clamp(transform.x, -width * MAX_OVERHANG, 1 - width * (1 - MAX_OVERHANG)),
    y: clamp(transform.y, -height * MAX_OVERHANG, 1 - height * (1 - MAX_OVERHANG)),
    width,
    height,
    rotation: normalizeRotation(transform.rotation),
  }
  if (transform.crop) next.crop = normalizeCrop(transform.crop)
  return next
}

/** Wrap rotation into [0, 360). */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const wrapped = degrees % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * Clamp crop insets so opposing pairs always leave a visible sliver.
 * Without this, `left + right >= 1` would produce a zero-width draw and a
 * blank item that the user cannot recover from with the numeric inputs.
 */
export function normalizeCrop(crop: CropInsets): CropInsets {
  const maxPair = 0.95
  const left = clamp(crop.left, 0, maxPair)
  const right = clamp(crop.right, 0, maxPair - left)
  const top = clamp(crop.top, 0, maxPair)
  const bottom = clamp(crop.bottom, 0, maxPair - top)
  return { top, right, bottom, left }
}

export function cropIsEmpty(crop: CropInsets | undefined): boolean {
  if (!crop) return true
  return crop.top === 0 && crop.right === 0 && crop.bottom === 0 && crop.left === 0
}

/**
 * Resolve a crop into the source-pixel rectangle to sample from.
 * Returns `null` when the source frame has no usable area yet (e.g. a video
 * element that has not produced metadata), so callers can skip the draw.
 */
export function resolveCropRect(frame: Size, crop: CropInsets | undefined): PixelRect | null {
  if (frame.width <= 0 || frame.height <= 0) return null
  const c = normalizeCrop(crop ?? ZERO_CROP)
  const x = frame.width * c.left
  const y = frame.height * c.top
  const width = frame.width * (1 - c.left - c.right)
  const height = frame.height * (1 - c.top - c.bottom)
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** Convert a normalized rect into canvas pixels. */
export function toPixelRect(rect: NormalizedRect, canvas: Size): PixelRect {
  return {
    x: rect.x * canvas.width,
    y: rect.y * canvas.height,
    width: rect.width * canvas.width,
    height: rect.height * canvas.height,
  }
}

/** Convert canvas pixels back into a normalized rect. */
export function toNormalizedRect(rect: PixelRect, canvas: Size): NormalizedRect {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  return {
    x: rect.x / canvas.width,
    y: rect.y / canvas.height,
    width: rect.width / canvas.width,
    height: rect.height / canvas.height,
  }
}

export function rectCenter(rect: NormalizedRect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/**
 * Rotate `point` about `origin` by `degrees` clockwise.
 * Used to map pointer positions into an item's unrotated local space so that
 * dragging a resize handle on a rotated item behaves intuitively.
 */
export function rotatePoint(point: Point, origin: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  }
}

/** The four corners of a rect after rotation, in normalized space. */
export function rotatedCorners(rect: NormalizedRect, rotation: number): Point[] {
  const center = rectCenter(rect)
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]
  if (rotation === 0) return corners
  return corners.map((corner) => rotatePoint(corner, center, rotation))
}

/**
 * Hit-test a normalized point against a possibly-rotated rect.
 * The point is rotated back into the rect's local space, which turns the test
 * into a plain axis-aligned containment check.
 */
export function hitTest(point: Point, transform: SourceTransform): boolean {
  const center = rectCenter(transform)
  const local = transform.rotation === 0 ? point : rotatePoint(point, center, -transform.rotation)
  return (
    local.x >= transform.x &&
    local.x <= transform.x + transform.width &&
    local.y >= transform.y &&
    local.y <= transform.y + transform.height
  )
}

/**
 * Fit a source of `intrinsic` aspect ratio inside the canvas, centred, using
 * at most `scale` of the canvas. Used by "Fit to canvas" and when first adding
 * a source so it does not arrive stretched.
 */
export function fitRect(intrinsic: Size, canvasAspect: number, scale = 1): NormalizedRect {
  const safeScale = clamp(scale, MIN_NORMALIZED_EXTENT, 1)
  if (intrinsic.width <= 0 || intrinsic.height <= 0) {
    return centerRect(safeScale, safeScale)
  }
  const sourceAspect = intrinsic.width / intrinsic.height
  // Normalized space is square, so the canvas aspect has to be divided out to
  // keep the drawn result geometrically correct.
  const relative = sourceAspect / canvasAspect
  let width = safeScale
  let height = safeScale / relative
  if (height > safeScale) {
    height = safeScale
    width = safeScale * relative
  }
  return centerRect(width, height)
}

/** Fill the canvas with a source, cropping overflow symmetrically. */
export function coverRect(intrinsic: Size, canvasAspect: number): NormalizedRect {
  if (intrinsic.width <= 0 || intrinsic.height <= 0) return { x: 0, y: 0, width: 1, height: 1 }
  const relative = intrinsic.width / intrinsic.height / canvasAspect
  let width = 1
  let height = 1 / relative
  if (height < 1) {
    height = 1
    width = relative
  }
  return centerRect(width, height)
}

export function centerRect(width: number, height: number): NormalizedRect {
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

/** Centre an existing transform without changing its size. */
export function centerTransform(transform: SourceTransform): SourceTransform {
  return {
    ...transform,
    x: (1 - transform.width) / 2,
    y: (1 - transform.height) / 2,
  }
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'

export function alignTransform(transform: SourceTransform, edge: AlignEdge): SourceTransform {
  switch (edge) {
    case 'left':
      return { ...transform, x: 0 }
    case 'right':
      return { ...transform, x: 1 - transform.width }
    case 'top':
      return { ...transform, y: 0 }
    case 'bottom':
      return { ...transform, y: 1 - transform.height }
    case 'center-x':
      return { ...transform, x: (1 - transform.width) / 2 }
    case 'center-y':
      return { ...transform, y: (1 - transform.height) / 2 }
  }
}

/**
 * Preserve `aspect` (width / height in *normalized* space) while resizing.
 * Chooses whichever axis moved more so the gesture feels responsive.
 */
export function constrainToAspect(
  rect: NormalizedRect,
  aspect: number,
  anchor: Point,
): NormalizedRect {
  if (aspect <= 0) return rect
  const widthDriven = rect.width / aspect >= rect.height
  const width = widthDriven ? rect.width : rect.height * aspect
  const height = widthDriven ? rect.width / aspect : rect.height
  // Keep the anchored corner pinned.
  return {
    x: anchor.x === 1 ? rect.x + rect.width - width : rect.x,
    y: anchor.y === 1 ? rect.y + rect.height - height : rect.y,
    width,
    height,
  }
}

export function rectsEqual(a: NormalizedRect, b: NormalizedRect, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.width - b.width) < epsilon &&
    Math.abs(a.height - b.height) < epsilon
  )
}

export function transformsEqual(a: SourceTransform, b: SourceTransform): boolean {
  if (!rectsEqual(a, b)) return false
  if (Math.abs(a.rotation - b.rotation) > 1e-6) return false
  const ac = a.crop ?? ZERO_CROP
  const bc = b.crop ?? ZERO_CROP
  return (
    Math.abs(ac.top - bc.top) < 1e-6 &&
    Math.abs(ac.right - bc.right) < 1e-6 &&
    Math.abs(ac.bottom - bc.bottom) < 1e-6 &&
    Math.abs(ac.left - bc.left) < 1e-6
  )
}
