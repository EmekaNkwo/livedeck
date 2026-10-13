import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MediaSource } from '@/types/source'
import type { CaptureStatus } from '@/types/media'
import { streamRegistry } from '@/services/media/stream-registry'
import { describeDisplaySurface, requestScreenShare } from '@/services/media/capture-service'
import { streamKeys } from '@/services/sources/source-factory'
import { isUserCancellation, toMediaError } from '@/utils/errors'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { useAudioStore } from '@/stores/audioStore'
import { useMediaSources } from './useMediaSources'

/**
 * Screen, window and tab capture.
 *
 * WHAT THE BROWSER CONTROLS, NOT US
 * ---------------------------------
 * `getDisplayMedia` always shows the browser's own picker. The application
 * cannot enumerate available windows, cannot pre-select a target, and cannot
 * know what the user picked beyond whatever `getSettings().displaySurface`
 * reports (Chrome does; others do not). The UI says so rather than implying
 * programmatic control.
 *
 * DISPLAY AUDIO IS NOT GUARANTEED
 * -------------------------------
 * `audio: true` is a request. Whether a track arrives depends on the OS, the
 * browser and the surface chosen — Chrome on Windows can share tab and system
 * audio, macOS usually cannot share a whole screen's audio, and Firefox and
 * Safari largely do not offer it. So the hook inspects the *actual* tracks and
 * reports `hasDisplayAudio` from reality. Display audio gets its own mixer
 * channel, kept separate from the microphone.
 */

export type UseScreenShare = {
  source: MediaSource | null
  status: CaptureStatus
  active: boolean
  stream: MediaStream | null
  /** True only when a display audio track actually materialized. */
  hasDisplayAudio: boolean
  /** "Browser tab", "Entire screen", … when the browser tells us. */
  surfaceLabel: string | null
  /** Set when audio was requested but the platform did not provide it. */
  audioUnavailableReason: string | null
  start: (options?: { withAudio?: boolean }) => Promise<boolean>
  stop: () => void
  toggle: () => Promise<void>
}

export function useScreenShare(): UseScreenShare {
  const sourceMap = useSourceStore((state) => state.sources)
  const order = useSourceStore((state) => state.order)
  const setStreamKey = useSourceStore((state) => state.setStreamKey)
  const updateSettings = useSourceStore((state) => state.updateSettings)

  const status = useStudioStore((state) => state.screenStatus)
  const setStatus = useStudioStore((state) => state.setScreenStatus)
  const setMediaError = useStudioStore((state) => state.setMediaError)
  const showToast = useStudioStore((state) => state.showToast)

  const upsertChannel = useAudioStore((state) => state.upsertChannel)
  const removeChannel = useAudioStore((state) => state.removeChannel)

  const { addSource, replaceStream } = useMediaSources()

  const [surfaceLabel, setSurfaceLabel] = useState<string | null>(null)
  const [audioUnavailableReason, setAudioUnavailableReason] = useState<string | null>(null)

  const source = useMemo(() => {
    for (const id of order) {
      const candidate = sourceMap[id]
      if (candidate?.type === 'screen') return candidate
    }
    return null
  }, [order, sourceMap])

  const stream = source?.streamKey ? streamRegistry.getStream(source.streamKey) : null
  const hasDisplayAudio = (stream?.getAudioTracks().length ?? 0) > 0

  const start = useCallback(
    async (options?: { withAudio?: boolean }): Promise<boolean> => {
      const withAudio = options?.withAudio ?? true
      setStatus('requesting')
      setMediaError(null)
      setAudioUnavailableReason(null)

      try {
        const mediaStream = await requestScreenShare(withAudio)
        const videoTrack = mediaStream.getVideoTracks()[0]
        if (!videoTrack) {
          for (const track of mediaStream.getTracks()) track.stop()
          setStatus('error')
          setMediaError({
            code: 'not-readable',
            message: 'Screen sharing started but produced no video track.',
            technical: null,
            at: Date.now(),
          })
          return false
        }

        const key = streamKeys.screen()
        streamRegistry.register(key, mediaStream)
        setSurfaceLabel(describeDisplaySurface(videoTrack))

        const audioTracks = mediaStream.getAudioTracks()
        if (withAudio && audioTracks.length === 0) {
          setAudioUnavailableReason(
            'This platform did not provide a display audio track. That depends on your operating ' +
              'system, browser and the surface you picked — on many setups only a browser tab can ' +
              'share audio. Screen video is unaffected.',
          )
        }

        let screenSource = source
        if (screenSource) {
          replaceStream(screenSource.id, key)
          updateSettings(screenSource.id, {
            kind: 'screen',
            withSystemAudio: audioTracks.length > 0,
          })
        } else {
          screenSource = addSource({
            name: 'Screen',
            type: 'screen',
            streamKey: key,
            settings: { kind: 'screen', withSystemAudio: audioTracks.length > 0 },
            // The mixer channel is added below, but only if audio arrived.
            addToMixer: false,
          })
        }

        // A display-audio channel is created only when there is a real track,
        // so the mixer never shows a strip that can carry no signal.
        if (audioTracks.length > 0) {
          upsertChannel({
            id: screenSource.id,
            sourceId: screenSource.id,
            kind: 'display',
            label: `${screenSource.name} audio`,
            volume: 0.8,
            gainDb: 0,
            mutedInMix: false,
            monitoring: false,
          })
        } else {
          removeChannel(screenSource.id)
        }

        setStatus('active')
        return true
      } catch (error) {
        const mediaErr = toMediaError(error)
        if (isUserCancellation(mediaErr)) {
          // Dismissing the picker is not a failure. Chrome reports it as
          // NotAllowedError, indistinguishable from a blocked permission, so
          // both are treated as a benign cancellation here.
          setStatus('idle')
          setMediaError(null)
          return false
        }
        setMediaError(mediaErr)
        setStatus(mediaErr.code === 'unsupported' ? 'unavailable' : 'error')
        return false
      }
    },
    [
      addSource,
      removeChannel,
      replaceStream,
      setMediaError,
      setStatus,
      source,
      updateSettings,
      upsertChannel,
    ],
  )

  const stop = useCallback(() => {
    if (!source) {
      setStatus('idle')
      return
    }
    const key = source.streamKey
    setStreamKey(source.id, null)
    removeChannel(source.id)
    if (key) streamRegistry.release(key)
    setSurfaceLabel(null)
    setAudioUnavailableReason(null)
    setStatus('idle')
  }, [removeChannel, setStatus, setStreamKey, source])

  const toggle = useCallback(async () => {
    if (status === 'active' && source?.streamKey) {
      stop()
      return
    }
    await start()
  }, [source?.streamKey, start, status, stop])

  /**
   * The browser's own "Stop sharing" button ends the track without telling the
   * page directly. The registry turns that into a `streamEnded` event, which
   * this effect converts into application state — so the UI updates itself
   * automatically rather than claiming to still be sharing.
   */
  useEffect(() => {
    return streamRegistry.onStreamEnded((key, reason) => {
      if (key !== streamKeys.screen()) return
      const current = Object.values(useSourceStore.getState().sources).find(
        (candidate) => candidate.type === 'screen' && candidate.streamKey === key,
      )
      if (current) {
        setStreamKey(current.id, null)
        removeChannel(current.id)
      }
      setSurfaceLabel(null)
      setAudioUnavailableReason(null)
      setStatus('idle')
      if (reason === 'ended') {
        showToast('Screen sharing stopped.', 'info')
      }
    })
  }, [removeChannel, setStatus, setStreamKey, showToast])

  return {
    source,
    status,
    active: status === 'active' && Boolean(source?.streamKey),
    stream,
    hasDisplayAudio,
    surfaceLabel,
    audioUnavailableReason,
    start,
    stop,
    toggle,
  }
}
