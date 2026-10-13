import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RecordingEntry, RecordingFormat, RecordingStatus } from '@/types/recording'
import { compositor } from '@/services/composition/compositor'
import { audioMixer } from '@/services/audio/audio-mixer'
import { recordingEngine } from '@/services/recording/recording-engine'
import type { RecordingResult } from '@/services/recording/recording-engine'
import { listSupportedFormats, selectRecordingFormat } from '@/services/recording/mime'
import { QuotaExceededError, saveRecording } from '@/services/persistence/recording-store'
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
 * Nothing reports success early: the entry is only added to the library after
 * MediaRecorder has fired `stop` and produced a non-empty blob.
 */

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

  // Session metadata is read inside the completion callback, which outlives the
  // render that registered it, so it is mirrored into a ref.
  const sessionRef = useRef(session)
  sessionRef.current = session

  /**
   * Persist a finished recording.
   *
   * On quota exhaustion the blob is kept in memory and the entry is marked
   * `persisted: false`, so the user can still download it. Nothing is silently
   * dropped, and nothing is uploaded anywhere.
   */
  const handleComplete = useCallback(
    async (result: RecordingResult) => {
      const id = createRecordingId()
      const entry: RecordingEntry = {
        id,
        sessionId: sessionRef.current?.id ?? 'unknown',
        name: `${sessionRef.current?.name ?? 'LiveDeck'} — ${formatTimestamp(Date.now())}`,
        mimeType: result.mimeType,
        extension: result.extension,
        size: result.blob.size,
        durationMs: result.durationMs,
        width: result.width,
        height: result.height,
        frameRate: result.frameRate,
        createdAt: Date.now(),
        persisted: false,
      }

      try {
        await saveRecording(entry, result.blob)
        addEntry({ ...entry, persisted: true }, result.blob)
        showToast('Recording saved to this device.', 'success')
      } catch (persistError) {
        addEntry(entry, result.blob)
        if (persistError instanceof QuotaExceededError) {
          setError({
            code: 'quota-exceeded',
            message:
              'There was not enough storage to keep this recording. It is ready to download, but ' +
              'it will be lost if you reload the page.',
            recoverable: true,
            at: Date.now(),
          })
        } else {
          setError({
            code: 'persist-failed',
            message:
              'The recording could not be stored for later. It is ready to download, but it will ' +
              'be lost if you reload the page.',
            recoverable: true,
            at: Date.now(),
          })
        }
      }

      /*
       * Deliberately NOT auto-selecting this entry for preview.
       *
       * The preview player needs an object URL, which only the library hook
       * creates (it owns that URL's lifetime and revocation). Setting the
       * preview id from here would render the player section with no source —
       * an empty, broken-looking panel. The library's Preview button loads the
       * blob and the URL together.
       */
      setStatus('complete')
    },
    [addEntry, setError, setStatus, showToast],
  )

  /** Wire engine callbacks once; they write to the store, not to local state. */
  useEffect(() => {
    recordingEngine.setEvents({
      onStatusChange: setStatus,
      onTick: setElapsed,
      onError: (recordingError) => {
        setError(recordingError)
        setStatus('error')
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

    // The AudioContext may still be suspended if the operator has not
    // interacted with an audio control yet. Resume it here — this call is
    // inside a click handler, so the browser allows it — otherwise the
    // recording would come out silent.
    await audioMixer.resume()
    const audioStream = audioMixer.getProgramStream()

    if (!audioStream) {
      showToast('Recording video only — the audio mixer is not available.', 'info')
    }

    const started = await recordingEngine.start({
      canvas,
      audioStream,
      frameRate,
    })

    if (started) {
      setElapsed(0)
      setFormat(recordingEngine.getFormat())
    }
  }, [frameRate, setElapsed, setError, setFormat, showToast])

  const stop = useCallback(() => recordingEngine.stop(), [])
  const pause = useCallback(() => recordingEngine.pause(), [])
  const resume = useCallback(() => recordingEngine.resume(), [])

  /** Discarding recorded footage is irreversible, so confirm it. */
  const cancel = useCallback(() => {
    requestConfirm({
      title: 'Discard this recording?',
      message: 'Everything recorded so far will be thrown away. This cannot be undone.',
      confirmLabel: 'Discard recording',
      destructive: true,
      onConfirm: () => {
        recordingEngine.cancel()
        setElapsed(0)
        setStatus('idle')
      },
    })
  }, [requestConfirm, setElapsed, setStatus])

  /**
   * Warn before a reload or close while recording.
   *
   * The browser will not let us finalize a file during `beforeunload`, so the
   * honest thing is to warn that the recording will be lost rather than
   * pretend it can be saved.
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
