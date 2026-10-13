import { useCallback, useEffect, useMemo } from 'react'
import type { MediaSource } from '@/types/source'
import type { CaptureStatus } from '@/types/media'
import { streamRegistry } from '@/services/media/stream-registry'
import { requestMicrophone } from '@/services/media/capture-service'
import { streamKeys } from '@/services/sources/source-factory'
import { toMediaError } from '@/utils/errors'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { useAudioStore } from '@/stores/audioStore'
import { useMediaSources } from './useMediaSources'

/**
 * The host microphone.
 *
 * MUTE IS A TRACK OPERATION HERE
 * ------------------------------
 * `setMuted` sets `track.enabled = false`, which stops samples at the source —
 * nothing downstream can hear or record a disabled track. That is different
 * from the mixer's `mutedInMix`, which merely excludes the channel from the
 * program bus while leaving capture and metering running.
 *
 * `muted` therefore reports the real track state, read back from the track
 * rather than from a local boolean, so the button can never disagree with what
 * the hardware is doing.
 */

export type UseMicrophone = {
  source: MediaSource | null
  status: CaptureStatus
  active: boolean
  deviceId: string | null
  /** True when the track is disabled — capture is live but samples are cut. */
  muted: boolean
  stream: MediaStream | null
  start: (deviceId?: string | null) => Promise<boolean>
  stop: () => void
  switchDevice: (deviceId: string) => Promise<boolean>
  setMuted: (muted: boolean) => void
  toggleMuted: () => void
  retry: () => Promise<boolean>
}

export function useMicrophone(): UseMicrophone {
  const sourceMap = useSourceStore((state) => state.sources)
  const order = useSourceStore((state) => state.order)
  const updateSettings = useSourceStore((state) => state.updateSettings)
  const setStreamKey = useSourceStore((state) => state.setStreamKey)
  const setMutedInStore = useSourceStore((state) => state.setMuted)

  const status = useStudioStore((state) => state.microphoneStatus)
  const setStatus = useStudioStore((state) => state.setMicrophoneStatus)
  const setMediaError = useStudioStore((state) => state.setMediaError)
  const setPermission = useStudioStore((state) => state.setMicrophonePermission)

  const upsertChannel = useAudioStore((state) => state.upsertChannel)
  const { addSource, replaceStream } = useMediaSources()

  const source = useMemo(() => {
    for (const id of order) {
      const candidate = sourceMap[id]
      if (candidate?.type === 'microphone') return candidate
    }
    return null
  }, [order, sourceMap])

  /**
   * `track.enabled` is not observable, so it has to be mirrored.
   *
   * The mirror lives in the **store**, not in local state. Several components
   * call this hook — the guest view's controls and the control-channel handler,
   * for two — and a per-instance `useState` meant they disagreed: a remote mute
   * disabled the track and updated one instance while another kept rendering
   * "Mute". Every write reads the value back off the track first, so the shared
   * mirror still cannot drift from the hardware.
   */
  const trackMuted = source?.muted ?? false

  const deviceId = source?.settings.kind === 'microphone' ? source.settings.deviceId : null
  const stream = source?.streamKey ? streamRegistry.getStream(source.streamKey) : null

  const start = useCallback(
    async (requestedDeviceId?: string | null): Promise<boolean> => {
      const targetDeviceId = requestedDeviceId ?? deviceId
      setStatus('requesting')
      setMediaError(null)

      try {
        const mediaStream = await requestMicrophone(targetDeviceId)
        const audioTrack = mediaStream.getAudioTracks()[0]
        if (!audioTrack) {
          for (const track of mediaStream.getTracks()) track.stop()
          setStatus('error')
          setMediaError({
            code: 'not-readable',
            message: 'The microphone started but produced no audio track.',
            technical: null,
            at: Date.now(),
          })
          return false
        }

        const settledDeviceId = audioTrack.getSettings().deviceId ?? targetDeviceId ?? null
        const key = streamKeys.microphone(settledDeviceId)
        streamRegistry.register(key, mediaStream)
        setPermission('granted')

        if (source) {
          replaceStream(source.id, key)
          updateSettings(source.id, { kind: 'microphone', deviceId: settledDeviceId })
          upsertChannel({
            id: source.id,
            sourceId: source.id,
            kind: 'host-mic',
            label: source.name,
            volume: useAudioStore.getState().channels[source.id]?.volume ?? 1,
            gainDb: useAudioStore.getState().channels[source.id]?.gainDb ?? 0,
            mutedInMix: useAudioStore.getState().channels[source.id]?.mutedInMix ?? false,
            monitoring: false,
          })
        } else {
          addSource({
            name: 'Host Mic',
            type: 'microphone',
            streamKey: key,
            settings: { kind: 'microphone', deviceId: settledDeviceId },
            mixerKind: 'host-mic',
            // Audio-only: nothing to draw, so it is not placed in a scene.
            addToScene: false,
          })
        }

        setStatus('active')
        return true
      } catch (error) {
        const mediaErr = toMediaError(error)
        setMediaError(mediaErr)
        if (mediaErr.code === 'not-allowed') {
          setPermission('denied')
          setStatus('denied')
        } else if (mediaErr.code === 'not-found') {
          setStatus('unavailable')
        } else {
          setStatus('error')
        }
        return false
      }
    },
    [
      addSource,
      deviceId,
      replaceStream,
      setMediaError,
      setPermission,
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
    if (key) streamRegistry.release(key)
    setStatus('idle')
  }, [setStatus, setStreamKey, source])

  const switchDevice = useCallback(
    async (nextDeviceId: string) => {
      const previousKey = source?.streamKey ?? null
      const ok = await start(nextDeviceId)
      if (ok && previousKey) {
        const stillUsed = Object.values(useSourceStore.getState().sources).some(
          (candidate) => candidate.streamKey === previousKey,
        )
        if (!stillUsed) streamRegistry.release(previousKey)
      }
      return ok
    },
    [source, start],
  )

  /** Disable the track itself: no samples reach the mixer or the recording. */
  const setMuted = useCallback(
    (muted: boolean) => {
      if (!source?.streamKey) return
      const mediaStream = streamRegistry.getStream(source.streamKey)
      if (!mediaStream) return
      for (const track of mediaStream.getAudioTracks()) {
        track.enabled = !muted
      }
      // Read back from the track rather than trusting the write.
      const actual = mediaStream.getAudioTracks().every((track) => !track.enabled)
      setMutedInStore(source.id, actual)
    },
    [setMutedInStore, source],
  )

  const toggleMuted = useCallback(() => setMuted(!trackMuted), [setMuted, trackMuted])

  /** Resync the shared mirror whenever the underlying stream changes. */
  useEffect(() => {
    const sourceId = source?.id
    if (!sourceId) return
    if (!source?.streamKey) {
      setMutedInStore(sourceId, false)
      return
    }
    const mediaStream = streamRegistry.getStream(source.streamKey)
    if (!mediaStream) return
    const tracks = mediaStream.getAudioTracks()
    setMutedInStore(sourceId, tracks.length > 0 && tracks.every((track) => !track.enabled))
  }, [setMutedInStore, source?.id, source?.streamKey])

  useEffect(() => {
    return streamRegistry.onStreamEnded((key, reason) => {
      const current = useSourceStore.getState().sources[source?.id ?? '']
      if (!current || current.streamKey !== key) return
      setStreamKey(current.id, null)
      if (reason === 'ended') {
        setStatus('unavailable')
        setMediaError({
          code: 'not-readable',
          message: 'The microphone stopped unexpectedly. It may have been disconnected.',
          technical: null,
          at: Date.now(),
        })
      }
    })
  }, [setMediaError, setStatus, setStreamKey, source?.id])

  return {
    source,
    status,
    active: status === 'active' && Boolean(source?.streamKey),
    deviceId,
    muted: trackMuted,
    stream,
    start,
    stop,
    switchDevice,
    setMuted,
    toggleMuted,
    retry: () => start(),
  }
}
