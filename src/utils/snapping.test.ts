import { describe, expect, it } from 'vitest'
import { snapRect } from './snapping'

const viewport = { width: 1000, height: 500 }
const threshold = 10

describe('snapRect', () => {
  it('snaps a near-left-edge rect onto the canvas edge', () => {
    const result = snapRect({ x: 0.005, y: 0.4, width: 0.2, height: 0.2 }, [], viewport, threshold)
    expect(result.rect.x).toBe(0)
    expect(result.guides).toContainEqual({
      orientation: 'vertical',
      position: 0,
      kind: 'canvas-edge',
    })
  })

  it('snaps the rect centre to the canvas centre', () => {
    // Centre at 0.503 — within threshold of 0.5 once converted to normalized.
    const result = snapRect({ x: 0.403, y: 0.1, width: 0.2, height: 0.2 }, [], viewport, threshold)
    expect(result.rect.x + result.rect.width / 2).toBeCloseTo(0.5)
    expect(result.guides.some((guide) => guide.kind === 'canvas-center')).toBe(true)
  })

  it('leaves a rect alone when nothing is within the threshold', () => {
    const rect = { x: 0.31, y: 0.33, width: 0.2, height: 0.2 }
    const result = snapRect(rect, [], viewport, threshold)
    expect(result.rect).toEqual(rect)
    expect(result.guides).toHaveLength(0)
  })

  it('snaps to another item’s edge', () => {
    const other = { x: 0.72, y: 0.1, width: 0.2, height: 0.2 }
    // Right edge at 0.717, just shy of the other item's left edge at 0.72.
    // Deliberately kept clear of the canvas centre so the only candidate in
    // range is the item edge.
    const result = snapRect(
      { x: 0.517, y: 0.4, width: 0.2, height: 0.2 },
      [other],
      viewport,
      threshold,
    )
    expect(result.rect.x + result.rect.width).toBeCloseTo(0.72)
    expect(result.guides.some((guide) => guide.kind === 'item-edge')).toBe(true)
  })

  it('snaps both axes independently in one gesture', () => {
    const result = snapRect({ x: 0.004, y: 0.003, width: 0.2, height: 0.2 }, [], viewport, threshold)
    expect(result.rect.x).toBe(0)
    expect(result.rect.y).toBe(0)
    expect(result.guides).toHaveLength(2)
  })

  it('never changes the rect size', () => {
    const rect = { x: 0.004, y: 0.4, width: 0.237, height: 0.191 }
    const result = snapRect(rect, [], viewport, threshold)
    expect(result.rect.width).toBe(rect.width)
    expect(result.rect.height).toBe(rect.height)
  })

  it('is disabled by a zero threshold', () => {
    const rect = { x: 0.001, y: 0.001, width: 0.2, height: 0.2 }
    const result = snapRect(rect, [], viewport, 0)
    expect(result.rect).toEqual(rect)
    expect(result.guides).toHaveLength(0)
  })

  it('degrades safely on a zero-sized viewport', () => {
    // Happens on the first render before the ResizeObserver has measured.
    const rect = { x: 0.001, y: 0.001, width: 0.2, height: 0.2 }
    const result = snapRect(rect, [], { width: 0, height: 0 }, threshold)
    expect(result.rect).toEqual(rect)
  })

  it('picks the nearest candidate when several are in range', () => {
    const near = { x: 0.52, y: 0.1, width: 0.1, height: 0.1 }
    const far = { x: 0.56, y: 0.1, width: 0.1, height: 0.1 }
    // Left edge at 0.53: nearer to `near`'s left edge (0.52) than to far's.
    const result = snapRect(
      { x: 0.53, y: 0.4, width: 0.1, height: 0.1 },
      [near, far],
      viewport,
      30,
    )
    expect(result.rect.x).toBeCloseTo(0.52)
  })
})
