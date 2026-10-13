import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { MediaSource } from '@/types/source'
import type { CaptureStatus } from '@/types/media'
import { streamRegistry } from '@/services/media/stream-registry'
import {
  applyVideoConstraints,
  requestCamera,
  trackDimensions,
} from '@/services/media/capture-service'
import { streamKeys } from '@/services/sources/source-factory'
import { toMediaError } from '@/utils/errors'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { useMediaSources } from './useMediaSources'

/**
 * The host camera.
 *
 * Owns one camera source for the production. `status` reflects the *actual*
 * track — it only becomes `'active'` after getUserMedia resolved and a live
 * video track exists — so the UI never shows an active camera that is not
 * running.
 */

export type CameraResolution = { width: number; height: number; label: string }

export const CAMERA_RESOLUTIONS: CameraResolution[] = [
  { width: 640, height: 360, label: '360p' },
  { width: 1280, height: 720, label: '720p' },
  { width: 1920, height: 1080, label: '1080p' },
]

export type UseCamera = {
  source: MediaSource | null
  status: CaptureStatus
  active: boolean
  deviceId: string | null
  mirrored: boolean
  stream: MediaStream | null
  start: (deviceId?: string | null) => Promise<boolean>
  stop: () => void
  switchDevice: (deviceId: string) => Promise<boolean>
  setMirrored: (mirrored: boolean) => void
  setResolution: (resolution: CameraResolution) => Promise<void>
  setFrameRate: (fps: number) => Promise<void>
  /** Re-acquire after a failure or an interruption. */
  retry: () => Promise<boolean>
}

export function useCamera(): UseCamera {
  const sourceMap = useSourceStore((state) => state.sources)
  const order = useSourceStore((state) => state.order)
  const updateSettings = useSourceStore((state) => state.updateSettings)
  const setStreamKey = useSourceStore((state) => state.setStreamKey)

  const status = useStudioStore((state) => state.cameraStatus)
  const setStatus = useStudioStore((state) => state.setCameraStatus)
  const setMediaError = useStudioStore((state) => state.setMediaError)
  const setCameraPermission = useStudioStore((state) => state.setCameraPermission)
  const showToast = useStudioStore((state) => state.showToast)


  const { addSource, replaceStream } = useMediaSources()

  // Preferences kept in a ref: changing them should not re-render the studio,
  // and they are only read at acquisition time.
  const preferences = useRef({ width: 1280, height: 720, frameRate: 30 })

  /** The host camera source, if one exists. */
  const source = useMemo(() => {
    for (const id of order) {
      const candidate = sourceMap[id]
      if (candidate?.type === 'camera') return candidate
    }
    return null
  }, [order, sourceMap])

  const deviceId =
    source?.settings.kind === 'camera' ? source.settings.deviceId : null
  const mirrored = source?.settings.kind === 'camera' ? source.settings.mirrored : false
  const stream = source?.streamKey ? streamRegistry.getStream(source.streamKey) : null

  const start = useCallback(
    async (requestedDeviceId?: string | null): Promise<boolean> => {
      const targetDeviceId = requestedDeviceId ?? deviceId
      setStatus('requesting')
      setMediaError(null)

      try {
        const mediaStream = await requestCamera({
          deviceId: targetDeviceId,
          ...preferences.current,
        })

        const videoTrack = mediaStream.getVideoTracks()[0]
        if (!videoTrack) {
          // getUserMedia resolved but gave no video track. Treat as a failure
          // rather than reporting an active camera with nothing in it.
          for (const track of mediaStream.getTracks()) track.stop()
          setStatus('error')
          setMediaError({
            code: 'not-readable',
            message: 'The camera started but produced no video track.',
            technical: null,
            at: Date.now(),
          })
          return false
        }

        // The settled deviceId is authoritative: the browser may well have
        // given us a different camera than the one requested.
        const settledDeviceId = videoTrack.getSettings().deviceId ?? targetDeviceId ?? null
        const key = streamKeys.camera(settledDeviceId)
        streamRegistry.register(key, mediaStream)
        setCameraPermission('granted')

        if (source) {
          // Reuse the existing source: `replaceStream` releases the old
          // capture only once nothing else references it.
          replaceStream(source.id, key)
          updateSettings(source.id, {
            kind: 'camera',
            deviceId: settledDeviceId,
            mirrored,
          })
        } else {
          const dimensions = trackDimensions(videoTrack)
          void dimensions
          addSource({
            name: 'Camera',
            type: 'camera',
            streamKey: key,
            settings: { kind: 'camera', deviceId: settledDeviceId, mirrored: false },
            // A camera carries no audio here — the microphone is a separate
            // source, so there is nothing to put in the mixer.
            addToMixer: false,
          })
        }

        setStatus('active')
        return true
      } catch (error) {
        const mediaErr = toMediaError(error)
        setMediaError(mediaErr)
        if (mediaErr.code === 'not-allowed') {
          setCameraPermission('denied')
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
      mirrored,
      replaceStream,
      setCameraPermission,
      setMediaError,
      setStatus,
      source,
      updateSettings,
    ],
  )

  /**
   * Stop the camera but keep the source definition, so its placement, crop and
   * layer survive and `start()` restores the shot exactly.
   */
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
    async (nextDeviceId: string): Promise<boolean> => {
      // Acquire first, then release: if the new device fails, the operator is
      // still on air with the old one instead of going black.
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

  const setMirrored = useCallback(
    (next: boolean) => {
      if (!source || source.settings.kind !== 'camera') return
      updateSettings(source.id, { ...source.settings, mirrored: next })
    },
    [source, updateSettings],
  )

  /**
   * Change resolution on the live track where possible, falling back to a full
   * re-acquire. `applyConstraints` avoids a visible drop-out, so it is tried
   * first.
   */
  const setResolution = useCallback(
    async (resolution: CameraResolution) => {
      preferences.current = { ...preferences.current, ...resolution }
      const key = source?.streamKey
      const track = key ? streamRegistry.getStream(key)?.getVideoTracks()[0] : null
      if (!track) return
      const applied = await applyVideoConstraints(
        track,
        resolution.width,
        resolution.height,
        preferences.current.frameRate,
      )
      if (!applied) {
        showToast('Re-acquiring the camera at the new resolution…', 'info')
        await start()
      }
    },
    [showToast, source, start],
  )

  const setFrameRate = useCallback(
    async (fps: number) => {
      preferences.current = { ...preferences.current, frameRate: fps }
      const key = source?.streamKey
      const track = key ? streamRegistry.getStream(key)?.getVideoTracks()[0] : null
      if (!track) return
      const applied = await applyVideoConstraints(
        track,
        preferences.current.width,
        preferences.current.height,
        fps,
      )
      if (!applied) await start()
    },
    [source, start],
  )

  /**
   * Keep `status` honest when the browser ends the track behind our back —
   * device unplugged, OS privacy shutter, another app grabbing the camera.
   */
  useEffect(() => {
    return streamRegistry.onStreamEnded((key, reason) => {
      const current = useSourceStore.getState().sources[source?.id ?? '']
      if (!current || current.streamKey !== key) return
      setStreamKey(current.id, null)
      if (reason === 'ended') {
        setStatus('unavailable')
        setMediaError({
          code: 'not-readable',
          message:
            'The camera stopped unexpectedly. It may have been unplugged or taken by another application.',
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
    mirrored,
    stream,
    start,
    stop,
    switchDevice,
    setMirrored,
    setResolution,
    setFrameRate,
    retry: () => start(),
  }
}
