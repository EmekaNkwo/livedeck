import type { VideoConstraintPreference } from '@/types/media'
import { assertCaptureSupported } from './device-service'

/**
 * Thin, typed wrappers over the capture APIs.
 *
 * These functions only *acquire* streams. They deliberately do not touch the
 * StreamRegistry or any store, so they stay trivially mockable in unit tests
 * and so stream ownership has exactly one home.
 */

export type CameraRequest = {
  deviceId: string | null
  width: number
  height: number
  frameRate: number
}

/**
 * Request a camera.
 *
 * `deviceId` is passed as an *ideal* rather than an exact constraint: an exact
 * deviceId fails outright when a device is unplugged between enumeration and
 * capture, whereas ideal degrades to the next best camera. Resolution and
 * frame rate are also ideal, because exact values make
 * `OverconstrainedError` far too easy to hit on built-in webcams.
 */
export async function requestCamera(request: CameraRequest): Promise<MediaStream> {
  assertCaptureSupported('user')
  const video: MediaTrackConstraints = {
    width: { ideal: request.width },
    height: { ideal: request.height },
    frameRate: { ideal: request.frameRate },
  }
  if (request.deviceId) video.deviceId = { ideal: request.deviceId }
  return navigator.mediaDevices.getUserMedia({ video, audio: false })
}

/**
 * Request a microphone.
 *
 * Browser-side processing is left on: these are the defaults a user expects
 * from a conferencing-grade input, and turning them off produces noticeably
 * worse recordings on laptop microphones.
 */
export async function requestMicrophone(deviceId: string | null): Promise<MediaStream> {
  assertCaptureSupported('user')
  const audio: MediaTrackConstraints = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
  }
  if (deviceId) audio.deviceId = { ideal: deviceId }
  return navigator.mediaDevices.getUserMedia({ video: false, audio })
}

/**
 * Request a screen, window or browser tab.
 *
 * IMPORTANT: which of those three the user may pick, and *which* screen or
 * window they pick, is decided entirely by the browser's native picker. The
 * application cannot choose a target programmatically, and it cannot read what
 * is available before the user chooses. `preferCurrentTab` and
 * `displaySurface` are hints only; browsers are free to ignore them.
 *
 * `audio: true` is a request, not a guarantee. Whether a display-audio track
 * materialises depends on the OS, the browser, and the surface the user picked
 * (Chrome on Windows offers tab and system audio; macOS generally offers
 * neither for whole screens; Firefox and Safari largely do not offer it at
 * all). Callers must inspect `stream.getAudioTracks()` rather than assume.
 */
export async function requestScreenShare(withAudio: boolean): Promise<MediaStream> {
  assertCaptureSupported('display')
  const constraints: DisplayMediaStreamOptions = {
    video: {
      frameRate: { ideal: 30 },
    },
    audio: withAudio,
  }
  return navigator.mediaDevices.getDisplayMedia(constraints)
}

/** Resolve a preference into a concrete camera request. */
export function toCameraRequest(preference: VideoConstraintPreference): CameraRequest {
  return {
    deviceId: preference.deviceId,
    width: preference.width,
    height: preference.height,
    frameRate: preference.frameRate,
  }
}

/**
 * Apply a new resolution / frame rate to a live track without re-prompting.
 * Returns false when the browser rejected the constraints, so the caller can
 * fall back to a full re-acquire.
 */
export async function applyVideoConstraints(
  track: MediaStreamTrack,
  width: number,
  height: number,
  frameRate: number,
): Promise<boolean> {
  if (typeof track.applyConstraints !== 'function') return false
  try {
    await track.applyConstraints({
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
    })
    return true
  } catch {
    return false
  }
}

/** Intrinsic dimensions the track actually settled on. */
export function trackDimensions(track: MediaStreamTrack): { width: number; height: number } {
  const settings = track.getSettings()
  return { width: settings.width ?? 0, height: settings.height ?? 0 }
}

/**
 * Describe the surface the user picked, when the browser tells us.
 * Chrome exposes `displaySurface`; others omit it, hence the null case.
 */
export function describeDisplaySurface(track: MediaStreamTrack): string | null {
  const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string }
  switch (settings.displaySurface) {
    case 'monitor':
      return 'Entire screen'
    case 'window':
      return 'Application window'
    case 'browser':
      return 'Browser tab'
    default:
      return null
  }
}
