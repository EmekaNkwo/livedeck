import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectCapabilities,
  findCapabilityGaps,
  hasBlockingGap,
  resetCapabilitiesCache,
  type Capabilities,
} from './capabilities'

/* ---------------------------------------------------------------- stubs */

class FakeRecorder {
  pause(): void {}
  resume(): void {}
}
class FakeRecorderWithoutPause {}
class FakeAudioContext {}
class FakePeerConnection {}

function installMediaDevices(value: unknown): void {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value })
}

function installCaptureStream(): void {
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    writable: true,
    value: () => null,
  })
}

/** Every probe positive. */
function installFullBrowser(): void {
  vi.stubGlobal('isSecureContext', true)
  installMediaDevices({
    getUserMedia: () => undefined,
    getDisplayMedia: () => undefined,
    enumerateDevices: () => undefined,
    addEventListener: () => undefined,
  })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  installCaptureStream()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  vi.stubGlobal('indexedDB', {})
}

/** Every probe negative. */
function installBareBrowser(): void {
  vi.stubGlobal('isSecureContext', false)
  vi.stubGlobal('MediaRecorder', undefined)
  vi.stubGlobal('AudioContext', undefined)
  vi.stubGlobal('RTCPeerConnection', undefined)
  vi.stubGlobal('indexedDB', undefined)
}

const ALL_TRUE: Capabilities = {
  secureContext: true,
  getUserMedia: true,
  getDisplayMedia: true,
  enumerateDevices: true,
  deviceChangeEvents: true,
  mediaRecorder: true,
  canvasCaptureStream: true,
  webAudio: true,
  webRtc: true,
  indexedDb: true,
  recorderPause: true,
}

const ALL_FALSE: Capabilities = {
  secureContext: false,
  getUserMedia: false,
  getDisplayMedia: false,
  enumerateDevices: false,
  deviceChangeEvents: false,
  mediaRecorder: false,
  canvasCaptureStream: false,
  webAudio: false,
  webRtc: false,
  indexedDb: false,
  recorderPause: false,
}

beforeEach(() => {
  resetCapabilitiesCache()
})

afterEach(() => {
  // Restore stubbed globals first: a test may have removed `navigator` or
  // `HTMLCanvasElement` entirely.
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  resetCapabilitiesCache()
})

/* ------------------------------------------------------------- detection */

describe('detectCapabilities', () => {
  it('detects every feature in a full browser', () => {
    installFullBrowser()
    expect(detectCapabilities()).toEqual(ALL_TRUE)
  })

  it('detects nothing in a bare browser', () => {
    installBareBrowser()
    expect(detectCapabilities()).toEqual(ALL_FALSE)
  })

  it('treats mediaDevices members that are not functions as missing', () => {
    installFullBrowser()
    installMediaDevices({ getUserMedia: true, getDisplayMedia: 'yes' })
    const caps = detectCapabilities()
    expect(caps.getUserMedia).toBe(false)
    expect(caps.getDisplayMedia).toBe(false)
    expect(caps.enumerateDevices).toBe(false)
    expect(caps.deviceChangeEvents).toBe(false)
  })

  it('reports a recorder without pause()', () => {
    installFullBrowser()
    vi.stubGlobal('MediaRecorder', FakeRecorderWithoutPause)
    const caps = detectCapabilities()
    expect(caps.mediaRecorder).toBe(true)
    expect(caps.recorderPause).toBe(false)
  })

  it('treats a null indexedDB as missing', () => {
    installFullBrowser()
    vi.stubGlobal('indexedDB', null)
    expect(detectCapabilities().indexedDb).toBe(false)
  })

  it('reports no canvas capture when HTMLCanvasElement is missing', () => {
    installFullBrowser()
    vi.stubGlobal('HTMLCanvasElement', undefined)
    expect(detectCapabilities().canvasCaptureStream).toBe(false)
  })

  it('reports nothing outside a browser (no window, no navigator)', () => {
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('window', undefined)
    expect(detectCapabilities()).toEqual(ALL_FALSE)
  })

  it('memoizes the first result until the cache is reset', () => {
    installBareBrowser()
    const first = detectCapabilities()
    installFullBrowser()
    expect(detectCapabilities()).toBe(first)
    expect(detectCapabilities().webAudio).toBe(false)

    resetCapabilitiesCache()
    const second = detectCapabilities()
    expect(second).not.toBe(first)
    expect(second).toEqual(ALL_TRUE)
  })
})

/* ------------------------------------------------------------------ gaps */

describe('findCapabilityGaps', () => {
  it('finds no gaps when everything is supported', () => {
    expect(findCapabilityGaps(ALL_TRUE)).toEqual([])
    expect(hasBlockingGap(ALL_TRUE)).toBe(false)
  })

  it('lists every gap, blocking ones first-class, in a fixed order', () => {
    const gaps = findCapabilityGaps(ALL_FALSE)
    expect(gaps.map((gap) => [gap.feature, gap.blocking])).toEqual([
      ['Secure context', true],
      ['getUserMedia', true],
      ['canvas.captureStream', true],
      ['getDisplayMedia', false],
      ['MediaRecorder', false],
      ['Web Audio API', false],
      ['RTCPeerConnection', false],
      ['IndexedDB', false],
      ['MediaRecorder.pause', false],
    ])
    expect(gaps.every((gap) => gap.detail.length > 0)).toBe(true)
    expect(hasBlockingGap(ALL_FALSE)).toBe(true)
  })

  it.each([
    ['secureContext', true],
    ['getUserMedia', true],
    ['canvasCaptureStream', true],
    ['getDisplayMedia', false],
    ['mediaRecorder', false],
    ['webAudio', false],
    ['webRtc', false],
    ['indexedDb', false],
    ['recorderPause', false],
  ] as const)('missing %s alone → one gap, blocking=%s', (key, blocking) => {
    const caps: Capabilities = { ...ALL_TRUE, [key]: false }
    const gaps = findCapabilityGaps(caps)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.blocking).toBe(blocking)
    expect(hasBlockingGap(caps)).toBe(blocking)
  })

  it('defaults to the detected capabilities', () => {
    installFullBrowser()
    expect(findCapabilityGaps()).toEqual([])
    expect(hasBlockingGap()).toBe(false)
    resetCapabilitiesCache()
    installBareBrowser()
    expect(hasBlockingGap()).toBe(true)
  })
})
