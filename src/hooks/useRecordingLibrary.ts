import { useCallback, useEffect, useState } from 'react'
import type { RecordingEntry } from '@/types/recording'
import {
  deleteRecording,
  estimateStorage,
  listRecordings,
  loadRecordingBlob,
} from '@/services/persistence/recording-store'
import {
  createTrackedUrl,
  downloadBlob,
  revokeTrackedUrl,
  toSafeFilename,
} from '@/services/persistence/object-urls'
import { recoverInterruptedRecordings } from '@/services/recording/recovery'
import { useRecordingStore } from '@/stores/recordingStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * The local recording library.
 *
 * Recordings live on the user's device — IndexedDB for persisted ones, memory
 * for ones that could not be stored. Nothing is ever uploaded.
 *
 * Preview object URLs are created through the tracked-URL helper and revoked
 * when the preview changes or the component unmounts, so a Blob is never
 * pinned in memory by a stale URL.
 */

export type UseRecordingLibrary = {
  entries: RecordingEntry[]
  loading: boolean
  previewId: string | null
  previewUrl: string | null
  previewError: string | null
  storage: { usage: number; quota: number } | null

  refresh: () => Promise<void>
  openPreview: (id: string) => Promise<void>
  closePreview: () => void
  download: (id: string) => Promise<void>
  requestDelete: (id: string) => void
  rename: (id: string, name: string) => void
}

const PREVIEW_URL_KEY = 'recording-preview'

export function useRecordingLibrary(): UseRecordingLibrary {
  const entries = useRecordingStore((state) => state.entries)
  const volatileBlobs = useRecordingStore((state) => state.volatileBlobs)
  const previewId = useRecordingStore((state) => state.previewId)
  const libraryLoaded = useRecordingStore((state) => state.libraryLoaded)

  const setEntries = useRecordingStore((state) => state.setEntries)
  const removeEntry = useRecordingStore((state) => state.removeEntry)
  const renameEntry = useRecordingStore((state) => state.renameEntry)
  const setPreview = useRecordingStore((state) => state.setPreview)
  const setLibraryLoaded = useRecordingStore((state) => state.setLibraryLoaded)

  const showToast = useStudioStore((state) => state.showToast)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)

  const [loading, setLoading] = useState(!libraryLoaded)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const { recovered, failed } = await recoverInterruptedRecordings()
      for (const failure of failed) {
        showToast(`“${failure.name}” could not be recovered yet: ${failure.reason}`, 'error')
      }
      if (recovered > 0) {
        showToast(
          `Recovered ${recovered} recording${recovered === 1 ? '' : 's'} that ${recovered === 1 ? 'was' : 'were'} interrupted. Check the library.`,
          'info',
        )
      }
      const stored = await listRecordings()
      // Merge: keep in-memory-only entries that are not in IndexedDB, so a
      // recording that failed to persist does not vanish from the list.
      const storedIds = new Set(stored.map((entry) => entry.id))
      const memoryOnly = useRecordingStore
        .getState()
        .entries.filter((entry) => !entry.persisted && !storedIds.has(entry.id))
      setEntries([...stored, ...memoryOnly])
    } catch {
      // IndexedDB unavailable (private mode, blocked). In-memory entries from
      // this session still work, so this is not surfaced as an error.
    } finally {
      setLoading(false)
      setLibraryLoaded(true)
    }
    setStorage(await estimateStorage())
  }, [setEntries, setLibraryLoaded, showToast])

  useEffect(() => {
    if (libraryLoaded) {
      setLoading(false)
      return
    }
    void refresh()
  }, [libraryLoaded, refresh])

  /** Resolve a blob from memory first, then from IndexedDB. */
  const resolveBlob = useCallback(
    async (id: string): Promise<Blob | null> => {
      const inMemory = volatileBlobs.get(id)
      if (inMemory) return inMemory
      try {
        return await loadRecordingBlob(id)
      } catch {
        return null
      }
    },
    [volatileBlobs],
  )

  const openPreview = useCallback(
    async (id: string) => {
      setPreviewError(null)
      const blob = await resolveBlob(id)
      if (!blob) {
        setPreviewError(
          'This recording’s data could not be found. It may have been stored only in memory and ' +
            'lost when the page reloaded.',
        )
        setPreview(id)
        setPreviewUrl(null)
        return
      }
      setPreviewUrl(createTrackedUrl(PREVIEW_URL_KEY, blob))
      setPreview(id)
    },
    [resolveBlob, setPreview],
  )

  const closePreview = useCallback(() => {
    revokeTrackedUrl(PREVIEW_URL_KEY)
    setPreviewUrl(null)
    setPreviewError(null)
    setPreview(null)
  }, [setPreview])

  const download = useCallback(
    async (id: string) => {
      const entry = useRecordingStore.getState().entries.find((candidate) => candidate.id === id)
      if (!entry) return
      const blob = await resolveBlob(id)
      if (!blob) {
        showToast('This recording’s data is no longer available.', 'error')
        return
      }
      // The extension comes from the MIME type the recorder actually produced,
      // so the file always matches its contents.
      downloadBlob(blob, toSafeFilename(entry.name, entry.extension))
    },
    [resolveBlob, showToast],
  )

  const performDelete = useCallback(
    async (id: string) => {
      if (useRecordingStore.getState().previewId === id) closePreview()
      removeEntry(id)
      try {
        await deleteRecording(id)
      } catch {
        // Already gone, or IndexedDB unavailable. The entry is removed from
        // the UI either way.
      }
      setStorage(await estimateStorage())
      showToast('Recording deleted.', 'info')
    },
    [closePreview, removeEntry, showToast],
  )

  const requestDelete = useCallback(
    (id: string) => {
      const entry = useRecordingStore.getState().entries.find((candidate) => candidate.id === id)
      if (!entry) return
      requestConfirm({
        title: 'Delete this recording?',
        message: `“${entry.name}” will be permanently removed from this device. Download it first if you want to keep it.`,
        confirmLabel: 'Delete recording',
        destructive: true,
        onConfirm: () => void performDelete(id),
      })
    },
    [performDelete, requestConfirm],
  )

  // Release the preview URL on unmount so the Blob can be collected.
  useEffect(() => () => revokeTrackedUrl(PREVIEW_URL_KEY), [])

  return {
    entries,
    loading,
    previewId,
    previewUrl,
    previewError,
    storage,
    refresh,
    openPreview,
    closePreview,
    download,
    requestDelete,
    rename: renameEntry,
  }
}
