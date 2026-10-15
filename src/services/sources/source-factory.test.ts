import { describe, expect, it } from 'vitest'
import type { SourceTransform } from '@/types/geometry'
import type { SourceType } from '@/types/source'
import {
  SOURCE_TYPE_LABEL,
  createSceneItem,
  defaultTransform,
  fillCanvas,
  fitToCanvas,
  streamKeys,
  type PlacementContext,
} from './source-factory'

const WIDE = 16 / 9

function context(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return { canvasAspect: WIDE, intrinsic: null, existingCount: 0, existingLayers: [], ...overrides }
}

const FULL = { x: 0, y: 0, width: 1, height: 1, rotation: 0 }

describe('defaultTransform', () => {
  it.each(['color-background', 'microphone', 'remote-audio'] as const)('%s fills the frame', (type) => {
    expect(defaultTransform(type, context())).toEqual(FULL)
  })

  it('a screen of unknown size fills the frame', () => {
    expect(defaultTransform('screen', context())).toEqual(FULL)
  })

  it('a screen of known size is letterboxed, not stretched', () => {
    // 4:3 content on a 16:9 canvas: full height, pillarboxed width.
    const t = defaultTransform('screen', context({ intrinsic: { width: 1024, height: 768 } }))
    expect(t.height).toBeCloseTo(1)
    expect(t.width).toBeCloseTo(0.75)
    expect(t.x).toBeCloseTo(0.125)
    expect(t.rotation).toBe(0)
  })

  it.each(['camera', 'remote-video'] as const)(
    '%s arrives as a bottom-right picture-in-picture, 16:9 assumed',
    (type) => {
      const t = defaultTransform(type, context())
      // A 16:9 box on a 16:9 canvas is square in normalized units.
      expect(t.width).toBeCloseTo(0.28)
      expect(t.height).toBeCloseTo(0.28)
      expect(t.x).toBeCloseTo(1 - 0.04 - 0.28)
      expect(t.y).toBeCloseTo(1 - 0.04 - 0.28)
    },
  )

  it('cascades further cameras to the left and wraps after three', () => {
    const xs = [0, 1, 2, 3].map((existingCount) => defaultTransform('camera', context({ existingCount })).x)
    expect(xs[1]).toBeCloseTo((xs[0] ?? 0) - 0.3)
    expect(xs[2]).toBeCloseTo((xs[0] ?? 0) - 0.6)
    expect(xs[3]).toBeCloseTo(xs[0] ?? 0)
  })

  it('never pushes a camera past the left margin', () => {
    const t = defaultTransform('camera', context({ canvasAspect: 9 / 16, existingCount: 2 }))
    expect(t.x).toBeGreaterThanOrEqual(0.04)
  })

  it('uses the intrinsic size of a camera when known', () => {
    // 4:3 on 16:9 is narrower than tall in normalized units.
    const t = defaultTransform('camera', context({ intrinsic: { width: 640, height: 480 } }))
    expect(t.width).toBeLessThan(t.height)
  })

  it.each(['image', 'video'] as const)('%s of unknown size is a centred 60%% box', (type) => {
    const t = defaultTransform(type, context())
    expect(t).toMatchObject({ width: 0.6, height: 0.4 })
    expect(t.x).toBeCloseTo(0.2)
    expect(t.y).toBeCloseTo(0.3)
  })

  it.each(['image', 'video'] as const)('%s of known size is fitted at 60%%', (type) => {
    const t = defaultTransform(type, context({ intrinsic: { width: 1920, height: 1080 } }))
    expect(t.width).toBeCloseTo(0.6)
    expect(t.height).toBeCloseTo(0.6)
  })

  it('text arrives as a lower-third band', () => {
    expect(defaultTransform('text', context())).toEqual({
      x: 0.08,
      y: 0.72,
      width: 0.84,
      height: 0.14,
      rotation: 0,
    })
  })
})

describe('createSceneItem', () => {
  it('builds a visible, unlocked, opaque item at layer 0 in an empty scene', () => {
    const item = createSceneItem({ sourceId: 'src_1', type: 'text', context: context() })
    expect(item).toEqual({
      sourceId: 'src_1',
      transform: defaultTransform('text', context()),
      visible: true,
      locked: false,
      layer: 0,
      mirrored: false,
      opacity: 1,
    })
  })

  it('puts new items above and backgrounds below everything present', () => {
    const ctx = context({ existingLayers: [-2, 0, 5] })
    expect(createSceneItem({ sourceId: 'a', type: 'camera', context: ctx }).layer).toBe(6)
    expect(createSceneItem({ sourceId: 'b', type: 'color-background', context: ctx }).layer).toBe(-3)
  })

  it('carries the mirrored flag', () => {
    expect(createSceneItem({ sourceId: 'a', type: 'camera', context: context(), mirrored: true }).mirrored).toBe(
      true,
    )
  })
})

describe('fitToCanvas and fillCanvas', () => {
  const base: SourceTransform = { x: 0.3, y: 0.3, width: 0.2, height: 0.2, rotation: 45 }

  it('fit letterboxes known media and keeps rotation', () => {
    const t = fitToCanvas(base, { width: 1080, height: 1920 }, WIDE)
    expect(t.height).toBeCloseTo(1)
    expect(t.width).toBeLessThan(1)
    expect(t.rotation).toBe(45)
  })

  it('fill covers the frame for known media and keeps rotation', () => {
    const t = fillCanvas(base, { width: 1080, height: 1920 }, WIDE)
    expect(t.width).toBeCloseTo(1)
    expect(t.height).toBeGreaterThan(1)
    expect(t.rotation).toBe(45)
  })

  it('both fall back to the full frame for media of unknown size', () => {
    expect(fitToCanvas(base, null, WIDE)).toEqual({ ...FULL, rotation: 45 })
    expect(fillCanvas(base, null, WIDE)).toEqual({ ...FULL, rotation: 45 })
  })
})

describe('labels and stream keys', () => {
  it('labels every source type', () => {
    const types: SourceType[] = [
      'camera',
      'microphone',
      'screen',
      'remote-video',
      'remote-audio',
      'image',
      'video',
      'text',
      'color-background',
    ]
    for (const type of types) expect(SOURCE_TYPE_LABEL[type].length).toBeGreaterThan(0)
  })

  it('builds stable keys so sources can share a capture', () => {
    expect(streamKeys.camera('cam-1')).toBe('camera:cam-1')
    expect(streamKeys.camera(null)).toBe('camera:default')
    expect(streamKeys.microphone('mic-1')).toBe('mic:mic-1')
    expect(streamKeys.microphone(null)).toBe('mic:default')
    expect(streamKeys.screen()).toBe('screen:primary')
    expect(streamKeys.guest('gst_1')).toBe('guest:gst_1')
    expect(streamKeys.guestScreen('gst_1')).toBe('guest-screen:gst_1')
  })
})
