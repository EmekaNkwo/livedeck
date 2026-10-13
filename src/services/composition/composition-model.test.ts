import { describe, expect, it } from 'vitest'
import { IDENTITY_TRANSFORM } from '@/types/geometry'
import type { Scene } from '@/types/scene'
import type { MediaSource, SceneItem, SourceType } from '@/types/source'
import {
  easeTransition,
  hasLiveMedia,
  isTransitionComplete,
  resolveCanvasSize,
  resolveScene,
  transitionProgress,
} from './composition-model'

function source(id: string, type: SourceType = 'camera'): MediaSource {
  return {
    id,
    name: id,
    type,
    visible: true,
    locked: false,
    muted: false,
    layer: 0,
    settings:
      type === 'camera'
        ? { kind: 'camera', deviceId: null, mirrored: false }
        : type === 'microphone'
          ? { kind: 'microphone', deviceId: null }
          : { kind: 'color-background', color: '#000' },
    streamKey: null,
    volume: 1,
    simulated: false,
    createdAt: 0,
  }
}

function item(sourceId: string, overrides: Partial<SceneItem> = {}): SceneItem {
  return {
    sourceId,
    transform: { ...IDENTITY_TRANSFORM },
    visible: true,
    locked: false,
    layer: 0,
    mirrored: false,
    opacity: 1,
    ...overrides,
  }
}

function scene(items: SceneItem[]): Scene {
  return {
    id: 'scn_1',
    name: 'Scene',
    order: 0,
    transition: { type: 'cut', durationMs: 0 },
    items,
    createdAt: 0,
  }
}

describe('resolveCanvasSize', () => {
  it('derives standard landscape sizes from the short edge', () => {
    expect(resolveCanvasSize('16:9', '720p')).toEqual({ width: 1280, height: 720 })
    expect(resolveCanvasSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080 })
    expect(resolveCanvasSize('4:3', '480p')).toEqual({ width: 640, height: 480 })
  })

  it('treats the named resolution as the short edge for vertical video', () => {
    // 720p vertical is 720 *wide*, which is how vertical video is specified.
    expect(resolveCanvasSize('9:16', '720p')).toEqual({ width: 720, height: 1280 })
  })

  it('handles square output', () => {
    expect(resolveCanvasSize('1:1', '1080p')).toEqual({ width: 1080, height: 1080 })
  })

  it('always produces even dimensions for hardware encoders', () => {
    for (const aspect of ['16:9', '9:16', '1:1', '4:3'] as const) {
      for (const resolution of ['480p', '720p', '1080p'] as const) {
        const size = resolveCanvasSize(aspect, resolution)
        expect(size.width % 2).toBe(0)
        expect(size.height % 2).toBe(0)
      }
    }
  })
})

describe('resolveScene', () => {
  const sources = new Map([
    ['a', source('a')],
    ['b', source('b')],
    ['c', source('c')],
    ['mic', source('mic', 'microphone')],
  ])

  it('returns null for no scene', () => {
    expect(resolveScene(null, sources)).toBeNull()
  })

  it('orders layers back to front', () => {
    const resolved = resolveScene(
      scene([item('a', { layer: 2 }), item('b', { layer: 0 }), item('c', { layer: 1 })]),
      sources,
    )
    expect(resolved!.layers.map((layer) => layer.item.sourceId)).toEqual(['b', 'c', 'a'])
  })

  it('keeps a deterministic order for items sharing a layer', () => {
    // Without the stable tiebreak these would flicker between frames.
    const resolved = resolveScene(
      scene([item('a', { layer: 0 }), item('b', { layer: 0 })]),
      sources,
    )
    expect(resolved!.layers.map((layer) => layer.item.sourceId)).toEqual(['a', 'b'])
  })

  it('excludes hidden items so they stay out of the recording', () => {
    const resolved = resolveScene(scene([item('a'), item('b', { visible: false })]), sources)
    expect(resolved!.layers.map((layer) => layer.item.sourceId)).toEqual(['a'])
  })

  it('excludes audio-only sources, which contribute no pixels', () => {
    const resolved = resolveScene(scene([item('a'), item('mic')]), sources)
    expect(resolved!.layers).toHaveLength(1)
  })

  it('tolerates a dangling reference to a deleted source', () => {
    // A stale item must degrade to "not drawn", not crash the render loop.
    const resolved = resolveScene(scene([item('a'), item('deleted')]), sources)
    expect(resolved!.layers).toHaveLength(1)
  })

  it('returns an empty layer list for an empty scene', () => {
    const resolved = resolveScene(scene([]), sources)
    expect(resolved!.layers).toEqual([])
    expect(resolved!.sceneId).toBe('scn_1')
  })
})

describe('transitionProgress', () => {
  const transition = {
    fromSceneId: 'a',
    toSceneId: 'b',
    type: 'fade' as const,
    durationMs: 1000,
    startedAt: 5000,
  }

  it('runs from 0 to 1 across the duration', () => {
    expect(transitionProgress(transition, 5000)).toBe(0)
    expect(transitionProgress(transition, 5500)).toBeCloseTo(0.5)
    expect(transitionProgress(transition, 6000)).toBe(1)
  })

  it('clamps outside the window', () => {
    expect(transitionProgress(transition, 4000)).toBe(0)
    expect(transitionProgress(transition, 99_999)).toBe(1)
  })

  it('completes instantly for a zero duration', () => {
    expect(transitionProgress({ ...transition, durationMs: 0 }, 5000)).toBe(1)
  })

  it('treats a null transition as complete', () => {
    expect(isTransitionComplete(null, 0)).toBe(true)
    expect(isTransitionComplete(transition, 5500)).toBe(false)
    expect(isTransitionComplete(transition, 6000)).toBe(true)
  })
})

describe('easeTransition', () => {
  it('is pinned at both ends', () => {
    expect(easeTransition(0)).toBe(0)
    expect(easeTransition(1)).toBe(1)
  })

  it('passes through the midpoint', () => {
    expect(easeTransition(0.5)).toBeCloseTo(0.5)
  })

  it('clamps out-of-range input', () => {
    expect(easeTransition(-1)).toBe(0)
    expect(easeTransition(2)).toBe(1)
  })

  it('is monotonic', () => {
    let previous = -1
    for (let t = 0; t <= 1; t += 0.1) {
      const value = easeTransition(t)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})

describe('hasLiveMedia', () => {
  const sources = new Map([
    ['cam', source('cam', 'camera')],
    ['bg', source('bg', 'color-background')],
  ])

  it('detects continuously-updating sources', () => {
    const resolved = resolveScene(scene([item('cam')]), sources)
    expect(hasLiveMedia(resolved)).toBe(true)
  })

  it('reports no live media for a static composition', () => {
    // This is what lets the compositor skip redundant frames.
    const resolved = resolveScene(scene([item('bg')]), sources)
    expect(hasLiveMedia(resolved)).toBe(false)
  })

  it('handles a null scene', () => {
    expect(hasLiveMedia(null)).toBe(false)
  })
})
