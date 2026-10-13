import type { DeviceInfo, MediaDeviceKind, PermissionStatus } from '@/types/media'
import { detectCapabilities } from '@/lib/capabilities'
import { mediaError } from '@/utils/errors'

/**
 * Device enumeration and permission inspection.
 *
 * Browsers return devices with empty `label`s until the user has granted
 * permission at least once, so this service substitutes positional names
 * ("Camera 1") rather than rendering blank entries.
 */

export type DeviceList = {
  cameras: DeviceInfo[]
  microphones: DeviceInfo[]
  speakers: DeviceInfo[]
}

export const EMPTY_DEVICE_LIST: DeviceList = { cameras: [], microphones: [], speakers: [] }

export async function enumerateDevices(): Promise<DeviceList> {
  const caps = detectCapabilities()
  if (!caps.enumerateDevices) return EMPTY_DEVICE_LIST

  const devices = await navigator.mediaDevices.enumerateDevices()
  const cameras: DeviceInfo[] = []
  const microphones: DeviceInfo[] = []
  const speakers: DeviceInfo[] = []

  for (const device of devices) {
    // Some browsers emit a placeholder entry with an empty deviceId before
    // permission is granted. It cannot be selected, so drop it.
    if (!device.deviceId) continue
    const kind = device.kind as MediaDeviceKind
    const bucket = kind === 'videoinput' ? cameras : kind === 'audioinput' ? microphones : speakers
    const info: DeviceInfo = {
      deviceId: device.deviceId,
      label: device.label || fallbackLabel(kind, bucket.length),
      kind,
      groupId: device.groupId,
    }
    bucket.push(info)
  }
  return { cameras, microphones, speakers }
}

function fallbackLabel(kind: MediaDeviceKind, index: number): string {
  const base = kind === 'videoinput' ? 'Camera' : kind === 'audioinput' ? 'Microphone' : 'Speaker'
  return `${base} ${index + 1}`
}

/** Subscribe to hot-plug events. Returns a cleanup function. */
export function onDeviceChange(listener: () => void): () => void {
  const caps = detectCapabilities()
  if (!caps.deviceChangeEvents) return () => {}
  navigator.mediaDevices.addEventListener('devicechange', listener)
  return () => navigator.mediaDevices.removeEventListener('devicechange', listener)
}

/**
 * Read a permission state without prompting.
 *
 * The Permissions API does not cover `camera`/`microphone` everywhere (Firefox
 * notably rejects the query), so an unsupported query resolves to `'unknown'`
 * and the UI falls back to inferring state from the next capture attempt.
 */
export async function queryPermission(name: 'camera' | 'microphone'): Promise<PermissionStatus> {
  const permissions = navigator.permissions as Permissions | undefined
  if (!permissions || typeof permissions.query !== 'function') return 'unknown'
  try {
    const status = await permissions.query({ name: name as PermissionName })
    switch (status.state) {
      case 'granted':
        return 'granted'
      case 'denied':
        return 'denied'
      default:
        return 'prompt'
    }
  } catch {
    return 'unknown'
  }
}

/** Watch a permission for external changes (user flipping the site setting). */
export async function watchPermission(
  name: 'camera' | 'microphone',
  listener: (status: PermissionStatus) => void,
): Promise<() => void> {
  const permissions = navigator.permissions as Permissions | undefined
  if (!permissions || typeof permissions.query !== 'function') return () => {}
  try {
    const status = await permissions.query({ name: name as PermissionName })
    const handler = () => {
      listener(
        status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'prompt',
      )
    }
    status.addEventListener('change', handler)
    return () => status.removeEventListener('change', handler)
  } catch {
    return () => {}
  }
}

/**
 * Guard every capture entry point: a clear, actionable error beats a raw
 * DOMException from a browser that never supported the API.
 */
export function assertCaptureSupported(kind: 'user' | 'display'): void {
  const caps = detectCapabilities()
  if (!caps.secureContext) {
    throw Object.assign(new Error(mediaError('insecure-context').message), {
      name: 'InsecureContextError',
    })
  }
  const supported = kind === 'user' ? caps.getUserMedia : caps.getDisplayMedia
  if (!supported) {
    throw Object.assign(new Error(mediaError('unsupported').message), { name: 'TypeError' })
  }
}
