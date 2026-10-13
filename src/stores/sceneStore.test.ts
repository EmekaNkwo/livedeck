import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY_TRANSFORM } from '@/types/geometry'
import type { SceneItem } from '@/types/source'
import { useSceneStore } from './sceneStore'

function item(sourceId: string, layer = 0): SceneItem {
  return {
    sourceId,
    transform: { ...IDENTITY_TRANSFORM },
    visible: true,
    locked: false,
    layer,
    mirrored: false,
    opacity: 1,
  }
}

const store = () => useSceneStore.getState()

beforeEach(() => {
  useSceneStore.getState().clear()
})

describe('createScene', () => {
  it('creates a scene and makes the first one active', () => {
    const scene = store().createScene('Host')
    expect(store().order).toEqual([scene.id])
    expect(store().activeSceneId).toBe(scene.id)
  })

  it('does not steal the active scene from an existing one', () => {
    const first = store().createScene('First')
    store().createScene('Second')
    expect(store().activeSceneId).toBe(first.id)
  })

  it('de-duplicates names', () => {
    store().createScene('Interview')
    const second = store().createScene('Interview')
    expect(second.name).toBe('Interview 2')
  })

  it('generates distinct ids, not name-based keys', () => {
    const a = store().createScene('Same')
    const b = store().createScene('Same')
    expect(a.id).not.toBe(b.id)
  })
})

describe('renameScene', () => {
  it('renames without changing the id', () => {
    const scene = store().createScene('Before')
    store().renameScene(scene.id, 'After')
    expect(store().scenes[scene.id]?.name).toBe('After')
    expect(store().scenes[scene.id]?.id).toBe(scene.id)
  })

  it('ignores an empty name', () => {
    const scene = store().createScene('Keep')
    store().renameScene(scene.id, '   ')
    expect(store().scenes[scene.id]?.name).toBe('Keep')
  })
})

describe('duplicateScene', () => {
  it('copies items without sharing transform objects', () => {
    const scene = store().createScene('Original')
    store().addItem(scene.id, item('src_a'))
    const clone = store().duplicateScene(scene.id)!

    expect(clone.items).toHaveLength(1)
    // A shallow copy here would make editing the clone mutate the original.
    expect(clone.items[0]!.transform).not.toBe(store().scenes[scene.id]!.items[0]!.transform)

    store().setItemTransform(clone.id, 'src_a', {
      ...IDENTITY_TRANSFORM,
      x: 0.5,
    })
    expect(store().scenes[scene.id]!.items[0]!.transform.x).toBe(0)
  })

  it('inserts the copy immediately after the original', () => {
    const first = store().createScene('A')
    const last = store().createScene('B')
    const clone = store().duplicateScene(first.id)!
    expect(store().order).toEqual([first.id, clone.id, last.id])
  })
})

describe('deleteScene', () => {
  it('removes the scene', () => {
    const scene = store().createScene('Gone')
    store().createScene('Stays')
    store().deleteScene(scene.id)
    expect(store().scenes[scene.id]).toBeUndefined()
    expect(store().order).not.toContain(scene.id)
  })

  it('moves the active scene to a neighbour so output always has a scene', () => {
    const first = store().createScene('A')
    const second = store().createScene('B')
    store().activateScene(second.id, { immediate: true })
    store().deleteScene(second.id)
    expect(store().activeSceneId).toBe(first.id)
  })

  it('clears the active scene only when nothing is left', () => {
    const only = store().createScene('Only')
    store().deleteScene(only.id)
    expect(store().activeSceneId).toBeNull()
  })

  it('cancels an in-flight transition', () => {
    const a = store().createScene('A')
    const b = store().createScene('B')
    store().setTransition(b.id, { type: 'fade', durationMs: 300 })
    store().activateScene(b.id)
    expect(store().transition).not.toBeNull()
    store().deleteScene(a.id)
    expect(store().transition).toBeNull()
  })
})

describe('activateScene', () => {
  it('switches the active scene', () => {
    store().createScene('A')
    const b = store().createScene('B')
    store().activateScene(b.id)
    expect(store().activeSceneId).toBe(b.id)
  })

  it('starts a transition when the target scene has one', () => {
    const a = store().createScene('A')
    const b = store().createScene('B')
    store().setTransition(b.id, { type: 'crossfade', durationMs: 400 })
    store().activateScene(b.id)

    expect(store().transition).toMatchObject({
      fromSceneId: a.id,
      toSceneId: b.id,
      type: 'crossfade',
      durationMs: 400,
    })
    expect(store().previousSceneId).toBe(a.id)
  })

  it('skips transition bookkeeping for a cut', () => {
    store().createScene('A')
    const b = store().createScene('B')
    store().setTransition(b.id, { type: 'cut', durationMs: 0 })
    store().activateScene(b.id)
    expect(store().transition).toBeNull()
  })

  it('skips the transition when asked to switch immediately', () => {
    store().createScene('A')
    const b = store().createScene('B')
    store().setTransition(b.id, { type: 'fade', durationMs: 500 })
    store().activateScene(b.id, { immediate: true })
    expect(store().transition).toBeNull()
    expect(store().activeSceneId).toBe(b.id)
  })

  it('is a no-op when the scene is already active', () => {
    const a = store().createScene('A')
    const before = store().revision
    store().activateScene(a.id)
    expect(store().revision).toBe(before)
  })

  it('ignores an unknown scene id', () => {
    const a = store().createScene('A')
    store().activateScene('scn_missing')
    expect(store().activeSceneId).toBe(a.id)
  })
})

describe('setTransition', () => {
  it('clamps the duration to a sane range', () => {
    const scene = store().createScene('A')
    store().setTransition(scene.id, { type: 'fade', durationMs: 99_999 })
    expect(store().scenes[scene.id]?.transition.durationMs).toBe(3000)
    store().setTransition(scene.id, { type: 'fade', durationMs: -100 })
    expect(store().scenes[scene.id]?.transition.durationMs).toBe(0)
  })
})

describe('items', () => {
  it('adds an item and normalizes its transform', () => {
    const scene = store().createScene('A')
    store().addItem(scene.id, {
      ...item('src_a'),
      transform: { x: 0, y: 0, width: 99, height: 99, rotation: 400 },
    })
    const added = store().scenes[scene.id]!.items[0]!
    expect(added.transform.width).toBe(1)
    expect(added.transform.rotation).toBe(40)
  })

  it('refuses to add the same source twice to one scene', () => {
    const scene = store().createScene('A')
    store().addItem(scene.id, item('src_a'))
    store().addItem(scene.id, item('src_a'))
    expect(store().scenes[scene.id]!.items).toHaveLength(1)
  })

  it('removes an item from one scene only', () => {
    const a = store().createScene('A')
    const b = store().createScene('B')
    store().addItem(a.id, item('src_x'))
    store().addItem(b.id, item('src_x'))
    store().removeItem(a.id, 'src_x')
    expect(store().scenes[a.id]!.items).toHaveLength(0)
    expect(store().scenes[b.id]!.items).toHaveLength(1)
  })

  it('removes a deleted source from every scene', () => {
    const a = store().createScene('A')
    const b = store().createScene('B')
    store().addItem(a.id, item('src_x'))
    store().addItem(b.id, item('src_x'))
    store().addItem(b.id, item('src_y'))

    store().removeSourceEverywhere('src_x')
    expect(store().scenes[a.id]!.items).toHaveLength(0)
    expect(store().scenes[b.id]!.items.map((i) => i.sourceId)).toEqual(['src_y'])
  })

  it('clamps opacity when updating an item', () => {
    const scene = store().createScene('A')
    store().addItem(scene.id, item('src_a'))
    store().updateItem(scene.id, 'src_a', { opacity: 5 })
    expect(store().scenes[scene.id]!.items[0]!.opacity).toBe(1)
    store().updateItem(scene.id, 'src_a', { opacity: -5 })
    expect(store().scenes[scene.id]!.items[0]!.opacity).toBe(0)
  })

  it('preserves hidden items in the configuration', () => {
    const scene = store().createScene('A')
    store().addItem(scene.id, item('src_a'))
    store().updateItem(scene.id, 'src_a', { visible: false })
    expect(store().scenes[scene.id]!.items).toHaveLength(1)
    expect(store().scenes[scene.id]!.items[0]!.visible).toBe(false)
  })
})

describe('moveItemLayer', () => {
  function setupThree() {
    const scene = store().createScene('A')
    store().addItem(scene.id, item('a', 0))
    store().addItem(scene.id, item('b', 1))
    store().addItem(scene.id, item('c', 2))
    return scene.id
  }

  const layersInOrder = (sceneId: string) =>
    [...store().scenes[sceneId]!.items]
      .sort((left, right) => left.layer - right.layer)
      .map((candidate) => candidate.sourceId)

  it('moves an item forward', () => {
    const sceneId = setupThree()
    store().moveItemLayer(sceneId, 'a', 'up')
    expect(layersInOrder(sceneId)).toEqual(['b', 'a', 'c'])
  })

  it('moves an item backward', () => {
    const sceneId = setupThree()
    store().moveItemLayer(sceneId, 'c', 'down')
    expect(layersInOrder(sceneId)).toEqual(['a', 'c', 'b'])
  })

  it('brings an item to the front and sends it to the back', () => {
    const sceneId = setupThree()
    store().moveItemLayer(sceneId, 'a', 'front')
    expect(layersInOrder(sceneId)).toEqual(['b', 'c', 'a'])
    store().moveItemLayer(sceneId, 'a', 'back')
    expect(layersInOrder(sceneId)).toEqual(['a', 'b', 'c'])
  })

  it('reindexes densely so layers never collide', () => {
    const sceneId = setupThree()
    store().moveItemLayer(sceneId, 'a', 'front')
    const layers = store().scenes[sceneId]!.items.map((candidate) => candidate.layer).sort()
    expect(layers).toEqual([0, 1, 2])
  })

  it('is a no-op at the ends', () => {
    const sceneId = setupThree()
    const before = store().revision
    store().moveItemLayer(sceneId, 'c', 'up')
    expect(store().revision).toBe(before)
  })
})

describe('reorderScene', () => {
  it('reorders and reindexes', () => {
    const a = store().createScene('A')
    const b = store().createScene('B')
    const c = store().createScene('C')
    store().reorderScene(c.id, 0)
    expect(store().order).toEqual([c.id, a.id, b.id])
    expect(store().scenes[c.id]?.order).toBe(0)
    expect(store().scenes[a.id]?.order).toBe(1)
  })

  it('clamps an out-of-range index', () => {
    const a = store().createScene('A')
    const b = store().createScene('B')
    store().reorderScene(a.id, 99)
    expect(store().order).toEqual([b.id, a.id])
  })
})

describe('hydrate', () => {
  it('restores scenes, order and the active scene', () => {
    const scene = store().createScene('Saved')
    store().addItem(scene.id, item('src_a'))
    const snapshot = Object.values(store().scenes)
    const order = store().order

    store().clear()
    store().hydrate(snapshot, order, scene.id)

    expect(store().order).toEqual(order)
    expect(store().activeSceneId).toBe(scene.id)
    expect(store().scenes[scene.id]!.items).toHaveLength(1)
  })

  it('falls back to the first scene when the saved active id is stale', () => {
    const scene = store().createScene('A')
    const snapshot = Object.values(store().scenes)
    store().clear()
    store().hydrate(snapshot, [scene.id], 'scn_nonexistent')
    expect(store().activeSceneId).toBe(scene.id)
  })

  it('drops order entries for scenes that no longer exist', () => {
    const scene = store().createScene('A')
    const snapshot = Object.values(store().scenes)
    store().clear()
    store().hydrate(snapshot, ['scn_ghost', scene.id], scene.id)
    expect(store().order).toEqual([scene.id])
  })

  it('never restores a live transition', () => {
    const scene = store().createScene('A')
    const snapshot = Object.values(store().scenes)
    store().clear()
    store().hydrate(snapshot, [scene.id], scene.id)
    expect(store().transition).toBeNull()
    expect(store().previousSceneId).toBeNull()
  })
})
