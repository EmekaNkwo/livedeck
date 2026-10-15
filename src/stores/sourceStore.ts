import { create } from 'zustand'
import type { MediaSource, SourceSettings, SourceType } from '@/types/source'
import { createSourceId, uniqueName } from '@/utils/id'
import { clamp } from '@/utils/geometry'

/**
 * The source library.
 *
 * Holds only serializable source *definitions*. Live MediaStreams live in the
 * StreamRegistry and are referenced by `streamKey`, which is what lets several
 * sources share one capture and lets a source be deleted without stopping a
 * stream that something else is still using.
 *
 * Note that `visible`, `locked` and `layer` on a source are the defaults
 * applied when it is placed into a scene; the authoritative per-scene values
 * live on the scene's items (see sceneStore).
 */

export type CreateSourceInput = {
  name: string
  type: SourceType
  settings: SourceSettings
  streamKey?: string | null
  volume?: number
  muted?: boolean
}

type SourceState = {
  sources: Record<string, MediaSource>
  /** Library display order. */
  order: string[]
  /** Bumped by every mutation so the compositor can skip redundant frames. */
  revision: number

  addSource: (input: CreateSourceInput) => MediaSource
  removeSource: (sourceId: string) => void
  renameSource: (sourceId: string, name: string) => void
  updateSettings: (sourceId: string, settings: SourceSettings) => void
  setStreamKey: (sourceId: string, streamKey: string | null) => void
  setMuted: (sourceId: string, muted: boolean) => void
  setVolume: (sourceId: string, volume: number) => void
  setVisibleDefault: (sourceId: string, visible: boolean) => void
  setLockedDefault: (sourceId: string, locked: boolean) => void
  duplicateSource: (sourceId: string) => MediaSource | null
  reorder: (sourceId: string, toIndex: number) => void

  hydrate: (sources: MediaSource[], order: string[]) => void
  clear: () => void
}

export const useSourceStore = create<SourceState>()((set, get) => ({
  sources: {},
  order: [],
  revision: 0,

  addSource: (input) => {
    const id = createSourceId()
    const existingNames = Object.values(get().sources).map((source) => source.name)
    const source: MediaSource = {
      id,
      name: uniqueName(input.name, existingNames),
      type: input.type,
      visible: true,
      locked: false,
      muted: input.muted ?? false,
      // New sources go on top of whatever is already in the library.
      layer: get().order.length,
      settings: input.settings,
      streamKey: input.streamKey ?? null,
      volume: input.volume ?? 1,
      createdAt: Date.now(),
    }
    set((state) => ({
      sources: { ...state.sources, [id]: source },
      order: [...state.order, id],
      revision: state.revision + 1,
    }))
    return source
  },

  /**
   * Remove a source definition.
   *
   * Deliberately does NOT touch the StreamRegistry: releasing the stream is
   * the caller's job (see `useMediaSources.removeSource`), because only the
   * caller knows whether the reference it holds should be dropped. Keeping
   * those concerns separate is what prevents "deleting a duplicated camera
   * source kills the original's video".
   */
  removeSource: (sourceId) =>
    set((state) => {
      if (!state.sources[sourceId]) return state
      const sources = { ...state.sources }
      delete sources[sourceId]
      return {
        sources,
        order: state.order.filter((id) => id !== sourceId),
        revision: state.revision + 1,
      }
    }),

  renameSource: (sourceId, name) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source) return state
      const trimmed = name.trim()
      if (!trimmed) return state
      const others = Object.values(state.sources)
        .filter((candidate) => candidate.id !== sourceId)
        .map((candidate) => candidate.name)
      return {
        sources: {
          ...state.sources,
          [sourceId]: { ...source, name: uniqueName(trimmed, others) },
        },
        revision: state.revision + 1,
      }
    }),

  updateSettings: (sourceId, settings) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source) return state
      return {
        sources: { ...state.sources, [sourceId]: { ...source, settings } },
        revision: state.revision + 1,
      }
    }),

  setStreamKey: (sourceId, streamKey) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source || source.streamKey === streamKey) return state
      return {
        sources: { ...state.sources, [sourceId]: { ...source, streamKey } },
        revision: state.revision + 1,
      }
    }),

  setMuted: (sourceId, muted) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source) return state
      return { sources: { ...state.sources, [sourceId]: { ...source, muted } } }
    }),

  setVolume: (sourceId, volume) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source) return state
      return {
        sources: {
          ...state.sources,
          [sourceId]: { ...source, volume: clamp(volume, 0, 1.5) },
        },
      }
    }),

  setVisibleDefault: (sourceId, visible) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source) return state
      return { sources: { ...state.sources, [sourceId]: { ...source, visible } } }
    }),

  setLockedDefault: (sourceId, locked) =>
    set((state) => {
      const source = state.sources[sourceId]
      if (!source) return state
      return { sources: { ...state.sources, [sourceId]: { ...source, locked } } }
    }),

  /**
   * Duplicate a source definition.
   *
   * The clone *shares* the original's `streamKey` rather than acquiring a new
   * capture — two views of one camera is the point, and a second
   * getUserMedia call for the same device would often fail outright. The
   * caller retains an extra reference in the registry.
   */
  duplicateSource: (sourceId) => {
    const source = get().sources[sourceId]
    if (!source) return null
    const id = createSourceId()
    const existingNames = Object.values(get().sources).map((candidate) => candidate.name)
    const clone: MediaSource = {
      ...source,
      id,
      name: uniqueName(`${source.name} copy`, existingNames),
      createdAt: Date.now(),
    }
    set((state) => ({
      sources: { ...state.sources, [id]: clone },
      order: [...state.order, id],
      revision: state.revision + 1,
    }))
    return clone
  },

  reorder: (sourceId, toIndex) =>
    set((state) => {
      const from = state.order.indexOf(sourceId)
      if (from === -1) return state
      const target = clamp(Math.round(toIndex), 0, state.order.length - 1)
      if (from === target) return state
      const order = [...state.order]
      order.splice(from, 1)
      order.splice(target, 0, sourceId)
      return { order, revision: state.revision + 1 }
    }),

  hydrate: (sources, order) =>
    set((state) => {
      const map: Record<string, MediaSource> = {}
      for (const source of sources) {
        // A persisted source never has a live stream — capture must be
        // re-acquired after a reload, with fresh permission if needed.
        map[source.id] = { ...source, streamKey: null }
      }
      // A corrupted saved order may repeat ids; each appears once.
      const known = [...new Set(order.filter((id) => map[id]))]
      const missing = sources.map((s) => s.id).filter((id) => !known.includes(id))
      return { sources: map, order: [...known, ...missing], revision: state.revision + 1 }
    }),

  clear: () => set((state) => ({ sources: {}, order: [], revision: state.revision + 1 })),
}))

/* ---------------------------------------------------------------- selectors */

export const selectSourceList = (state: SourceState): MediaSource[] =>
  state.order.map((id) => state.sources[id]).filter((s): s is MediaSource => Boolean(s))

export const selectSourceById =
  (sourceId: string | null) =>
  (state: SourceState): MediaSource | null =>
    sourceId ? (state.sources[sourceId] ?? null) : null

/** All sources sharing a stream key — used for refcount-safe teardown. */
export function sourcesUsingStream(state: SourceState, streamKey: string): MediaSource[] {
  return Object.values(state.sources).filter((source) => source.streamKey === streamKey)
}

/** Map form, for the compositor's per-frame lookups. */
export function sourcesAsMap(state: SourceState): ReadonlyMap<string, MediaSource> {
  return new Map(Object.entries(state.sources))
}
