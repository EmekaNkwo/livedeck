import { create } from 'zustand'
import type { ActiveTransition, Scene, SceneTransition } from '@/types/scene'
import { DEFAULT_TRANSITION } from '@/types/scene'
import type { SceneItem } from '@/types/source'
import type { SourceTransform } from '@/types/geometry'
import { createSceneId, uniqueName } from '@/utils/id'
import { clamp, normalizeTransform } from '@/utils/geometry'

/**
 * Scenes: saved compositions of sources, their transforms, order and
 * visibility.
 *
 * Scenes are always addressed by `id`. Names are editable labels and are never
 * used as keys, so renaming a scene cannot break a persisted reference.
 */

type SceneState = {
  scenes: Record<string, Scene>
  order: string[]
  activeSceneId: string | null
  /** The scene being transitioned away from; null outside a transition. */
  previousSceneId: string | null
  transition: ActiveTransition | null
  revision: number

  createScene: (name?: string) => Scene
  renameScene: (sceneId: string, name: string) => void
  duplicateScene: (sceneId: string) => Scene | null
  deleteScene: (sceneId: string) => void
  reorderScene: (sceneId: string, toIndex: number) => void
  setTransition: (sceneId: string, transition: SceneTransition) => void

  /** Switch the program output to `sceneId`, running its transition. */
  activateScene: (sceneId: string, options?: { immediate?: boolean }) => void
  /** Clear a finished transition. Called by the transition hook, not by UI. */
  completeTransition: () => void

  addItem: (sceneId: string, item: SceneItem) => void
  removeItem: (sceneId: string, sourceId: string) => void
  /** Remove a source from every scene. Used when a source is deleted. */
  removeSourceEverywhere: (sourceId: string) => void
  updateItem: (sceneId: string, sourceId: string, patch: Partial<SceneItem>) => void
  setItemTransform: (sceneId: string, sourceId: string, transform: SourceTransform) => void
  moveItemLayer: (sceneId: string, sourceId: string, direction: 'up' | 'down' | 'front' | 'back') => void

  hydrate: (scenes: Scene[], order: string[], activeSceneId: string | null) => void
  clear: () => void
}

export const useSceneStore = create<SceneState>()((set, get) => ({
  scenes: {},
  order: [],
  activeSceneId: null,
  previousSceneId: null,
  transition: null,
  revision: 0,

  createScene: (name) => {
    const id = createSceneId()
    const existingNames = Object.values(get().scenes).map((scene) => scene.name)
    const scene: Scene = {
      id,
      name: uniqueName(name?.trim() || `Scene ${get().order.length + 1}`, existingNames),
      order: get().order.length,
      transition: { ...DEFAULT_TRANSITION },
      items: [],
      createdAt: Date.now(),
    }
    set((state) => ({
      scenes: { ...state.scenes, [id]: scene },
      order: [...state.order, id],
      // First scene created becomes active immediately so the program output
      // is never left pointing at nothing.
      activeSceneId: state.activeSceneId ?? id,
      revision: state.revision + 1,
    }))
    return scene
  },

  renameScene: (sceneId, name) =>
    set((state) => {
      const scene = state.scenes[sceneId]
      if (!scene) return state
      const trimmed = name.trim()
      if (!trimmed) return state
      const others = Object.values(state.scenes)
        .filter((candidate) => candidate.id !== sceneId)
        .map((candidate) => candidate.name)
      return {
        scenes: { ...state.scenes, [sceneId]: { ...scene, name: uniqueName(trimmed, others) } },
        revision: state.revision + 1,
      }
    }),

  duplicateScene: (sceneId) => {
    const source = get().scenes[sceneId]
    if (!source) return null
    const id = createSceneId()
    const existingNames = Object.values(get().scenes).map((scene) => scene.name)
    const clone: Scene = {
      ...source,
      id,
      name: uniqueName(`${source.name} copy`, existingNames),
      order: get().order.length,
      // Deep-copy items so editing the clone cannot mutate the original.
      items: source.items.map((item) => ({
        ...item,
        transform: { ...item.transform, ...(item.transform.crop ? { crop: { ...item.transform.crop } } : {}) },
      })),
      createdAt: Date.now(),
    }
    const index = get().order.indexOf(sceneId)
    set((state) => {
      const order = [...state.order]
      order.splice(index + 1, 0, id)
      return {
        scenes: { ...state.scenes, [id]: clone },
        order,
        revision: state.revision + 1,
      }
    })
    return clone
  },

  deleteScene: (sceneId) =>
    set((state) => {
      if (!state.scenes[sceneId]) return state
      const scenes = { ...state.scenes }
      delete scenes[sceneId]
      const order = state.order.filter((id) => id !== sceneId)

      // Deleting the live scene must leave *something* on the program output.
      let activeSceneId = state.activeSceneId
      if (activeSceneId === sceneId) {
        const removedIndex = state.order.indexOf(sceneId)
        activeSceneId = order[Math.min(removedIndex, order.length - 1)] ?? null
      }

      return {
        scenes,
        order,
        activeSceneId,
        previousSceneId: state.previousSceneId === sceneId ? null : state.previousSceneId,
        transition: null,
        revision: state.revision + 1,
      }
    }),

  reorderScene: (sceneId, toIndex) =>
    set((state) => {
      const from = state.order.indexOf(sceneId)
      if (from === -1) return state
      const target = clamp(Math.round(toIndex), 0, state.order.length - 1)
      if (from === target) return state
      const order = [...state.order]
      order.splice(from, 1)
      order.splice(target, 0, sceneId)
      const scenes = { ...state.scenes }
      order.forEach((id, index) => {
        const scene = scenes[id]
        if (scene) scenes[id] = { ...scene, order: index }
      })
      return { scenes, order, revision: state.revision + 1 }
    }),

  setTransition: (sceneId, transition) =>
    set((state) => {
      const scene = state.scenes[sceneId]
      if (!scene) return state
      return {
        scenes: {
          ...state.scenes,
          [sceneId]: {
            ...scene,
            transition: {
              type: transition.type,
              durationMs: clamp(Math.round(transition.durationMs), 0, 3000),
            },
          },
        },
      }
    }),

  activateScene: (sceneId, options) =>
    set((state) => {
      const target = state.scenes[sceneId]
      if (!target) return state
      if (state.activeSceneId === sceneId) return state

      const fromId = state.activeSceneId
      const immediate = options?.immediate ?? false
      const transition = target.transition

      // A cut, a zero duration, or an explicit immediate switch needs no
      // transition bookkeeping at all.
      if (immediate || !fromId || transition.type === 'cut' || transition.durationMs <= 0) {
        return {
          activeSceneId: sceneId,
          previousSceneId: null,
          transition: null,
          revision: state.revision + 1,
        }
      }

      return {
        activeSceneId: sceneId,
        previousSceneId: fromId,
        transition: {
          fromSceneId: fromId,
          toSceneId: sceneId,
          type: transition.type,
          durationMs: transition.durationMs,
          // performance.now() — the compositor's clock, not Date.now().
          startedAt: performance.now(),
        },
        revision: state.revision + 1,
      }
    }),

  completeTransition: () =>
    set((state) => {
      if (!state.transition) return state
      return { transition: null, previousSceneId: null, revision: state.revision + 1 }
    }),

  addItem: (sceneId, item) =>
    set((state) => {
      const scene = state.scenes[sceneId]
      if (!scene) return state
      if (scene.items.some((existing) => existing.sourceId === item.sourceId)) return state
      return {
        scenes: {
          ...state.scenes,
          [sceneId]: {
            ...scene,
            items: [...scene.items, { ...item, transform: normalizeTransform(item.transform) }],
          },
        },
        revision: state.revision + 1,
      }
    }),

  removeItem: (sceneId, sourceId) =>
    set((state) => {
      const scene = state.scenes[sceneId]
      if (!scene) return state
      const items = scene.items.filter((item) => item.sourceId !== sourceId)
      if (items.length === scene.items.length) return state
      return {
        scenes: { ...state.scenes, [sceneId]: { ...scene, items } },
        revision: state.revision + 1,
      }
    }),

  removeSourceEverywhere: (sourceId) =>
    set((state) => {
      let changed = false
      const scenes: Record<string, Scene> = {}
      for (const [id, scene] of Object.entries(state.scenes)) {
        const items = scene.items.filter((item) => item.sourceId !== sourceId)
        if (items.length !== scene.items.length) {
          changed = true
          scenes[id] = { ...scene, items }
        } else {
          scenes[id] = scene
        }
      }
      if (!changed) return state
      return { scenes, revision: state.revision + 1 }
    }),

  updateItem: (sceneId, sourceId, patch) =>
    set((state) => {
      const scene = state.scenes[sceneId]
      if (!scene) return state
      let changed = false
      const items = scene.items.map((item) => {
        if (item.sourceId !== sourceId) return item
        changed = true
        const next = { ...item, ...patch }
        if (patch.transform) next.transform = normalizeTransform(patch.transform)
        if (patch.opacity !== undefined) next.opacity = clamp(patch.opacity, 0, 1)
        return next
      })
      if (!changed) return state
      return {
        scenes: { ...state.scenes, [sceneId]: { ...scene, items } },
        revision: state.revision + 1,
      }
    }),

  setItemTransform: (sceneId, sourceId, transform) => {
    get().updateItem(sceneId, sourceId, { transform })
  },

  moveItemLayer: (sceneId, sourceId, direction) =>
    set((state) => {
      const scene = state.scenes[sceneId]
      if (!scene) return state
      const target = scene.items.find((item) => item.sourceId === sourceId)
      if (!target) return state

      const sorted = [...scene.items].sort((a, b) => a.layer - b.layer)
      const index = sorted.findIndex((item) => item.sourceId === sourceId)
      if (index === -1) return state

      let newIndex = index
      switch (direction) {
        case 'up':
          newIndex = Math.min(sorted.length - 1, index + 1)
          break
        case 'down':
          newIndex = Math.max(0, index - 1)
          break
        case 'front':
          newIndex = sorted.length - 1
          break
        case 'back':
          newIndex = 0
          break
      }
      if (newIndex === index) return state

      sorted.splice(index, 1)
      sorted.splice(newIndex, 0, target)
      // Reindex densely so layer numbers never drift apart or collide.
      const relayered = sorted.map((item, position) => ({ ...item, layer: position }))
      const byId = new Map(relayered.map((item) => [item.sourceId, item]))

      return {
        scenes: {
          ...state.scenes,
          [sceneId]: {
            ...scene,
            items: scene.items.map((item) => byId.get(item.sourceId) ?? item),
          },
        },
        revision: state.revision + 1,
      }
    }),

  hydrate: (scenes, order, activeSceneId) =>
    set((state) => {
      const map: Record<string, Scene> = {}
      for (const scene of scenes) {
        map[scene.id] = {
          ...scene,
          items: scene.items.map((item) => ({
            ...item,
            transform: normalizeTransform(item.transform),
          })),
        }
      }
      const known = order.filter((id) => map[id])
      const missing = scenes.map((scene) => scene.id).filter((id) => !known.includes(id))
      const finalOrder = [...known, ...missing]
      return {
        scenes: map,
        order: finalOrder,
        activeSceneId:
          activeSceneId && map[activeSceneId] ? activeSceneId : (finalOrder[0] ?? null),
        previousSceneId: null,
        transition: null,
        revision: state.revision + 1,
      }
    }),

  clear: () =>
    set((state) => ({
      scenes: {},
      order: [],
      activeSceneId: null,
      previousSceneId: null,
      transition: null,
      revision: state.revision + 1,
    })),
}))

/* ---------------------------------------------------------------- selectors */

export const selectSceneList = (state: SceneState): Scene[] =>
  state.order.map((id) => state.scenes[id]).filter((s): s is Scene => Boolean(s))

export const selectActiveScene = (state: SceneState): Scene | null =>
  state.activeSceneId ? (state.scenes[state.activeSceneId] ?? null) : null

export const selectPreviousScene = (state: SceneState): Scene | null =>
  state.previousSceneId ? (state.scenes[state.previousSceneId] ?? null) : null

export const selectActiveItems = (state: SceneState): SceneItem[] =>
  selectActiveScene(state)?.items ?? []

export function selectItem(state: SceneState, sourceId: string | null): SceneItem | null {
  if (!sourceId) return null
  return selectActiveScene(state)?.items.find((item) => item.sourceId === sourceId) ?? null
}
