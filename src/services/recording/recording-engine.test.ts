import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingStatus } from '@/types/recording'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { RecordingEngine } from './recording-engine'
import { createFakeStream, installCanvasStub } from '@/test/setup'

/**
 * Recorder state transitions.
 *
 * NOTE ON SCOPE: these tests drive a scripted MediaRecorder double. They prove
 * the engine's *state machine* — that nothing reports success before data
 * arrives, that failures are structured and recoverable, and that capture
 * tracks are released. They do not and cannot prove that a real browser
 * produces a playable file; that is what the Playwright suite covers.
 */

type RecorderInstance = {
  state: 'inactive' | 'recording' | 'paused'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  start: (timeslice?: number) => void
  stop: () => void
  pause: () => void
  resume: () => void
}

let instances: RecorderInstance[] = []
/** Set by a test to make construction fail. */
let constructorThrows = false
/** Set by a test to make start() fail. */
let startThrows = false

function installRecorder(options?: { withPause?: boolean }) {
  instances = []
  constructorThrows = false
  startThrows = false

  class FakeMediaRecorder {
    state: RecorderInstance['state'] = 'inactive'
    mimeType: string
    ondataavailable: RecorderInstance['ondataavailable'] = null
    onstop: RecorderInstance['onstop'] = null
    onerror: RecorderInstance['onerror'] = null

    constructor(_stream: MediaStream, recorderOptions?: MediaRecorderOptions) {
      if (constructorThrows) throw new Error('unsupported options')
      this.mimeType = recorderOptions?.mimeType ?? 'video/webm'
      instances.push(this as unknown as RecorderInstance)
    }

    start(): void {
      if (startThrows) throw new Error('could not start')
      this.state = 'recording'
    }
    stop(): void {
      this.state = 'inactive'
      this.onstop?.()
    }
    pause(): void {
      this.state = 'paused'
    }
    resume(): void {
      this.state = 'recording'
    }
    static isTypeSupported(mimeType: string): boolean {
      return mimeType.includes('webm')
    }
  }

  if (!options?.withPause) {
    // Simulate a browser without pause support.
    // @ts-expect-error deliberately removing the method
    delete FakeMediaRecorder.prototype.pause
  }

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  resetCapabilitiesCache()
  return FakeMediaRecorder
}

let engine: RecordingEngine
let canvas: HTMLCanvasElement
let statuses: RecordingStatus[]

function makeEngine() {
  engine = new RecordingEngine()
  statuses = []
  engine.setEvents({ onStatusChange: (status) => statuses.push(status) })
  return engine
}

beforeEach(() => {
  installCanvasStub()
  canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  makeEngine()
})

afterEach(() => {
  engine.dispose()
  vi.unstubAllGlobals()
  resetCapabilitiesCache()
})

const startOptions = () => ({
  canvas,
  audioStream: createFakeStream(['audio']),
  frameRate: 30,
})

describe('start', () => {
  it('reaches the recording state and reports the negotiated format', async () => {
    installRecorder({ withPause: true })
    const ok = await engine.start(startOptions())

    expect(ok).toBe(true)
    expect(engine.getStatus()).toBe('recording')
    expect(statuses).toEqual(['starting', 'recording'])
    expect(engine.getFormat()?.extension).toBe('webm')
  })

  it('combines the program video track with the mixed audio track', async () => {
    installRecorder({ withPause: true })
    const audioStream = createFakeStream(['audio'])
    const captureSpy = vi.spyOn(canvas, 'captureStream')

    await engine.start({ canvas, audioStream, frameRate: 24 })

    // Capturing at the target rate ties the encoder to the compositor cadence.
    expect(captureSpy).toHaveBeenCalledWith(24)
    expect(instances).toHaveLength(1)
  })

  it('records video only when no audio mix is available', async () => {
    installRecorder({ withPause: true })
    const ok = await engine.start({ canvas, audioStream: null, frameRate: 30 })
    expect(ok).toBe(true)
    expect(engine.getStatus()).toBe('recording')
  })

  it('refuses to start twice', async () => {
    installRecorder({ withPause: true })
    await engine.start(startOptions())
    expect(await engine.start(startOptions())).toBe(false)
    expect(instances).toHaveLength(1)
  })

  it('reports an unsupported browser rather than throwing', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    resetCapabilitiesCache()
    const onError = vi.fn()
    engine.setEvents({ onError, onStatusChange: (status) => statuses.push(status) })

    expect(await engine.start(startOptions())).toBe(false)
    expect(engine.getStatus()).toBe('error')
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unsupported', recoverable: false }),
    )
  })

  it('retries with bare options when the full configuration is rejected', async () => {
    installRecorder({ withPause: true })
    // Some builds accept a mimeType but reject the bitrate hints.
    let first = true
    const original = globalThis.MediaRecorder
    vi.stubGlobal(
      'MediaRecorder',
      class extends (original as unknown as new (
        stream: MediaStream,
        options?: MediaRecorderOptions,
      ) => RecorderInstance) {
        constructor(stream: MediaStream, options?: MediaRecorderOptions) {
          if (first && options?.videoBitsPerSecond) {
            first = false
            throw new Error('bitrate unsupported')
          }
          super(stream, options)
        }
        static isTypeSupported = (mimeType: string) => mimeType.includes('webm')
      },
    )
    resetCapabilitiesCache()

    expect(await engine.start(startOptions())).toBe(true)
  })

  it('surfaces a recoverable error when start() throws', async () => {
    installRecorder({ withPause: true })
    startThrows = true
    const onError = vi.fn()
    engine.setEvents({ onError })

    expect(await engine.start(startOptions())).toBe(false)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'recorder-error', recoverable: true }),
    )
  })

  it('routes the injected demo failure through the real error path', async () => {
    installRecorder({ withPause: true })
    const onError = vi.fn()
    engine.setEvents({ onError })

    expect(await engine.start({ ...startOptions(), simulateFailure: true })).toBe(false)
    expect(engine.getStatus()).toBe('error')
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'simulated', recoverable: true }),
    )
    // Nothing was actually started.
    expect(instances).toHaveLength(0)
  })
})

describe('stop and finalize', () => {
  it('only reports complete after the recorder produced a blob', async () => {
    installRecorder({ withPause: true })
    const onComplete = vi.fn()
    engine.setEvents({ onComplete, onStatusChange: (status) => statuses.push(status) })

    await engine.start(startOptions())
    const recorder = instances[0]!
    recorder.ondataavailable?.({ data: new Blob(['chunk'], { type: 'video/webm' }) })

    engine.stop()

    // 'finalizing' must appear before 'complete' — success is never reported
    // ahead of the browser actually producing data.
    expect(statuses).toEqual(['starting', 'recording', 'finalizing', 'complete'])
    expect(onComplete).toHaveBeenCalledTimes(1)
    const result = onComplete.mock.calls[0]![0] as { blob: Blob; extension: string }
    expect(result.blob.size).toBeGreaterThan(0)
    expect(result.extension).toBe('webm')
  })

  it('reports a failure when the recorder produced no data', async () => {
    installRecorder({ withPause: true })
    const onError = vi.fn()
    const onComplete = vi.fn()
    engine.setEvents({ onError, onComplete })

    await engine.start(startOptions())
    engine.stop()

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'finalize-failed' }),
    )
  })

  it('uses the recorder’s actual mimeType for the extension', async () => {
    installRecorder({ withPause: true })
    const onComplete = vi.fn()
    engine.setEvents({ onComplete })

    await engine.start(startOptions())
    const recorder = instances[0]!
    // The browser substituted a different container than requested.
    recorder.mimeType = 'video/mp4'
    recorder.ondataavailable?.({ data: new Blob(['x']) })
    engine.stop()

    const result = onComplete.mock.calls[0]![0] as { extension: string; mimeType: string }
    expect(result.mimeType).toBe('video/mp4')
    expect(result.extension).toBe('mp4')
  })

  it('stops the canvas capture tracks when finalizing', async () => {
    installRecorder({ withPause: true })
    const captured = createFakeStream(['video'])
    vi.spyOn(canvas, 'captureStream').mockReturnValue(captured)
    engine.setEvents({ onComplete: () => {} })

    await engine.start(startOptions())
    instances[0]!.ondataavailable?.({ data: new Blob(['x']) })
    engine.stop()

    // These tracks belong to the recorder alone, so releasing them is correct
    // and is what lets the browser free the encoder.
    expect(captured.getVideoTracks()[0]?.readyState).toBe('ended')
  })

  it('ignores stop() when not recording', () => {
    installRecorder({ withPause: true })
    engine.stop()
    expect(engine.getStatus()).toBe('idle')
  })
})

describe('pause and resume', () => {
  it('pauses and resumes when the browser supports it', async () => {
    installRecorder({ withPause: true })
    await engine.start(startOptions())

    engine.pause()
    expect(engine.getStatus()).toBe('paused')

    engine.resume()
    expect(engine.getStatus()).toBe('recording')
  })

  it('reports that pausing is unavailable and refuses to pause', async () => {
    installRecorder({ withPause: false })
    await engine.start(startOptions())

    expect(engine.canPause()).toBe(false)
    engine.pause()
    // Still recording — the control is disabled rather than silently broken.
    expect(engine.getStatus()).toBe('recording')
  })

  it('excludes paused time from the elapsed duration', async () => {
    installRecorder({ withPause: true })
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(0)
    await engine.start(startOptions())

    now.mockReturnValue(1000)
    engine.pause()
    expect(engine.getElapsedMs()).toBe(1000)

    // Two seconds pass while paused.
    now.mockReturnValue(3000)
    expect(engine.getElapsedMs()).toBe(1000)

    engine.resume()
    now.mockReturnValue(3500)
    expect(engine.getElapsedMs()).toBe(1500)
  })
})

describe('cancel', () => {
  it('discards data and returns to idle without completing', async () => {
    installRecorder({ withPause: true })
    const onComplete = vi.fn()
    engine.setEvents({ onComplete })

    await engine.start(startOptions())
    instances[0]!.ondataavailable?.({ data: new Blob(['x']) })
    engine.cancel()

    expect(engine.getStatus()).toBe('idle')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('is safe to call when idle', () => {
    expect(() => engine.cancel()).not.toThrow()
  })
})

describe('recorder errors', () => {
  it('surfaces a recoverable error when the recorder fails mid-recording', async () => {
    installRecorder({ withPause: true })
    const onError = vi.fn()
    engine.setEvents({ onError })

    await engine.start(startOptions())
    instances[0]!.onerror?.()

    expect(engine.getStatus()).toBe('error')
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'recorder-error', recoverable: true }),
    )
  })
})
