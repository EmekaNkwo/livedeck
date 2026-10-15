import { describe, expect, it } from 'vitest'
import type { MediaSource, SceneItem } from '@/types/source'
import type { CompositionSnapshot } from './composition-model'
import { EMPTY_SNAPSHOT } from './composition-model'
import type { Frame } from './frame-providers'
import { planFrame } from './paint-plan'

const item = (sourceId: string, overrides: Partial<SceneItem> = {}): SceneItem => ({
  sourceId,
  transform: { x: 0.5, y: 0.25, width: 0.25, height: 0.5, rotation: 15 },
  visible: true,
  locked: false,
  layer: 0,
  mirrored: true,
  opacity: 0.8,
  ...overrides,
})
const source = (id: string, settings: MediaSource['settings']): MediaSource => ({
  id,
  name: id,
  type: settings.kind as MediaSource['type'],
  visible: true,
  locked: false,
  muted: false,
  layer: 0,
  settings,
  streamKey: null,
  volume: 1,
  createdAt: 0,
})

const video = document.createElement('video')
const img = document.createElement('img')

const frames: Record<string, Frame> = {
  bg: { kind: 'fill', color: '#123456' },
  cam: { kind: 'drawable', drawable: video, intrinsic: { width: 640, height: 480 } },
  logo: { kind: 'drawable', drawable: img, intrinsic: { width: 200, height: 100 } },
  waiting: { kind: 'empty', reason: 'loading' },
}
const resolve = (s: MediaSource): Frame => {
  if (s.id === 'broken') throw new Error('gone')
  if (s.settings.kind === 'text') return { kind: 'text', source: s }
  return frames[s.id] ?? { kind: 'empty', reason: 'unsupported' }
}

const textSettings = {
  kind: 'text' as const,
  text: 'Hello',
  style: { fontSize: 40, fontFamily: 'system-ui', color: '#fff', backgroundColor: null, align: 'center' as const, bold: true },
}

const snapshot = (layers: Array<[SceneItem, MediaSource]>, overrides: Partial<CompositionSnapshot> = {}): CompositionSnapshot => ({
  ...EMPTY_SNAPSHOT,
  canvas: { width: 1000, height: 400 },
  current: { sceneId: 's', layers: layers.map(([i, s]) => ({ item: i, source: s })) },
  ...overrides,
})

describe('planFrame', () => {
  it('lays out every kind of layer in canvas pixels and collects the media', () => {
    const { plan, media } = planFrame(
      snapshot([
        [item('bg'), source('bg', { kind: 'color-background', color: '#123456' } as MediaSource['settings'])],
        [item('cam', { transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, crop: { top: 0.5, right: 0, bottom: 0, left: 0.25 } } }), source('cam', { kind: 'camera' } as MediaSource['settings'])],
        [item('logo'), source('logo', { kind: 'image' } as MediaSource['settings'])],
        [item('title'), source('title', textSettings as MediaSource['settings'])],
      ]),
      0,
      resolve,
    )
    expect(plan).toMatchObject({ width: 1000, height: 400, background: '#08090c', outgoing: null, transition: null })
    expect(plan.current?.[0]).toEqual({
      kind: 'fill',
      color: '#123456',
      alpha: 0.8,
      box: { x: 500, y: 100, width: 250, height: 200, rotation: 15, mirrored: true },
    })
    expect(plan.current?.[1]).toMatchObject({ kind: 'image', key: 'cam', crop: { x: 160, y: 240, width: 480, height: 240 } })
    expect(plan.current?.[3]).toMatchObject({ kind: 'text', text: 'Hello', style: textSettings.style })
    expect(media.get('cam')).toEqual({ drawable: video, live: true })
    expect(media.get('logo')).toEqual({ drawable: img, live: false })
  })

  it('leaves out layers that cannot be drawn, without failing the frame', () => {
    const { plan, media } = planFrame(
      snapshot([
        [item('waiting'), source('waiting', { kind: 'camera' } as MediaSource['settings'])],
        [item('broken'), source('broken', { kind: 'camera' } as MediaSource['settings'])],
        [item('bg', { opacity: 0 }), source('bg', { kind: 'color-background' } as MediaSource['settings'])],
        [item('bg', { transform: { x: 0, y: 0, width: 0, height: 1, rotation: 0 } }), source('bg', { kind: 'color-background' } as MediaSource['settings'])],
      ]),
      0,
      resolve,
    )
    expect(plan.current).toEqual([])
    expect(media.size).toBe(0)
  })

  it('plans both scenes and the eased progress during a transition', () => {
    const outgoing = { sceneId: 'old', layers: [{ item: item('logo'), source: source('logo', { kind: 'image' } as MediaSource['settings']) }] }
    const { plan, media } = planFrame(
      snapshot([[item('cam'), source('cam', { kind: 'camera' } as MediaSource['settings'])]], {
        outgoing,
        transition: { fromSceneId: 'old', toSceneId: 's', type: 'crossfade', durationMs: 1000, startedAt: 0 },
      }),
      500,
      resolve,
    )
    expect(plan.transition).toEqual({ type: 'crossfade', t: 0.5 })
    expect(plan.outgoing).toHaveLength(1)
    expect([...media.keys()].sort()).toEqual(['cam', 'logo'])
  })

  it('ignores a transition with nothing outgoing, and an empty scene', () => {
    const { plan } = planFrame(
      { ...EMPTY_SNAPSHOT, transition: { fromSceneId: 'a', toSceneId: 'b', type: 'fade', durationMs: 500, startedAt: 0 } },
      100,
      resolve,
    )
    expect(plan).toMatchObject({ current: null, outgoing: null, transition: null })
  })
})
