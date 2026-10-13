import { describe, expect, it } from 'vitest'
import { ZERO_CROP } from '@/types/geometry'
import {
  MIN_NORMALIZED_EXTENT,
  alignTransform,
  centerTransform,
  clamp,
  coverRect,
  cropIsEmpty,
  fitRect,
  hitTest,
  normalizeCrop,
  normalizeRotation,
  normalizeTransform,
  resolveCropRect,
  rotatePoint,
  toNormalizedRect,
  toPixelRect,
  transformsEqual,
} from './geometry'

const base = { x: 0.1, y: 0.2, width: 0.5, height: 0.4, rotation: 0 }

describe('clamp', () => {
  it('bounds values and treats NaN as the minimum', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
    // NaN would otherwise propagate through every transform it touched.
    expect(clamp(Number.NaN, 2, 10)).toBe(2)
  })
})

describe('normalizeRotation', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(370)).toBe(10)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(720)).toBe(0)
  })

  it('falls back to 0 for non-finite input', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0)
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('normalizeTransform', () => {
  it('leaves a valid transform alone', () => {
    expect(normalizeTransform(base)).toEqual(base)
  })

  it('enforces a minimum extent so an item can never collapse', () => {
    const result = normalizeTransform({ ...base, width: 0, height: -1 })
    expect(result.width).toBe(MIN_NORMALIZED_EXTENT)
    expect(result.height).toBe(MIN_NORMALIZED_EXTENT)
  })

  it('caps extents at one canvas', () => {
    const result = normalizeTransform({ ...base, width: 5, height: 3 })
    expect(result.width).toBe(1)
    expect(result.height).toBe(1)
  })

  it('keeps a dragged item partly on canvas so it stays grabbable', () => {
    const farRight = normalizeTransform({ ...base, x: 10 })
    expect(farRight.x).toBeLessThan(1)
    // At least a sliver of the item is still within [0, 1].
    expect(farRight.x).toBeLessThan(1)
    expect(farRight.x + farRight.width).toBeGreaterThan(0)

    const farLeft = normalizeTransform({ ...base, x: -10 })
    expect(farLeft.x + farLeft.width).toBeGreaterThan(0)
  })

  it('normalizes crop when present and omits it when absent', () => {
    expect(normalizeTransform(base).crop).toBeUndefined()
    const cropped = normalizeTransform({
      ...base,
      crop: { top: 0.5, right: 0.9, bottom: 0.1, left: 0.8 },
    })
    expect(cropped.crop).toBeDefined()
    expect(cropped.crop!.left + cropped.crop!.right).toBeLessThanOrEqual(0.95)
  })
})

describe('normalizeCrop', () => {
  it('passes through a sane crop', () => {
    const crop = { top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 }
    expect(normalizeCrop(crop)).toEqual(crop)
  })

  it('prevents opposing insets from consuming the whole frame', () => {
    // Without this clamp, left + right >= 1 produces a zero-width draw and an
    // item the user cannot recover.
    const result = normalizeCrop({ top: 0, right: 0.8, bottom: 0, left: 0.8 })
    expect(result.left + result.right).toBeLessThanOrEqual(0.95)
    expect(result.left).toBe(0.8)
    expect(result.right).toBeCloseTo(0.15, 10)
  })

  it('clamps negatives to zero', () => {
    expect(normalizeCrop({ top: -1, right: -1, bottom: -1, left: -1 })).toEqual(ZERO_CROP)
  })
})

describe('cropIsEmpty', () => {
  it('recognises absent and zero crops', () => {
    expect(cropIsEmpty(undefined)).toBe(true)
    expect(cropIsEmpty(ZERO_CROP)).toBe(true)
    expect(cropIsEmpty({ ...ZERO_CROP, top: 0.01 })).toBe(false)
  })
})

describe('resolveCropRect', () => {
  it('maps crop fractions onto source pixels', () => {
    const rect = resolveCropRect(
      { width: 1000, height: 500 },
      { top: 0.1, right: 0.2, bottom: 0.1, left: 0.1 },
    )
    expect(rect).toEqual({ x: 100, y: 50, width: 700, height: 400 })
  })

  it('returns the full frame for an empty crop', () => {
    expect(resolveCropRect({ width: 640, height: 480 }, undefined)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    })
  })

  it('returns null when the source has no usable area', () => {
    // A <video> that has not produced metadata yet reports 0×0; the compositor
    // relies on this null to skip the draw instead of throwing.
    expect(resolveCropRect({ width: 0, height: 0 }, undefined)).toBeNull()
  })
})

describe('pixel conversion', () => {
  const canvas = { width: 1280, height: 720 }

  it('round-trips a rect', () => {
    const pixels = toPixelRect(base, canvas)
    expect(pixels).toEqual({ x: 128, y: 144, width: 640, height: 288 })
    const back = toNormalizedRect(pixels, canvas)
    expect(back.x).toBeCloseTo(base.x)
    expect(back.y).toBeCloseTo(base.y)
    expect(back.width).toBeCloseTo(base.width)
    expect(back.height).toBeCloseTo(base.height)
  })

  it('degrades safely on a zero-sized canvas', () => {
    expect(toNormalizedRect({ x: 1, y: 1, width: 1, height: 1 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })
})

describe('rotatePoint', () => {
  it('rotates clockwise about the origin', () => {
    const result = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90)
    expect(result.x).toBeCloseTo(0)
    expect(result.y).toBeCloseTo(1)
  })

  it('is its own inverse at opposite angles', () => {
    const point = { x: 3, y: 7 }
    const origin = { x: 1, y: 2 }
    const there = rotatePoint(point, origin, 37)
    const back = rotatePoint(there, origin, -37)
    expect(back.x).toBeCloseTo(point.x)
    expect(back.y).toBeCloseTo(point.y)
  })
})

describe('hitTest', () => {
  it('detects points inside and outside an unrotated box', () => {
    expect(hitTest({ x: 0.3, y: 0.3 }, base)).toBe(true)
    expect(hitTest({ x: 0.05, y: 0.3 }, base)).toBe(false)
    expect(hitTest({ x: 0.3, y: 0.9 }, base)).toBe(false)
  })

  it('accounts for rotation', () => {
    const square = { x: 0.4, y: 0.4, width: 0.2, height: 0.2, rotation: 45 }
    // The centre is inside at any rotation.
    expect(hitTest({ x: 0.5, y: 0.5 }, square)).toBe(true)
    // A rotated square's corner region is outside the diamond it becomes.
    expect(hitTest({ x: 0.405, y: 0.405 }, square)).toBe(false)
  })
})

describe('fitRect', () => {
  it('letterboxes a wide source into a 16:9 canvas', () => {
    const rect = fitRect({ width: 1920, height: 1080 }, 16 / 9)
    expect(rect.width).toBeCloseTo(1)
    expect(rect.height).toBeCloseTo(1)
    expect(rect.x).toBeCloseTo(0)
  })

  it('pillarboxes a tall source and centres it', () => {
    const rect = fitRect({ width: 1080, height: 1920 }, 16 / 9)
    expect(rect.height).toBeCloseTo(1)
    expect(rect.width).toBeLessThan(1)
    // Centred horizontally.
    expect(rect.x).toBeCloseTo((1 - rect.width) / 2)
  })

  it('honours a scale factor for picture-in-picture placement', () => {
    const rect = fitRect({ width: 1280, height: 720 }, 16 / 9, 0.25)
    expect(rect.width).toBeCloseTo(0.25)
    expect(rect.height).toBeCloseTo(0.25)
  })

  it('falls back to a square when the source has no dimensions', () => {
    const rect = fitRect({ width: 0, height: 0 }, 16 / 9, 0.5)
    expect(rect.width).toBeCloseTo(0.5)
    expect(rect.height).toBeCloseTo(0.5)
  })
})

describe('coverRect', () => {
  it('fills the canvas, overflowing on one axis', () => {
    const rect = coverRect({ width: 1080, height: 1920 }, 16 / 9)
    expect(rect.width).toBeGreaterThanOrEqual(1)
    expect(rect.height).toBeGreaterThanOrEqual(1)
  })
})

describe('alignTransform', () => {
  it('pins each edge correctly', () => {
    expect(alignTransform(base, 'left').x).toBe(0)
    expect(alignTransform(base, 'right').x).toBeCloseTo(1 - base.width)
    expect(alignTransform(base, 'top').y).toBe(0)
    expect(alignTransform(base, 'bottom').y).toBeCloseTo(1 - base.height)
    expect(alignTransform(base, 'center-x').x).toBeCloseTo((1 - base.width) / 2)
    expect(alignTransform(base, 'center-y').y).toBeCloseTo((1 - base.height) / 2)
  })

  it('never changes size', () => {
    const result = alignTransform(base, 'right')
    expect(result.width).toBe(base.width)
    expect(result.height).toBe(base.height)
  })
})

describe('centerTransform', () => {
  it('centres without resizing', () => {
    const result = centerTransform(base)
    expect(result.x + result.width / 2).toBeCloseTo(0.5)
    expect(result.y + result.height / 2).toBeCloseTo(0.5)
    expect(result.width).toBe(base.width)
  })
})

describe('transformsEqual', () => {
  it('treats an absent crop and a zero crop as the same', () => {
    expect(transformsEqual(base, { ...base, crop: ZERO_CROP })).toBe(true)
  })

  it('detects real differences', () => {
    expect(transformsEqual(base, { ...base, x: 0.11 })).toBe(false)
    expect(transformsEqual(base, { ...base, rotation: 1 })).toBe(false)
    expect(transformsEqual(base, { ...base, crop: { ...ZERO_CROP, top: 0.1 } })).toBe(false)
  })
})
