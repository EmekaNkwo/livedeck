import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Scene, SceneTransition, TransitionType } from '@/types/scene'
import { useSceneStore } from '@/stores/sceneStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Scene creation, switching and transition bookkeeping.
 *
 * Switching a scene changes the *program output* — the compositor reads the
 * active scene id from the store every frame — rather than only highlighting a
 * thumbnail. Transitions are tracked here and cleared when they complete, with
 * the compositor doing the actual blending.
 */

export type UseSceneManager = {
  scenes: Scene[]
  activeScene: Scene | null
  activeSceneId: string | null
  transitioning: boolean

  createScene: (name?: string) => Scene
  renameScene: (sceneId: string, name: string) => void
  duplicateScene: (sceneId: string) => Scene | null
  /** Asks for confirmation when the scene has content that would be lost. */
  requestDeleteScene: (sceneId: string) => void
  deleteScene: (sceneId: string) => void
  reorderScene: (sceneId: string, toIndex: number) => void
  setTransition: (sceneId: string, transition: SceneTransition) => void
  setTransitionType: (sceneId: string, type: TransitionType) => void
  setTransitionDuration: (sceneId: string, durationMs: number) => void
  activateScene: (sceneId: string, options?: { immediate?: boolean }) => void
  /** Move to the next/previous scene in the strip — used by hotkeys. */
  stepScene: (direction: 1 | -1) => void
}

export function useSceneManager(): UseSceneManager {
  const scenesRecord = useSceneStore((state) => state.scenes)
  const order = useSceneStore((state) => state.order)
  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const transition = useSceneStore((state) => state.transition)

  const createSceneInStore = useSceneStore((state) => state.createScene)
  const renameScene = useSceneStore((state) => state.renameScene)
  const duplicateScene = useSceneStore((state) => state.duplicateScene)
  const deleteSceneInStore = useSceneStore((state) => state.deleteScene)
  const reorderScene = useSceneStore((state) => state.reorderScene)
  const setTransitionInStore = useSceneStore((state) => state.setTransition)
  const activateSceneInStore = useSceneStore((state) => state.activateScene)
  const completeTransition = useSceneStore((state) => state.completeTransition)

  const requestConfirm = useStudioStore((state) => state.requestConfirm)
  const selectSource = useStudioStore((state) => state.selectSource)
  const showToast = useStudioStore((state) => state.showToast)

  const scenes = useMemo(
    () => order.map((id) => scenesRecord[id]).filter((scene): scene is Scene => Boolean(scene)),
    [order, scenesRecord],
  )
  const activeScene = activeSceneId ? (scenesRecord[activeSceneId] ?? null) : null

  /**
   * Clear the transition once it has run its course.
   *
   * A timer rather than a render loop: the compositor already renders the
   * blend from `startedAt`, so React only needs to know when the transition is
   * over — exactly one state update per switch instead of one per frame.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!transition) return
    const elapsed = performance.now() - transition.startedAt
    const remaining = Math.max(0, transition.durationMs - elapsed)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      completeTransition()
    }, remaining)
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [completeTransition, transition])

  const createScene = useCallback(
    (name?: string) => {
      const scene = createSceneInStore(name)
      // Switch to it immediately, and without a transition: you create a scene
      // in order to build it, so landing on the old one would be wrong. An
      // empty new scene also has nothing to dissolve from.
      activateSceneInStore(scene.id, { immediate: true })
      selectSource(null)
      showToast(`Scene “${scene.name}” created.`, 'success')
      return scene
    },
    [activateSceneInStore, createSceneInStore, selectSource, showToast],
  )

  const deleteScene = useCallback(
    (sceneId: string) => {
      deleteSceneInStore(sceneId)
      selectSource(null)
    },
    [deleteSceneInStore, selectSource],
  )

  /**
   * Deleting a scene is hard to undo, so confirm it — but only when there is
   * actually something to lose. Confirming an empty scene is friction with no
   * benefit, and the last scene cannot be deleted at all because the program
   * output must always have somewhere to point.
   */
  const requestDeleteScene = useCallback(
    (sceneId: string) => {
      const scene = useSceneStore.getState().scenes[sceneId]
      if (!scene) return

      if (useSceneStore.getState().order.length <= 1) {
        showToast('A production needs at least one scene.', 'error')
        return
      }

      if (scene.items.length === 0) {
        deleteScene(sceneId)
        return
      }

      requestConfirm({
        title: `Delete “${scene.name}”?`,
        message: `This scene contains ${scene.items.length} source ${
          scene.items.length === 1 ? 'placement' : 'placements'
        }. The sources stay in your library, but this layout cannot be recovered.`,
        confirmLabel: 'Delete scene',
        destructive: true,
        onConfirm: () => deleteScene(sceneId),
      })
    },
    [deleteScene, requestConfirm, showToast],
  )

  const setTransitionType = useCallback(
    (sceneId: string, type: TransitionType) => {
      const scene = useSceneStore.getState().scenes[sceneId]
      if (!scene) return
      setTransitionInStore(sceneId, { ...scene.transition, type })
    },
    [setTransitionInStore],
  )

  const setTransitionDuration = useCallback(
    (sceneId: string, durationMs: number) => {
      const scene = useSceneStore.getState().scenes[sceneId]
      if (!scene) return
      setTransitionInStore(sceneId, { ...scene.transition, durationMs })
    },
    [setTransitionInStore],
  )

  const activateScene = useCallback(
    (sceneId: string, options?: { immediate?: boolean }) => {
      activateSceneInStore(sceneId, options)
      // The previous selection may not exist in the new scene, so clear it
      // rather than leaving the properties panel showing a stale item.
      const next = useSceneStore.getState().scenes[sceneId]
      const selected = useStudioStore.getState().selectedSourceId
      if (selected && !next?.items.some((item) => item.sourceId === selected)) {
        selectSource(null)
      }
    },
    [activateSceneInStore, selectSource],
  )

  const stepScene = useCallback(
    (direction: 1 | -1) => {
      const state = useSceneStore.getState()
      if (state.order.length === 0) return
      const index = state.activeSceneId ? state.order.indexOf(state.activeSceneId) : -1
      const nextIndex = (index + direction + state.order.length) % state.order.length
      const nextId = state.order[nextIndex]
      if (nextId) activateScene(nextId)
    },
    [activateScene],
  )

  return {
    scenes,
    activeScene,
    activeSceneId,
    transitioning: transition !== null,
    createScene,
    renameScene,
    duplicateScene,
    requestDeleteScene,
    deleteScene,
    reorderScene,
    setTransition: setTransitionInStore,
    setTransitionType,
    setTransitionDuration,
    activateScene,
    stepScene,
  }
}
