import { describe, expect, it } from 'vitest'
import type { SourceTransform } from '@/types/geometry'
import type { GestureState } from './interaction-controller'
import { NO_MODIFIERS, applyGesture, cursorForHandle, handlePlacements, hitTestItem } from './interaction-controller'

/**
 * Gesture math, tested without a DOM.
 *
 * This is the payoff of keeping the interaction controller as pure functions:
 * rotation, aspect locking and crop behaviour can all be asserted directly.
 */

const viewport = { width: 1000, height: 500 }

const transform: SourceTransform = {
  x: 0.2,
  y: 0.2,
  width: 0.4,
  height: 0.4,
  rotation: 0,
}

function gesture(overrides: Partial<GestureState> = {}): GestureState {
  return {
    handle: 'move',
    sourceId: 'src_1',
    startTransform: transform,
    startPointer: { x: 400, y: 200 },
    viewport,
    others: [],
    snapThresholdPx: 0,
    snapEnabled: false,
    ...overrides,
  }
}

describe('move', () => {
  it('translates by the pointer delta in normalized units', () => {
    const result = applyGesture(gesture(), { x: 500, y: 250 }, NO_MODIFIERS)
    // +100px of 1000 = +0.1; +50px of 500 = +0.1
    expect(result.transform.x).toBeCloseTo(0.3)
    expect(result.transform.y).toBeCloseTo(0.3)
  })

  it('does not resize', () => {
    const result = applyGesture(gesture(), { x: 700, y: 400 }, NO_MODIFIERS)
    expect(result.transform.width).toBeCloseTo(transform.width)
    expect(result.transform.height).toBeCloseTo(transform.height)
  })

  it('snaps to the canvas edge when snapping is enabled', () => {
    const state = gesture({ snapEnabled: true, snapThresholdPx: 12 })
    // Drag so the left edge lands at 0.003 — inside the threshold.
    const result = applyGesture(state, { x: 400 - 197, y: 200 }, NO_MODIFIERS)
    expect(result.transform.x).toBe(0)
    expect(result.guides.length).toBeGreaterThan(0)
  })

  it('suppresses snapping while Ctrl/Cmd is held', () => {
    const state = gesture({ snapEnabled: true, snapThresholdPx: 12 })
    const result = applyGesture(state, { x: 400 - 197, y: 200 }, {
      ...NO_MODIFIERS,
      disableSnap: true,
    })
    expect(result.transform.x).not.toBe(0)
    expect(result.guides).toHaveLength(0)
  })

  it('does not snap a rotated item, whose bounding edges are misleading', () => {
    const state = gesture({
      snapEnabled: true,
      snapThresholdPx: 12,
      startTransform: { ...transform, rotation: 30 },
    })
    const result = applyGesture(state, { x: 400 - 197, y: 200 }, NO_MODIFIERS)
    expect(result.guides).toHaveLength(0)
  })
})

describe('resize', () => {
  it('grows from the south-east handle without moving the anchor', () => {
    const result = applyGesture(gesture({ handle: 'se' }), { x: 500, y: 250 }, NO_MODIFIERS)
    expect(result.transform.x).toBeCloseTo(transform.x)
    expect(result.transform.y).toBeCloseTo(transform.y)
    expect(result.transform.width).toBeCloseTo(0.5)
    expect(result.transform.height).toBeCloseTo(0.5)
  })

  it('moves the origin when dragging the north-west handle', () => {
    const result = applyGesture(gesture({ handle: 'nw' }), { x: 500, y: 250 }, NO_MODIFIERS)
    expect(result.transform.x).toBeCloseTo(0.3)
    expect(result.transform.y).toBeCloseTo(0.3)
    expect(result.transform.width).toBeCloseTo(0.3)
    expect(result.transform.height).toBeCloseTo(0.3)
  })

  it('only changes width from an east handle', () => {
    const result = applyGesture(gesture({ handle: 'e' }), { x: 500, y: 300 }, NO_MODIFIERS)
    expect(result.transform.height).toBeCloseTo(transform.height)
    expect(result.transform.width).toBeCloseTo(0.5)
  })

  it('enforces a minimum extent instead of inverting the box', () => {
    // Drag the east handle far past the west edge.
    const result = applyGesture(gesture({ handle: 'e' }), { x: -5000, y: 200 }, NO_MODIFIERS)
    expect(result.transform.width).toBeGreaterThan(0)
    expect(result.transform.height).toBeGreaterThan(0)
  })

  it('preserves aspect ratio when Shift is held', () => {
    const start: SourceTransform = { x: 0.2, y: 0.2, width: 0.4, height: 0.2, rotation: 0 }
    const result = applyGesture(
      gesture({ handle: 'se', startTransform: start }),
      { x: 600, y: 210 },
      { ...NO_MODIFIERS, aspectLock: true },
    )
    const startAspect = start.width / start.height
    const endAspect = result.transform.width / result.transform.height
    expect(endAspect).toBeCloseTo(startAspect, 4)
  })

  it('resizes symmetrically about the centre when Alt is held', () => {
    const result = applyGesture(gesture({ handle: 'e' }), { x: 450, y: 200 }, {
      ...NO_MODIFIERS,
      fromCenter: true,
    })
    const startCenter = transform.x + transform.width / 2
    const endCenter = result.transform.x + result.transform.width / 2
    expect(endCenter).toBeCloseTo(startCenter, 4)
    expect(result.transform.width).toBeGreaterThan(transform.width)
  })

  it('keeps a rotated item’s centre displacement consistent', () => {
    // The anchor-pinning step is what makes a rotated resize feel right rather
    // than sliding the item sideways.
    const rotated = { ...transform, rotation: 90 }
    const result = applyGesture(
      gesture({ handle: 'se', startTransform: rotated }),
      { x: 400, y: 300 },
      NO_MODIFIERS,
    )
    // Dragging "down" in world space, on a 90°-rotated item, grows its local
    // width — so the box dimensions must change, not just translate.
    expect(result.transform.width).not.toBeCloseTo(rotated.width, 5)
    expect(result.transform.rotation).toBe(90)
  })
})

describe('rotate', () => {
  it('rotates by the angle swept about the centre', () => {
    // Centre is at (400, 200) in viewport pixels for this transform.
    const state = gesture({ handle: 'rotate', startPointer: { x: 400, y: 100 } })
    const result = applyGesture(state, { x: 500, y: 200 }, NO_MODIFIERS)
    // From straight up to straight right is +90°.
    expect(result.transform.rotation).toBeCloseTo(90, 1)
  })

  it('snaps rotation to 15° increments when Shift is held', () => {
    const state = gesture({ handle: 'rotate', startPointer: { x: 400, y: 100 } })
    const result = applyGesture(state, { x: 480, y: 180 }, {
      ...NO_MODIFIERS,
      aspectLock: true,
    })
    expect(result.transform.rotation % 15).toBeCloseTo(0, 6)
  })

  it('never changes size', () => {
    const state = gesture({ handle: 'rotate', startPointer: { x: 400, y: 100 } })
    const result = applyGesture(state, { x: 300, y: 350 }, NO_MODIFIERS)
    expect(result.transform.width).toBeCloseTo(transform.width)
    expect(result.transform.height).toBeCloseTo(transform.height)
  })
})

describe('crop', () => {
  it('trims from the top as the handle is dragged down', () => {
    const state = gesture({ handle: 'crop-n' })
    // Item is 200px tall on screen (0.4 × 500); +40px = 20% of the frame.
    const result = applyGesture(state, { x: 400, y: 240 }, NO_MODIFIERS)
    expect(result.transform.crop?.top).toBeCloseTo(0.2, 3)
  })

  it('trims from the bottom as the handle is dragged up', () => {
    const state = gesture({ handle: 'crop-s' })
    const result = applyGesture(state, { x: 400, y: 160 }, NO_MODIFIERS)
    expect(result.transform.crop?.bottom).toBeCloseTo(0.2, 3)
  })

  it('trims horizontally using the item’s on-screen width', () => {
    const state = gesture({ handle: 'crop-w' })
    // 0.4 × 1000 = 400px wide; +80px = 20%.
    const result = applyGesture(state, { x: 480, y: 200 }, NO_MODIFIERS)
    expect(result.transform.crop?.left).toBeCloseTo(0.2, 3)
  })

  it('clamps so opposing crops cannot consume the frame', () => {
    const state = gesture({
      handle: 'crop-n',
      startTransform: { ...transform, crop: { top: 0, right: 0, bottom: 0.9, left: 0 } },
    })
    const result = applyGesture(state, { x: 400, y: 10_000 }, NO_MODIFIERS)
    const crop = result.transform.crop!
    expect(crop.top + crop.bottom).toBeLessThanOrEqual(0.95)
  })

  it('leaves position and size untouched', () => {
    const result = applyGesture(gesture({ handle: 'crop-n' }), { x: 400, y: 240 }, NO_MODIFIERS)
    expect(result.transform.x).toBeCloseTo(transform.x)
    expect(result.transform.width).toBeCloseTo(transform.width)
  })
})

describe('hitTestItem', () => {
  it('detects a point inside the item in viewport pixels', () => {
    expect(hitTestItem({ x: 400, y: 200 }, transform, viewport)).toBe(true)
    expect(hitTestItem({ x: 100, y: 200 }, transform, viewport)).toBe(false)
  })

  it('accounts for rotation', () => {
    const rotated = { ...transform, rotation: 45 }
    expect(hitTestItem({ x: 400, y: 200 }, rotated, viewport)).toBe(true)
  })
})

describe('handlePlacements', () => {
  it('produces eight resize handles plus a rotation grip', () => {
    const placements = handlePlacements(transform, viewport)
    expect(placements).toHaveLength(9)
    expect(placements.map((placement) => placement.id)).toContain('rotate')
  })

  it('positions corners at the box corners when unrotated', () => {
    const placements = handlePlacements(transform, viewport)
    const nw = placements.find((placement) => placement.id === 'nw')!
    expect(nw.x).toBeCloseTo(200)
    expect(nw.y).toBeCloseTo(100)
  })

  it('rotates handle positions with the item', () => {
    const plain = handlePlacements(transform, viewport)
    const rotated = handlePlacements({ ...transform, rotation: 90 }, viewport)
    const plainNw = plain.find((placement) => placement.id === 'nw')!
    const rotatedNw = rotated.find((placement) => placement.id === 'nw')!
    expect(rotatedNw.x).not.toBeCloseTo(plainNw.x, 1)
  })
})

describe('cursorForHandle', () => {
  it('maps handles to the expected cursors when unrotated', () => {
    expect(cursorForHandle('n', 0)).toBe('ns-resize')
    expect(cursorForHandle('e', 0)).toBe('ew-resize')
    expect(cursorForHandle('se', 0)).toBe('nwse-resize')
    expect(cursorForHandle('move', 0)).toBe('move')
    expect(cursorForHandle('rotate', 0)).toBe('grab')
  })

  it('rotates the cursor with the item so it matches the visual edge', () => {
    // A north handle on a 90°-rotated item points east.
    expect(cursorForHandle('n', 90)).toBe('ew-resize')
  })
})
