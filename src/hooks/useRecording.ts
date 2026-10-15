import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RecordingEntry, RecordingFormat, RecordingStatus } from '@/types/recording'
import { compositor } from '@/services/composition/compositor'
import { audioMixer } from '@/services/audio/audio-mixer'
import { recordingEngine } from '@/services/recording/recording-engine'
import type { RecordingResult } from '@/services/recording/recording-engine'
import { listSupportedFormats, selectRecordingFormat } from '@/services/recording/mime'
import { finalizeRecording } from '@/services/recording/finalize'
import {
  appendChunk,
  beginRecording,
  deleteRecording,
  estimateStorage,
  finishRecording,
  requestPersistentStorage,
  setRecordingFormat,
} from '@/services/persistence/recording-store'
import { createRecordingId } from '@/utils/id'
import { formatTimestamp } from '@/utils/format'
import { useRecordingStore } from '@/stores/recordingStore'
import { useStudioStore } from '@/stores/studioStore'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Recording controls over the composed program output.
 *
 * The engine captures the *program canvas* and the *mixer's output*, so
 * everything the operator did — scene switches, transforms, crops, hidden
 * sources, mutes, fader moves — is in the file because there is no second
 * render or mix path.
 *
 * STORAGE
 * -------
 * The library row is opened before the first frame, every timeslice goes
 * straight to IndexedDB, and the row is marked complete only after the last
 * chunk has landed. The browser never holds the recording in memory, and an
 * interrupted recording is recovered from its chunks on the next load.
 *
 * On Stop the stored file is rewritten, without re-encoding, into a
 * standard MP4 or an indexed WebM, so it reports its length, seeks, and
 * opens in editors. The status stays `finalizing` until that is done.
 */

/** Refuse to start with less headroom than this. */
const MIN_FREE_BYTES = 200 * 1024 * 1024

export type UseRecording = {
  status: RecordingStatus
  elapsedMs: number
  format: RecordingFormat | null
  supportedFormats: RecordingFormat[]
  canRecord: boolean
  canPause: boolean
  isRecording: boolean
  error: ReturnType<typeof useRecordingStore.getState>['error']

  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  /** Discard an in-flight recording without saving it. */
  cancel: () => void
  dismissError: () => void
}

export function useRecording(): UseRecording {
  const status = useRecordingStore((state) => state.status)
  const elapsedMs = useRecordingStore((state) => state.elapsedMs)
  const format = useRecordingStore((state) => state.format)
  const error = useRecordingStore((state) => state.error)

  const setStatus = useRecordingStore((state) => state.setStatus)
  const setElapsed = useRecordingStore((state) => state.setElapsed)
  const setFormat = useRecordingStore((state) => state.setFormat)
  const setError = useRecordingStore((state) => state.setError)
  const addEntry = useRecordingStore((state) => state.addEntry)

  const session = useStudioStore((state) => state.session)
  const showToast = useStudioStore((state) => state.showToast)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)

  const frameRate = useSettingsStore((state) => state.settings.output.frameRate)

  const supportedFormats = useMemo(() => listSupportedFormats(), [])
  const canRecord = supportedFormats.length > 0

  const sessionRef = useRef(session)
  sessionRef.current = session
  /** The row being written, for the duration of one recording. */
  const activeRef = useRef<RecordingEntry | null>(null)

  const handleComplete = useCallback(
    async (result: RecordingResult) => {
      const active = activeRef.current
      activeRef.current = null
      compositor.lockSize(false)
      if (!active) return

      try {
        const final = await finalizeRecording({
          id: active.id,
          mimeType: result.mimeType,
          durationMs: result.durationMs,
          bytes: result.bytes,
        })
        const patch = {
          durationMs: final.durationMs,
          size: final.size,
          mimeType: final.mimeType,
          extension: final.extension,
        }
        await finishRecording(active.id, patch)
        addEntry({ ...active, ...patch, persisted: true })
        showToast('Recording saved to this device.', 'success')
        if (final.warning) showToast(final.warning, 'info')
      } catch (persistError) {
        setError({
          code: 'persist-failed',
          message:
            persistError instanceof Error
              ? persistError.message
              : 'The recording could not be finalized in storage.',
          recoverable: true,
          at: Date.now(),
        })
      }
      setStatus('complete')
    },
    [addEntry, setError, setStatus, showToast],
  )

  useEffect(() => {
    recordingEngine.setEvents({
      // The engine reports `complete` once capture ends; the file is not done
      // until it has been rewritten, so this hook announces completion.
      onStatusChange: (next) => setStatus(next === 'complete' ? 'finalizing' : next),
      onTick: setElapsed,
      onError: (recordingError) => {
        compositor.lockSize(false)
        setError(recordingError)
        setStatus('error')
        // Whatever reached storage is kept as an interrupted recording the
        // library can recover; the row is not deleted.
        activeRef.current = null
      },
      onComplete: (result) => void handleComplete(result),
    })
    return () => recordingEngine.setEvents({})
  }, [handleComplete, setElapsed, setError, setStatus])

  useEffect(() => {
    setFormat(selectRecordingFormat())
  }, [setFormat])

  const start = useCallback(async () => {
    const canvas = compositor.getCanvas()
    if (!canvas) {
      setError({
        code: 'no-video-track',
        message: 'The program canvas is not ready yet. Wait for the preview to appear and retry.',
        recoverable: true,
        at: Date.now(),
      })
      return
    }
    setError(null)

    const storage = await estimateStorage()
    if (storage && storage.quota > 0 && storage.quota - storage.usage < MIN_FREE_BYTES) {
      setError({
        code: 'quota-exceeded',
        message: `Only ${Math.round((storage.quota - storage.usage) / 1024 / 1024)} MB of storage is free. Delete old recordings before starting a new one.`,
        recoverable: true,
        at: Date.now(),
      })
      return
    }
    void requestPersistentStorage()

    await audioMixer.resume()
    const audioStream = audioMixer.getProgramStream()
    if (!audioStream) showToast('Recording video only — the audio mixer is not available.', 'info')

    const id = createRecordingId()
    const startedAt = Date.now()
    const entry: RecordingEntry = {
      id,
      sessionId: sessionRef.current?.id ?? 'unknown',
      name: `${sessionRef.current?.name ?? 'LiveDeck'} — ${formatTimestamp(startedAt)}`,
      mimeType: selectRecordingFormat()?.mimeType ?? 'video/webm',
      extension: selectRecordingFormat()?.extension ?? 'webm',
      size: 0,
      durationMs: 0,
      width: compositor.getOutputSize().width,
      height: compositor.getOutputSize().height,
      frameRate,
      createdAt: startedAt,
      persisted: true,
    }
    try {
      await beginRecording(entry, startedAt)
    } catch (storeError) {
      setError({
        code: 'persist-failed',
        message:
          storeError instanceof Error
            ? `Storage is unavailable, so the recording cannot be kept: ${storeError.message}`
            : 'Storage is unavailable, so the recording cannot be kept.',
        recoverable: true,
        at: Date.now(),
      })
      return
    }
    activeRef.current = entry

    compositor.lockSize(true)
    const started = await recordingEngine.start({
      canvas,
      audioStream,
      frameRate,
      sink: (index, chunk, at) => appendChunk(id, index, chunk, at),
    })

    if (started) {
      setElapsed(0)
      const chosen = recordingEngine.getFormat()
      setFormat(chosen)
      if (chosen) {
        activeRef.current = { ...entry, mimeType: chosen.mimeType, extension: chosen.extension }
        // Recovery reads this if the page goes away mid-recording.
        void setRecordingFormat(id, chosen.mimeType, chosen.extension).catch(() => undefined)
      }
    } else {
      compositor.lockSize(false)
      activeRef.current = null
      void deleteRecording(id).catch(() => undefined)
    }
  }, [frameRate, setElapsed, setError, setFormat, showToast])

  const stop = useCallback(() => recordingEngine.stop(), [])
  const pause = useCallback(() => recordingEngine.pause(), [])
  const resume = useCallback(() => recordingEngine.resume(), [])

  const cancel = useCallback(() => {
    requestConfirm({
      title: 'Discard this recording?',
      message: 'Everything recorded so far will be thrown away. This cannot be undone.',
      confirmLabel: 'Discard recording',
      destructive: true,
      onConfirm: () => {
        const active = activeRef.current
        activeRef.current = null
        recordingEngine.cancel()
        compositor.lockSize(false)
        if (active) void deleteRecording(active.id).catch(() => undefined)
        setElapsed(0)
        setStatus('idle')
      },
    })
  }, [requestConfirm, setElapsed, setStatus])

  /**
   * Warn before a reload or close while recording. The chunks already stored
   * survive and are recovered on the next load, but the last slice and the
   * duration header are not written until `stop`.
   */
  useEffect(() => {
    if (status !== 'recording' && status !== 'paused') return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      return ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [status])

  return {
    status,
    elapsedMs,
    format,
    supportedFormats,
    canRecord,
    canPause: recordingEngine.canPause(),
    isRecording: status === 'recording' || status === 'paused',
    error,
    start,
    pause,
    resume,
    stop,
    cancel,
    dismissError: () => setError(null),
  }
}
