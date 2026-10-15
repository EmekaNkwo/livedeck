import { beforeEach, describe, expect, it } from 'vitest'
import type { MediaSource, SourceSettings } from '@/types/source'
import {
  selectSourceById,
  selectSourceList,
  sourcesAsMap,
  sourcesUsingStream,
  useSourceStore,
} from './sourceStore'

const store = () => useSourceStore.getState()

const camera: SourceSettings = { kind: 'camera', deviceId: null, mirrored: false }
const color: SourceSettings = { kind: 'color-background', color: '#000000' }

function add(name: string, streamKey: string | null = null): MediaSource {
  return store().addSource({ name, type: 'camera', settings: camera, streamKey })
}

function persisted(id: string, streamKey: string | null = 'camera:default'): MediaSource {
  return {
    id,
    name: id,
    type: 'camera',
    visible: true,
    locked: false,
    muted: false,
    layer: 0,
    settings: camera,
    streamKey,
    volume: 1,
    createdAt: 1,
  }
}

beforeEach(() => {
  useSourceStore.setState({ sources: {}, order: [], revision: 0 })
})

describe('addSource', () => {
  it('creates a source with defaults, stacked above existing ones', () => {
    const first = add('Cam', 'camera:default')
    const second = store().addSource({
      name: 'Background',
      type: 'color-background',
      settings: color,
      volume: 0.5,
      muted: true,
    })
    expect(first).toMatchObject({
      name: 'Cam',
      visible: true,
      locked: false,
      muted: false,
      layer: 0,
      streamKey: 'camera:default',
      volume: 1,
    })
    expect(first.id).toMatch(/^src_/)
    expect(second).toMatchObject({ layer: 1, streamKey: null, volume: 0.5, muted: true })
    expect(store().order).toEqual([first.id, second.id])
    expect(store().revision).toBe(2)
  })

  it('de-duplicates names', () => {
    add('Cam')
    expect(add('Cam').name).toBe('Cam 2')
  })
})

describe('removeSource', () => {
  it('removes the definition and its order entry', () => {
    const a = add('A')
    const b = add('B')
    store().removeSource(a.id)
    expect(store().sources[a.id]).toBeUndefined()
    expect(store().order).toEqual([b.id])
    expect(store().revision).toBe(3)
  })

  it('is a no-op for an unknown source', () => {
    add('A')
    const before = store()
    store().removeSource('src_missing')
    expect(store()).toBe(before)
  })
})

describe('edits', () => {
  it('renames uniquely against other sources and ignores blanks', () => {
    const a = add('A')
    add('B')
    store().renameSource(a.id, ' B ')
    expect(store().sources[a.id]?.name).toBe('B 2')
    const before = store()
    store().renameSource(a.id, '  ')
    store().renameSource('missing', 'X')
    expect(store()).toBe(before)
  })

  it('updates settings and bumps the revision', () => {
    const a = add('A')
    const next: SourceSettings = { kind: 'camera', deviceId: 'cam-2', mirrored: true }
    store().updateSettings(a.id, next)
    expect(store().sources[a.id]?.settings).toEqual(next)
    expect(store().revision).toBe(2)
    const before = store()
    store().updateSettings('missing', next)
    expect(store()).toBe(before)
  })

  it('setStreamKey only bumps the revision on a real change', () => {
    const a = add('A')
    store().setStreamKey(a.id, 'camera:x')
    expect(store().sources[a.id]?.streamKey).toBe('camera:x')
    expect(store().revision).toBe(2)
    const before = store()
    store().setStreamKey(a.id, 'camera:x')
    store().setStreamKey('missing', 'camera:y')
    expect(store()).toBe(before)
  })

  it('setVolume clamps to 0..1.5', () => {
    const a = add('A')
    store().setVolume(a.id, 2)
    expect(store().sources[a.id]?.volume).toBe(1.5)
    store().setVolume(a.id, -1)
    expect(store().sources[a.id]?.volume).toBe(0)
    store().setVolume(a.id, 0.7)
    expect(store().sources[a.id]?.volume).toBe(0.7)
  })

  it('sets mute, visible and locked defaults without bumping the revision', () => {
    const a = add('A')
    store().setMuted(a.id, true)
    store().setVisibleDefault(a.id, false)
    store().setLockedDefault(a.id, true)
    expect(store().sources[a.id]).toMatchObject({ muted: true, visible: false, locked: true })
    expect(store().revision).toBe(1)
  })

  it('ignores flag edits to unknown sources', () => {
    const before = store()
    store().setMuted('missing', true)
    store().setVolume('missing', 1)
    store().setVisibleDefault('missing', false)
    store().setLockedDefault('missing', true)
    expect(store()).toBe(before)
  })
})

describe('duplicateSource', () => {
  it('clones with a new id and name but shares the stream key', () => {
    const a = add('Cam', 'camera:default')
    store().setVolume(a.id, 0.4)
    const clone = store().duplicateSource(a.id)
    expect(clone).not.toBeNull()
    expect(clone?.id).not.toBe(a.id)
    expect(clone).toMatchObject({ name: 'Cam copy', streamKey: 'camera:default', volume: 0.4 })
    expect(store().order).toEqual([a.id, clone?.id])
    expect(store().duplicateSource(a.id)?.name).toBe('Cam copy 2')
  })

  it('returns null for an unknown source', () => {
    expect(store().duplicateSource('missing')).toBeNull()
    expect(store().revision).toBe(0)
  })
})

describe('reorder', () => {
  it('moves a source and clamps / rounds the target index', () => {
    const [a, b, c] = [add('A'), add('B'), add('C')]
    store().reorder(a.id, 99)
    expect(store().order).toEqual([b.id, c.id, a.id])
    store().reorder(a.id, -3)
    expect(store().order).toEqual([a.id, b.id, c.id])
    store().reorder(c.id, 0.6)
    expect(store().order).toEqual([a.id, c.id, b.id])
  })

  it('is a no-op for an unknown source or the same position', () => {
    const a = add('A')
    add('B')
    const before = store()
    store().reorder('missing', 0)
    store().reorder(a.id, 0)
    expect(store()).toBe(before)
  })
})

describe('hydrate and clear', () => {
  it('drops live stream keys, honours stored order and appends unordered sources', () => {
    store().hydrate([persisted('a'), persisted('b'), persisted('c', null)], ['c', 'ghost', 'a'])
    expect(store().order).toEqual(['c', 'a', 'b'])
    expect(Object.values(store().sources).every((s) => s.streamKey === null)).toBe(true)
    expect(store().revision).toBe(1)
  })

  it('lists each source once even when the saved order repeats an id', () => {
    store().hydrate([persisted('a')], ['a', 'a'])
    expect(store().order).toEqual(['a'])
  })

  it('clear empties the library and bumps the revision', () => {
    add('A')
    store().clear()
    expect(store().sources).toEqual({})
    expect(store().order).toEqual([])
    expect(store().revision).toBe(2)
  })
})

describe('selectors', () => {
  it('selectSourceList follows order and skips dangling ids', () => {
    const a = add('A')
    const b = add('B')
    useSourceStore.setState({ order: [b.id, 'dangling', a.id] })
    expect(selectSourceList(store()).map((s) => s.name)).toEqual(['B', 'A'])
  })

  it('selectSourceById resolves an id, or null', () => {
    const a = add('A')
    expect(selectSourceById(a.id)(store())?.name).toBe('A')
    expect(selectSourceById('missing')(store())).toBeNull()
    expect(selectSourceById(null)(store())).toBeNull()
  })

  it('sourcesUsingStream finds every sharer of a key', () => {
    const a = add('A', 'camera:default')
    const b = add('B', 'camera:default')
    add('C', 'mic:default')
    expect(sourcesUsingStream(store(), 'camera:default').map((s) => s.id).sort()).toEqual(
      [a.id, b.id].sort(),
    )
    expect(sourcesUsingStream(store(), 'screen:primary')).toEqual([])
  })

  it('sourcesAsMap mirrors the record', () => {
    const a = add('A')
    const map = sourcesAsMap(store())
    expect(map.size).toBe(1)
    expect(map.get(a.id)).toBe(store().sources[a.id])
  })
})
