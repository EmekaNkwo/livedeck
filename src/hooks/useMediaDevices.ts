import { useCallback, useEffect, useState } from 'react'
import type { DeviceInfo, PermissionStatus } from '@/types/media'
import type { DeviceList } from '@/services/media/device-service'
import {
  EMPTY_DEVICE_LIST,
  enumerateDevices,
  onDeviceChange,
  queryPermission,
  watchPermission,
} from '@/services/media/device-service'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Device enumeration and permission state.
 *
 * Single responsibility: *what devices exist and may we use them*. Acquiring a
 * stream is `useCamera` / `useMicrophone`'s job.
 */

export type UseMediaDevices = {
  devices: DeviceList
  cameras: DeviceInfo[]
  microphones: DeviceInfo[]
  cameraPermission: PermissionStatus
  microphonePermission: PermissionStatus
  loading: boolean
  refresh: () => Promise<void>
  /** True when labels are hidden because permission has never been granted. */
  labelsHidden: boolean
}

export function useMediaDevices(): UseMediaDevices {
  const [devices, setDevices] = useState<DeviceList>(EMPTY_DEVICE_LIST)
  const [loading, setLoading] = useState(true)

  const cameraPermission = useStudioStore((state) => state.cameraPermission)
  const microphonePermission = useStudioStore((state) => state.microphonePermission)
  const setCameraPermission = useStudioStore((state) => state.setCameraPermission)
  const setMicrophonePermission = useStudioStore((state) => state.setMicrophonePermission)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setDevices(await enumerateDevices())
    } catch {
      setDevices(EMPTY_DEVICE_LIST)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Hot-plug: a newly connected webcam should appear without a reload. The
  // event also fires when permission is first granted, which is when real
  // device labels become readable.
  useEffect(() => onDeviceChange(() => void refresh()), [refresh])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [camera, microphone] = await Promise.all([
        queryPermission('camera'),
        queryPermission('microphone'),
      ])
      if (cancelled) return
      setCameraPermission(camera)
      setMicrophonePermission(microphone)
    })()
    return () => {
      cancelled = true
    }
  }, [setCameraPermission, setMicrophonePermission])

  // React to the user flipping the site permission in browser settings.
  useEffect(() => {
    let disposeCamera: (() => void) | undefined
    let disposeMicrophone: (() => void) | undefined
    let cancelled = false

    void (async () => {
      const camera = await watchPermission('camera', (status) => {
        setCameraPermission(status)
        void refresh()
      })
      const microphone = await watchPermission('microphone', (status) => {
        setMicrophonePermission(status)
        void refresh()
      })
      if (cancelled) {
        camera()
        microphone()
        return
      }
      disposeCamera = camera
      disposeMicrophone = microphone
    })()

    return () => {
      cancelled = true
      disposeCamera?.()
      disposeMicrophone?.()
    }
  }, [refresh, setCameraPermission, setMicrophonePermission])

  const labelsHidden =
    devices.cameras.length + devices.microphones.length > 0 &&
    [...devices.cameras, ...devices.microphones].every((device) =>
      /^(Camera|Microphone) \d+$/.test(device.label),
    )

  return {
    devices,
    cameras: devices.cameras,
    microphones: devices.microphones,
    cameraPermission,
    microphonePermission,
    loading,
    refresh,
    labelsHidden,
  }
}
