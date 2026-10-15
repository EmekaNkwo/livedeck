import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { resetCapabilitiesCache } from '@/lib/capabilities'

/**
 * jsdom does not implement any of the media APIs this project is built on, so
 * the pieces that must exist for a module to even load are stubbed here.
 *
 * These are *structural* stubs — enough for code to run — not behavioural
 * fakes. Tests that care about behaviour install their own doubles, and the
 * guidance in the README is explicit that passing these tests is not evidence
 * of real-world media or connectivity behaviour. That is what the Playwright
 * suite and manual two-browser testing are for.
 */

/* ------------------------------------------------------------- animation */

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((handle: number) =>
    clearTimeout(handle)) as typeof cancelAnimationFrame
}

/* ------------------------------------------------------------- observers */

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

/* ----------------------------------------------------------- matchMedia */

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

/* -------------------------------------------------------- media streams */

/**
 * A minimal MediaStream/MediaStreamTrack pair.
 * jsdom has neither, and the stream registry's whole job is managing them.
 */
class FakeMediaStreamTrack extends EventTarget implements Partial<MediaStreamTrack> {
  id = Math.random().toString(36).slice(2)
  enabled = true
  muted = false
  readyState: MediaStreamTrackState = 'live'
  label: string
  kind: 'audio' | 'video'

  constructor(kind: 'audio' | 'video') {
    super()
    this.kind = kind
    this.label = `fake ${kind}`
  }

  stop(): void {
    this.readyState = 'ended'
  }
  getSettings(): MediaTrackSettings {
    return this.kind === 'video'
      ? { width: 1280, height: 720, frameRate: 30, deviceId: 'fake-video' }
      : { deviceId: 'fake-audio' }
  }
  applyConstraints(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeMediaStream implements Partial<MediaStream> {
  id = Math.random().toString(36).slice(2)
  private tracks: FakeMediaStreamTrack[]

  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = tracks
  }
  getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[]
  }
  getVideoTracks(): MediaStreamVideoTrack[] {
    return this.tracks.filter((t) => t.kind === 'video') as unknown as MediaStreamVideoTrack[]
  }
  getAudioTracks(): MediaStreamAudioTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio') as unknown as MediaStreamAudioTrack[]
  }
  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track as unknown as FakeMediaStreamTrack)
  }
  removeTrack(track: MediaStreamTrack): void {
    this.tracks = this.tracks.filter((candidate) => candidate.id !== track.id)
  }
}

if (!globalThis.MediaStream) {
  globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream
}
if (!globalThis.MediaStreamTrack) {
  globalThis.MediaStreamTrack = FakeMediaStreamTrack as unknown as typeof MediaStreamTrack
}

/** Build a stream with the requested tracks. Exported for use in tests. */
export function createFakeStream(kinds: Array<'audio' | 'video'>): MediaStream {
  return new FakeMediaStream(
    kinds.map((kind) => new FakeMediaStreamTrack(kind)),
  ) as unknown as MediaStream
}

export { FakeMediaStream, FakeMediaStreamTrack }

/* ------------------------------------------------------------- elements */

// jsdom's <video> never loads, so these stay at their defaults and the
// compositor would always skip the draw. Tests that assert drawing override
// them per-element.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: () => Promise.resolve(),
})
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  value: () => {},
})
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  value: () => {},
})

/* --------------------------------------------------------------- canvas */

// jsdom returns null from getContext, which would make the compositor bail out
// before any of its logic ran. This is a recording stub: it accepts every call
// and tracks them, so tests can assert *which* drawing operations happened.
export type CanvasCall = { method: string; args: unknown[] }

export function installCanvasStub(): CanvasCall[] {
  const calls: CanvasCall[] = []
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
  }

  const context = {
    canvas: null as unknown as HTMLCanvasElement,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    scale: record('scale'),
    fillRect: record('fillRect'),
    drawImage: record('drawImage'),
    fillText: record('fillText'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    fill: record('fill'),
    clearRect: record('clearRect'),
    measureText: (text: string) => ({ width: text.length * 8 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  }

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  )

  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    writable: true,
    value: () => createFakeStream(['video']),
  })

  return calls
}

/* ------------------------------------------------------------- cleanup */

afterEach(() => {
  cleanup()
  // Capability detection is memoized; a test that stubs an API must not leak
  // that result into the next test.
  resetCapabilitiesCache()
  vi.restoreAllMocks()
  localStorage.clear()
})
