import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY_TRANSFORM } from '@/types/geometry'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSolo } from './useSolo'

/**
 * Solo.
 *
 * The property that matters is reversibility: soloing hides the rest of the
 * scene and resizes one item, and exiting must put the scene back exactly as
 * it was — including an item that was *already* hidden before solo, which must
 * not become visible on the way out.
 */

function setupScene() {
  useSceneStore.getState().clear()
  useSourceStore.getState().clear()

  const scene = useSceneStore.getState().createScene('Main')
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    useSceneStore.getState().addItem(scene.id, {
      sourceId: id,
      transform: { ...IDENTITY_TRANSFORM, x: 0.1 * index, width: 0.3, height: 0.3 },
      visible: true,
      locked: false,
      layer: index,
      mirrored: false,
      opacity: 1,
    })
  }
  return scene.id
}

const items = (sceneId: string) => useSceneStore.getState().scenes[sceneId]!.items
const item = (sceneId: string, sourceId: string) =>
  items(sceneId).find((candidate) => candidate.sourceId === sourceId)!

beforeEach(() => {
  useSettingsStore.getState().reset()
})

describe('useSolo', () => {
  it('starts with nothing soloed', () => {
    setupScene()
    const { result } = renderHook(() => useSolo())
    expect(result.current.soloedSourceId).toBeNull()
    expect(result.current.isSoloed('a')).toBe(false)
  })

  it('hides every other item and fills the canvas with the soloed one', () => {
    const sceneId = setupScene()
    const { result } = renderHook(() => useSolo())

    act(() => result.current.toggleSolo('b'))

    expect(result.current.soloedSourceId).toBe('b')
    expect(item(sceneId, 'a').visible).toBe(false)
    expect(item(sceneId, 'c').visible).toBe(false)
    expect(item(sceneId, 'b').visible).toBe(true)
    // Fitted to the canvas, so it is bigger than the 0.3 it started at.
    expect(item(sceneId, 'b').transform.width).toBeGreaterThan(0.3)
    // And brought to the front.
    expect(item(sceneId, 'b').layer).toBeGreaterThan(item(sceneId, 'c').layer)
  })

  it('restores the scene exactly on exit', () => {
    const sceneId = setupScene()
    const before = items(sceneId).map((entry) => ({
      sourceId: entry.sourceId,
      visible: entry.visible,
      layer: entry.layer,
      width: entry.transform.width,
    }))

    const { result } = renderHook(() => useSolo())
    act(() => result.current.toggleSolo('b'))
    act(() => result.current.clearSolo())

    expect(result.current.soloedSourceId).toBeNull()
    for (const entry of before) {
      const restored = item(sceneId, entry.sourceId)
      expect(restored.visible).toBe(entry.visible)
      expect(restored.layer).toBe(entry.layer)
      expect(restored.transform.width).toBeCloseTo(entry.width, 6)
    }
  })

  it('does not reveal an item that was already hidden before solo', () => {
    const sceneId = setupScene()
    useSceneStore.getState().updateItem(sceneId, 'c', { visible: false })

    const { result } = renderHook(() => useSolo())
    act(() => result.current.toggleSolo('a'))
    act(() => result.current.clearSolo())

    // 'c' was hidden by the operator, not by solo — it must stay hidden.
    expect(item(sceneId, 'c').visible).toBe(false)
    expect(item(sceneId, 'b').visible).toBe(true)
  })

  it('toggles off when the same source is soloed twice', () => {
    const sceneId = setupScene()
    const { result } = renderHook(() => useSolo())

    act(() => result.current.toggleSolo('a'))
    act(() => result.current.toggleSolo('a'))

    expect(result.current.soloedSourceId).toBeNull()
    expect(item(sceneId, 'b').visible).toBe(true)
  })

  it('switches solo directly from one source to another', () => {
    const sceneId = setupScene()
    const { result } = renderHook(() => useSolo())

    act(() => result.current.toggleSolo('a'))
    act(() => result.current.toggleSolo('c'))

    expect(result.current.soloedSourceId).toBe('c')
    expect(item(sceneId, 'c').visible).toBe(true)
    expect(item(sceneId, 'a').visible).toBe(false)
    expect(item(sceneId, 'b').visible).toBe(false)
  })

  it('restores the original scene after switching solos, not the soloed state', () => {
    // The bug this guards: snapshotting while already soloed would capture
    // "everything hidden" as the state to return to.
    const sceneId = setupScene()
    const { result } = renderHook(() => useSolo())

    act(() => result.current.toggleSolo('a'))
    act(() => result.current.toggleSolo('c'))
    act(() => result.current.clearSolo())

    expect(item(sceneId, 'a').visible).toBe(true)
    expect(item(sceneId, 'b').visible).toBe(true)
    expect(item(sceneId, 'c').visible).toBe(true)
  })

  it('ignores an unknown source', () => {
    const sceneId = setupScene()
    const { result } = renderHook(() => useSolo())

    act(() => result.current.toggleSolo('missing'))

    expect(result.current.soloedSourceId).toBeNull()
    expect(item(sceneId, 'a').visible).toBe(true)
  })

  it('tolerates the scene being deleted while soloed', () => {
    const sceneId = setupScene()
    useSceneStore.getState().createScene('Second')

    const { result } = renderHook(() => useSolo())
    act(() => result.current.toggleSolo('a'))
    act(() => useSceneStore.getState().deleteScene(sceneId))

    // Restoring into a scene that no longer exists must not throw.
    expect(() => act(() => result.current.clearSolo())).not.toThrow()
    expect(result.current.soloedSourceId).toBeNull()
  })
})
