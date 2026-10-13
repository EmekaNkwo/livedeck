/**
 * Runtime feature detection.
 *
 * Every media feature in the studio is gated on a real capability check rather
 * than a user-agent guess, and the UI explains what is missing instead of
 * failing silently.
 */

export type Capabilities = {
  secureContext: boolean
  getUserMedia: boolean
  getDisplayMedia: boolean
  enumerateDevices: boolean
  deviceChangeEvents: boolean
  mediaRecorder: boolean
  canvasCaptureStream: boolean
  webAudio: boolean
  webRtc: boolean
  indexedDb: boolean
  /** `MediaRecorder.pause()` / `resume()`. Absent on some older WebKit builds. */
  recorderPause: boolean
}

let cached: Capabilities | null = null

export function detectCapabilities(): Capabilities {
  if (cached) return cached
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const win = typeof window === 'undefined' ? undefined : window

  const mediaDevices = nav?.mediaDevices
  const recorderAvailable = typeof win?.MediaRecorder === 'function'

  cached = {
    // getUserMedia is only exposed in a secure context, so this is the first
    // thing to check before blaming permissions for a failure.
    secureContext: win?.isSecureContext ?? false,
    getUserMedia: typeof mediaDevices?.getUserMedia === 'function',
    getDisplayMedia: typeof mediaDevices?.getDisplayMedia === 'function',
    enumerateDevices: typeof mediaDevices?.enumerateDevices === 'function',
    deviceChangeEvents: typeof mediaDevices?.addEventListener === 'function',
    mediaRecorder: recorderAvailable,
    canvasCaptureStream:
      typeof win?.HTMLCanvasElement === 'function' &&
      typeof win.HTMLCanvasElement.prototype.captureStream === 'function',
    webAudio: typeof win?.AudioContext === 'function',
    webRtc: typeof win?.RTCPeerConnection === 'function',
    indexedDb: typeof win?.indexedDB === 'object' && win.indexedDB !== null,
    recorderPause:
      recorderAvailable && typeof win?.MediaRecorder?.prototype?.pause === 'function',
  }
  return cached
}

/** Test seam: forget the memoized result. */
export function resetCapabilitiesCache(): void {
  cached = null
}

export type CapabilityGap = {
  feature: string
  detail: string
  /** Blocking gaps make the studio unusable; others degrade one feature. */
  blocking: boolean
}

/** Describe what is missing, for the diagnostics panel and the unsupported screen. */
export function findCapabilityGaps(caps = detectCapabilities()): CapabilityGap[] {
  const gaps: CapabilityGap[] = []
  if (!caps.secureContext) {
    gaps.push({
      feature: 'Secure context',
      detail:
        'Camera, microphone and screen capture require HTTPS or localhost. The page is not in a secure context.',
      blocking: true,
    })
  }
  if (!caps.getUserMedia) {
    gaps.push({
      feature: 'getUserMedia',
      detail: 'This browser cannot capture a camera or microphone.',
      blocking: true,
    })
  }
  if (!caps.canvasCaptureStream) {
    gaps.push({
      feature: 'canvas.captureStream',
      detail: 'The program canvas cannot be turned into a video track, so recording is unavailable.',
      blocking: true,
    })
  }
  if (!caps.getDisplayMedia) {
    gaps.push({
      feature: 'getDisplayMedia',
      detail: 'Screen sharing is unavailable in this browser.',
      blocking: false,
    })
  }
  if (!caps.mediaRecorder) {
    gaps.push({
      feature: 'MediaRecorder',
      detail: 'Recording is unavailable. Composition and preview still work.',
      blocking: false,
    })
  }
  if (!caps.webAudio) {
    gaps.push({
      feature: 'Web Audio API',
      detail: 'Audio mixing, level meters and recorded audio are unavailable.',
      blocking: false,
    })
  }
  if (!caps.webRtc) {
    gaps.push({
      feature: 'RTCPeerConnection',
      detail: 'Peer Connection Mode is unavailable. Local Studio Mode is unaffected.',
      blocking: false,
    })
  }
  if (!caps.indexedDb) {
    gaps.push({
      feature: 'IndexedDB',
      detail:
        'Recordings cannot be stored across reloads. They remain downloadable for the current session.',
      blocking: false,
    })
  }
  if (!caps.recorderPause) {
    gaps.push({
      feature: 'MediaRecorder.pause',
      detail: 'Pausing a recording is unavailable; start and stop still work.',
      blocking: false,
    })
  }
  return gaps
}

export function hasBlockingGap(caps = detectCapabilities()): boolean {
  return findCapabilityGaps(caps).some((gap) => gap.blocking)
}
