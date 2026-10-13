/**
 * Geometry primitives for the composition model.
 *
 * COORDINATE SYSTEM
 * -----------------
 * All source placement is expressed in **normalized logical canvas space**:
 * `x`, `y`, `width` and `height` are fractions of the logical output canvas
 * (0 = left/top edge, 1 = right/bottom edge). This is the single source of
 * truth shared by the editor, the preview compositor and the recording
 * pipeline, which is why changing the output resolution or the editor viewport
 * size never disturbs a composition.
 *
 * `crop` insets are fractions of the *source frame*, not of the canvas, so a
 * crop survives resizing the item on the canvas.
 *
 * `rotation` is in degrees, clockwise, about the centre of the item's box.
 */

/** Normalized rectangle in logical canvas space. */
export type NormalizedRect = {
  x: number
  y: number
  width: number
  height: number
}

/** Crop insets as fractions of the source frame. `left + right < 1`. */
export type CropInsets = {
  top: number
  right: number
  bottom: number
  left: number
}

/** Full placement of one source inside one scene. */
export type SourceTransform = {
  x: number
  y: number
  width: number
  height: number
  /** Degrees, clockwise, about the box centre. */
  rotation: number
  crop?: CropInsets
}

/** A concrete pixel rectangle, used when drawing and when hit-testing. */
export type PixelRect = {
  x: number
  y: number
  width: number
  height: number
}

export type Point = { x: number; y: number }

export type Size = { width: number; height: number }

export const ZERO_CROP: CropInsets = { top: 0, right: 0, bottom: 0, left: 0 }

export const IDENTITY_TRANSFORM: SourceTransform = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
}
