import type { NormalizedRect, PixelRect, Point, Size, SourceTransform } from '@/types/geometry'
import { ZERO_CROP } from '@/types/geometry'
import {
  MIN_NORMALIZED_EXTENT,
  clamp,
  normalizeCrop,
  normalizeTransform,
  rotatePoint,
  toNormalizedRect,
  toPixelRect,
} from '@/utils/geometry'
import { snapRect } from '@/utils/snapping'
import type { SnapGuide } from '@/utils/snapping'

/**
 * Pure gesture math for the composition canvas.
 *
 * WHY THIS IS A SERVICE, NOT MOUSE HANDLERS IN A COMPONENT
 * --------------------------------------------------------
 * Drag, resize, rotate and crop interactions on rotated, snapped, aspect-locked
 * boxes are genuinely fiddly geometry. Keeping it here — as pure functions over
 * an immutable gesture state — means it is unit-testable without a DOM, and the
 * React layer reduces to "translate pointer events into gesture updates".
 *
 * COORDINATE SPACE
 * ----------------
 * All math happens in **viewport pixels**, not in normalized units.
 * Normalized space is a unit square while the canvas usually is not, so
 * rotating in normalized space would shear the item. The viewport has the same
 * aspect ratio as the logical canvas, so rotation there matches exactly what
 * the compositor draws; results are converted back to normalized at the end.
 */

export type HandleId =
  | 'move'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw'
  | 'rotate'

export type CropHandleId = 'crop-n' | 'crop-s' | 'crop-e' | 'crop-w'

export type GestureModifiers = {
  /** Shift — preserve aspect ratio while resizing, snap rotation to 15°. */
  aspectLock: boolean
  /** Alt — resize about the centre instead of the opposite corner. */
  fromCenter: boolean
  /** Ctrl/Cmd — temporarily suspend snapping. */
  disableSnap: boolean
}

export const NO_MODIFIERS: GestureModifiers = {
  aspectLock: false,
  fromCenter: false,
  disableSnap: false,
}

export type GestureState = {
  handle: HandleId | CropHandleId
  sourceId: string
  /** Transform when the gesture began. Never mutated. */
  startTransform: SourceTransform
  /** Pointer position when the gesture began, in viewport pixels. */
  startPointer: Point
  /** Size of the displayed canvas in CSS pixels. */
  viewport: Size
  /** Other items' rects, for snapping. */
  others: NormalizedRect[]
  snapThresholdPx: number
  snapEnabled: boolean
}

export type GestureResult = {
  transform: SourceTransform
  guides: SnapGuide[]
}

/** Degrees of rotation snapping when Shift is held. */
const ROTATION_SNAP_DEG = 15

/**
 * Compute the transform for the current pointer position.
 * Pure: the same inputs always give the same output, and nothing is mutated.
 */
export function applyGesture(
  state: GestureState,
  pointer: Point,
  modifiers: GestureModifiers,
): GestureResult {
  if (state.handle === 'rotate') {
    return { transform: applyRotate(state, pointer, modifiers), guides: [] }
  }
  if (isCropHandle(state.handle)) {
    return { transform: applyCrop(state, pointer), guides: [] }
  }
  if (state.handle === 'move') {
    return applyMove(state, pointer, modifiers)
  }
  return { transform: applyResize(state, pointer, modifiers), guides: [] }
}

function isCropHandle(handle: HandleId | CropHandleId): handle is CropHandleId {
  return handle.startsWith('crop-')
}

/* -------------------------------------------------------------------- move */

function applyMove(
  state: GestureState,
  pointer: Point,
  modifiers: GestureModifiers,
): GestureResult {
  const { viewport, startTransform, startPointer } = state
  const dxNorm = (pointer.x - startPointer.x) / viewport.width
  const dyNorm = (pointer.y - startPointer.y) / viewport.height

  const moved: NormalizedRect = {
    x: startTransform.x + dxNorm,
    y: startTransform.y + dyNorm,
    width: startTransform.width,
    height: startTransform.height,
  }

  // Snapping is meaningless for a rotated box — its bounding edges are not the
  // edges the user sees — so it is skipped rather than producing a confusing
  // latch.
  const snappable =
    state.snapEnabled && !modifiers.disableSnap && startTransform.rotation === 0

  if (!snappable) {
    return { transform: normalizeTransform({ ...startTransform, ...moved }), guides: [] }
  }

  const snapped = snapRect(moved, state.others, viewport, state.snapThresholdPx)
  return {
    transform: normalizeTransform({ ...startTransform, ...snapped.rect }),
    guides: snapped.guides,
  }
}

/* ------------------------------------------------------------------ resize */

/**
 * Resize from a handle.
 *
 * The pointer delta is rotated into the item's local frame, the local rect's
 * edges are adjusted, and then the world-space centre is moved so that the
 * anchored corner stays visually pinned. Without that last step, dragging a
 * corner of a rotated item makes it slide away sideways.
 */
function applyResize(
  state: GestureState,
  pointer: Point,
  modifiers: GestureModifiers,
): SourceTransform {
  const { startTransform, startPointer, viewport } = state
  const handle = state.handle as Exclude<HandleId, 'move' | 'rotate'>

  const startRect = toPixelRect(startTransform, viewport)
  const rotation = startTransform.rotation

  // World delta → local delta.
  const worldDelta = { x: pointer.x - startPointer.x, y: pointer.y - startPointer.y }
  const localDelta = rotation === 0 ? worldDelta : rotatePoint(worldDelta, { x: 0, y: 0 }, -rotation)

  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')

  const minPx = Math.max(
    MIN_NORMALIZED_EXTENT * viewport.width,
    MIN_NORMALIZED_EXTENT * viewport.height,
  )

  let left = startRect.x
  let top = startRect.y
  let right = startRect.x + startRect.width
  let bottom = startRect.y + startRect.height

  if (modifiers.fromCenter) {
    // Symmetric resize about the centre.
    if (west) {
      left += localDelta.x
      right -= localDelta.x
    }
    if (east) {
      right += localDelta.x
      left -= localDelta.x
    }
    if (north) {
      top += localDelta.y
      bottom -= localDelta.y
    }
    if (south) {
      bottom += localDelta.y
      top -= localDelta.y
    }
  } else {
    if (west) left += localDelta.x
    if (east) right += localDelta.x
    if (north) top += localDelta.y
    if (south) bottom += localDelta.y
  }

  // Enforce a minimum extent without letting edges cross over.
  if (right - left < minPx) {
    if (west && !east) left = right - minPx
    else if (east && !west) right = left + minPx
    else {
      const center = (left + right) / 2
      left = center - minPx / 2
      right = center + minPx / 2
    }
  }
  if (bottom - top < minPx) {
    if (north && !south) top = bottom - minPx
    else if (south && !north) bottom = top + minPx
    else {
      const center = (top + bottom) / 2
      top = center - minPx / 2
      bottom = center + minPx / 2
    }
  }

  let localRect: PixelRect = { x: left, y: top, width: right - left, height: bottom - top }

  if (modifiers.aspectLock) {
    localRect = lockAspect(localRect, startRect, { west, east, north, south }, minPx)
  }

  // Pin the anchor: move the world centre by the local centre's displacement,
  // rotated back into world space.
  const startCenter = { x: startRect.x + startRect.width / 2, y: startRect.y + startRect.height / 2 }
  const localCenter = { x: localRect.x + localRect.width / 2, y: localRect.y + localRect.height / 2 }
  const centerDelta = { x: localCenter.x - startCenter.x, y: localCenter.y - startCenter.y }
  const worldCenterDelta =
    rotation === 0 ? centerDelta : rotatePoint(centerDelta, { x: 0, y: 0 }, rotation)

  const worldRect: PixelRect = {
    x: startCenter.x + worldCenterDelta.x - localRect.width / 2,
    y: startCenter.y + worldCenterDelta.y - localRect.height / 2,
    width: localRect.width,
    height: localRect.height,
  }

  return normalizeTransform({ ...startTransform, ...toNormalizedRect(worldRect, viewport) })
}

/** Force the rect back onto the starting aspect ratio, anchored sensibly. */
function lockAspect(
  rect: PixelRect,
  startRect: PixelRect,
  edges: { west: boolean; east: boolean; north: boolean; south: boolean },
  minPx: number,
): PixelRect {
  if (startRect.height <= 0) return rect
  const aspect = startRect.width / startRect.height

  // Drive from whichever axis the user changed more, so a corner drag feels
  // natural and an edge drag follows the edge that was grabbed.
  const widthChange = Math.abs(rect.width - startRect.width)
  const heightChange = Math.abs(rect.height - startRect.height)
  const horizontalOnly = (edges.west || edges.east) && !edges.north && !edges.south
  const verticalOnly = (edges.north || edges.south) && !edges.west && !edges.east

  let width = rect.width
  let height = rect.height
  if (horizontalOnly || (!verticalOnly && widthChange >= heightChange)) {
    height = Math.max(minPx, width / aspect)
    width = height * aspect
  } else {
    width = Math.max(minPx, height * aspect)
    height = width / aspect
  }

  // Keep the anchored edges fixed in local space.
  const x = edges.west && !edges.east ? rect.x + rect.width - width : rect.x
  const y = edges.north && !edges.south ? rect.y + rect.height - height : rect.y
  return { x, y, width, height }
}

/* ------------------------------------------------------------------ rotate */

function applyRotate(
  state: GestureState,
  pointer: Point,
  modifiers: GestureModifiers,
): SourceTransform {
  const { startTransform, startPointer, viewport } = state
  const rect = toPixelRect(startTransform, viewport)
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }

  const startAngle = angleOf(center, startPointer)
  const currentAngle = angleOf(center, pointer)
  let rotation = startTransform.rotation + (currentAngle - startAngle)

  if (modifiers.aspectLock) {
    rotation = Math.round(rotation / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG
  }

  return normalizeTransform({ ...startTransform, rotation })
}

function angleOf(center: Point, point: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
}

/* -------------------------------------------------------------------- crop */

/**
 * Drag a crop edge.
 *
 * The pointer delta is measured along the item's own axes and divided by the
 * item's on-screen extent, so a crop handle tracks the pointer regardless of
 * how the item is scaled or rotated.
 */
function applyCrop(state: GestureState, pointer: Point): SourceTransform {
  const { startTransform, startPointer, viewport } = state
  const handle = state.handle as CropHandleId
  const rect = toPixelRect(startTransform, viewport)

  const worldDelta = { x: pointer.x - startPointer.x, y: pointer.y - startPointer.y }
  const localDelta =
    startTransform.rotation === 0
      ? worldDelta
      : rotatePoint(worldDelta, { x: 0, y: 0 }, -startTransform.rotation)

  const base = startTransform.crop ?? ZERO_CROP
  const fractionX = rect.width > 0 ? localDelta.x / rect.width : 0
  const fractionY = rect.height > 0 ? localDelta.y / rect.height : 0

  const next = { ...base }
  switch (handle) {
    case 'crop-n':
      next.top = base.top + fractionY
      break
    case 'crop-s':
      next.bottom = base.bottom - fractionY
      break
    case 'crop-w':
      next.left = base.left + fractionX
      break
    case 'crop-e':
      next.right = base.right - fractionX
      break
  }

  return normalizeTransform({ ...startTransform, crop: normalizeCrop(next) })
}

/* ---------------------------------------------------------------- hit test */

/**
 * Hit-test a pointer against an item, in viewport pixels.
 * Correct for rotated items because the point is rotated back into the item's
 * local frame first.
 */
export function hitTestItem(
  pointer: Point,
  transform: SourceTransform,
  viewport: Size,
): boolean {
  const rect = toPixelRect(transform, viewport)
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const local =
    transform.rotation === 0 ? pointer : rotatePoint(pointer, center, -transform.rotation)
  return (
    local.x >= rect.x &&
    local.x <= rect.x + rect.width &&
    local.y >= rect.y &&
    local.y <= rect.y + rect.height
  )
}

/** Handle positions in viewport pixels, for rendering the overlay. */
export type HandlePlacement = { id: HandleId; x: number; y: number }

export function handlePlacements(transform: SourceTransform, viewport: Size): HandlePlacement[] {
  const rect = toPixelRect(transform, viewport)
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const raw: HandlePlacement[] = [
    { id: 'nw', x: rect.x, y: rect.y },
    { id: 'n', x: center.x, y: rect.y },
    { id: 'ne', x: rect.x + rect.width, y: rect.y },
    { id: 'e', x: rect.x + rect.width, y: center.y },
    { id: 'se', x: rect.x + rect.width, y: rect.y + rect.height },
    { id: 's', x: center.x, y: rect.y + rect.height },
    { id: 'sw', x: rect.x, y: rect.y + rect.height },
    { id: 'w', x: rect.x, y: center.y },
    // Rotation grip sits above the top edge.
    { id: 'rotate', x: center.x, y: rect.y - 28 },
  ]
  if (transform.rotation === 0) return raw
  return raw.map((handle) => {
    const rotated = rotatePoint({ x: handle.x, y: handle.y }, center, transform.rotation)
    return { id: handle.id, x: rotated.x, y: rotated.y }
  })
}

/** CSS cursor for a handle, accounting for the item's rotation. */
export function cursorForHandle(handle: HandleId, rotation: number): string {
  if (handle === 'move') return 'move'
  if (handle === 'rotate') return 'grab'
  const baseAngles: Record<Exclude<HandleId, 'move' | 'rotate'>, number> = {
    n: 0,
    ne: 45,
    e: 90,
    se: 135,
    s: 180,
    sw: 225,
    w: 270,
    nw: 315,
  }
  const angle = (baseAngles[handle] + rotation + 360) % 360
  // Eight cursors around the circle, picked by nearest 45° sector.
  const cursors = [
    'ns-resize',
    'nesw-resize',
    'ew-resize',
    'nwse-resize',
    'ns-resize',
    'nesw-resize',
    'ew-resize',
    'nwse-resize',
  ]
  return cursors[Math.round(angle / 45) % 8] ?? 'pointer'
}

export { clamp }
