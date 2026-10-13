import { create } from 'zustand'
import type {
  RecordingEntry,
  RecordingError,
  RecordingFormat,
  RecordingStatus,
} from '@/types/recording'

/**
 * Recording state and the local recording library.
 *
 * `entries` is metadata only. The video Blobs live in IndexedDB (or, when
 * persistence failed, in `volatileBlobs` for the lifetime of the page) — never
 * in this store and never in localStorage.
 */

type RecordingState = {
  status: RecordingStatus
  elapsedMs: number
  format: RecordingFormat | null
  error: RecordingError | null

  entries: RecordingEntry[]
  /** Blobs that could not be persisted: downloadable now, gone on reload. */
  volatileBlobs: Map<string, Blob>
  /** The entry currently open in the preview player. */
  previewId: string | null
  libraryLoaded: boolean

  setStatus: (status: RecordingStatus) => void
  setElapsed: (elapsedMs: number) => void
  setFormat: (format: RecordingFormat | null) => void
  setError: (error: RecordingError | null) => void

  setEntries: (entries: RecordingEntry[]) => void
  addEntry: (entry: RecordingEntry, volatileBlob?: Blob | null) => void
  removeEntry: (id: string) => void
  renameEntry: (id: string, name: string) => void
  setPreview: (id: string | null) => void
  setLibraryLoaded: (loaded: boolean) => void

  reset: () => void
}

export const useRecordingStore = create<RecordingState>()((set) => ({
  status: 'idle',
  elapsedMs: 0,
  format: null,
  error: null,

  entries: [],
  volatileBlobs: new Map(),
  previewId: null,
  libraryLoaded: false,

  setStatus: (status) => set({ status }),
  setElapsed: (elapsedMs) => set({ elapsedMs }),
  setFormat: (format) => set({ format }),
  setError: (error) => set({ error }),

  setEntries: (entries) =>
    set({ entries: [...entries].sort((a, b) => b.createdAt - a.createdAt) }),

  addEntry: (entry, volatileBlob) =>
    set((state) => {
      const volatileBlobs = new Map(state.volatileBlobs)
      if (volatileBlob) volatileBlobs.set(entry.id, volatileBlob)
      return {
        entries: [entry, ...state.entries.filter((existing) => existing.id !== entry.id)],
        volatileBlobs,
      }
    }),

  removeEntry: (id) =>
    set((state) => {
      const volatileBlobs = new Map(state.volatileBlobs)
      volatileBlobs.delete(id)
      return {
        entries: state.entries.filter((entry) => entry.id !== id),
        volatileBlobs,
        previewId: state.previewId === id ? null : state.previewId,
      }
    }),

  renameEntry: (id, name) =>
    set((state) => {
      const trimmed = name.trim()
      if (!trimmed) return state
      return {
        entries: state.entries.map((entry) =>
          entry.id === id ? { ...entry, name: trimmed } : entry,
        ),
      }
    }),

  setPreview: (previewId) => set({ previewId }),
  setLibraryLoaded: (libraryLoaded) => set({ libraryLoaded }),

  /** Clear in-flight recording state. The library survives. */
  reset: () => set({ status: 'idle', elapsedMs: 0, error: null }),
}))

/* ---------------------------------------------------------------- selectors */

export const selectIsRecording = (state: RecordingState): boolean =>
  state.status === 'recording' || state.status === 'paused'

export const selectIsBusy = (state: RecordingState): boolean =>
  state.status === 'starting' || state.status === 'finalizing'

export const selectPreviewEntry = (state: RecordingState): RecordingEntry | null =>
  state.previewId ? (state.entries.find((entry) => entry.id === state.previewId) ?? null) : null

export const selectEntryCount = (state: RecordingState): number => state.entries.length
