import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingStatus } from '@/types/recording'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { createFakeStream, installCanvasStub } from '@/test/setup'
import type { Mp4CaptureOptions } from './mp4-capture'

/**
 * The engine's WebCodecs branch: when it is chosen, how its bytes reach the
 * sink, and how it fails over to MediaRecorder. The encoder is a double; the
 * real one runs in `e2e/recording-files.spec.ts`.
 */

const capture = vi.hoisted(() => {
  const state = {
    webCodecs: true,
    plan: { audioCodec: 'aac' } as { audioCodec: 'aac' | 'opus' | null } | null,
    startRejects: null as Error | null,
    stopRejects: null as Error | null,
    options: null as Mp4CaptureOptions | null,
    instance: null as null | {
      pause: ReturnType<typeof vi.fn>
      resume: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
    },
  }
  return state
})

vi.mock('./mp4-capture', () => ({
  MP4_MIME: 'video/mp4;codecs=avc1,mp4a.40.2',
  MP4_FORMAT_LABEL: 'MP4 · H.264 + AAC',
  hasWebCodecs: () => capture.webCodecs,
  planMp4Capture: vi.fn(async () => capture.plan),
  Mp4Capture: {
    start: vi.fn(async (options: Mp4CaptureOptions) => {
      if (capture.startRejects) throw capture.startRejects
      capture.options = options
      capture.instance = {
        pause: vi.fn(),
        resume: vi.fn(),
        stop: vi.fn(async () => {
          if (capture.stopRejects) throw capture.stopRejects
          options.onData(new Blob(['last-fragment']))
        }),
        cancel: vi.fn(async () => undefined),
      }
      return capture.instance
    }),
  },
}))

import { RecordingEngine } from './recording-engine'

class FakeMediaRecorder {
  static created = 0
  state = 'inactive'
  mimeType = 'video/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeMediaRecorder.created += 1
  }
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }
  static isTypeSupported(mimeType: string): boolean {
    return mimeType.includes('webm')
  }
}

let engine: RecordingEngine
let statuses: RecordingStatus[]
let errors: string[]
let completed: Array<{ mimeType: string; chunkCount: number; bytes: number; extension: string }>
let sunk: string[]
let canvas: HTMLCanvasElement

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const start = (overrides: { preferMp4?: boolean; sinkRejects?: Error } = {}) =>
  engine.start({
    canvas,
    audioStream: createFakeStream(['audio']),
    frameRate: 30,
    preferMp4: overrides.preferMp4,
    sink: async (_index, chunk) => {
      if (overrides.sinkRejects) throw overrides.sinkRejects
      sunk.push(await chunk.text())
    },
  })

beforeEach(() => {
  installCanvasStub()
  canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  capture.webCodecs = true
  capture.plan = { audioCodec: 'aac' }
  capture.startRejects = null
  capture.stopRejects = null
  capture.options = null
  capture.instance = null
  FakeMediaRecorder.created = 0
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  resetCapabilitiesCache()
  statuses = []
  errors = []
  completed = []
  sunk = []
  engine = new RecordingEngine()
  engine.setEvents({
    onStatusChange: (status) => statuses.push(status),
    onError: (error) => errors.push(`${error.code}: ${error.message}`),
    onComplete: (result) => completed.push(result),
  })
})

afterEach(() => {
  engine.dispose()
  vi.unstubAllGlobals()
  resetCapabilitiesCache()
})

describe('WebCodecs capture', () => {
  it('is chosen when the browser can encode H.264, and reports MP4', async () => {
    expect(await start()).toBe(true)
    expect(FakeMediaRecorder.created).toBe(0)
    expect(engine.getFormat()).toEqual({
      mimeType: 'video/mp4;codecs=avc1,mp4a.40.2',
      extension: 'mp4',
      label: 'MP4 · H.264 + AAC',
    })
    expect(capture.options).toMatchObject({ frameRate: 30, plan: { audioCodec: 'aac' } })
    expect(capture.options?.audio).not.toBeNull()
    expect(engine.canPause()).toBe(true)
  })

  it('labels Opus audio honestly', async () => {
    capture.plan = { audioCodec: 'opus' }
    await start()
    expect(engine.getFormat()?.label).toBe('MP4 · H.264 + Opus')
  })

  it('sends each fragment to the sink in order and completes after the last one', async () => {
    await start()
    capture.options?.onData(new Blob(['init']))
    capture.options?.onData(new Blob(['frag-1']))
    engine.stop()
    expect(statuses.at(-1)).toBe('finalizing')
    await flush()
    await flush()

    expect(sunk).toEqual(['init', 'frag-1', 'last-fragment'])
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4', chunkCount: 3 })
    expect(statuses.at(-1)).toBe('complete')
  })

  it('pauses and resumes the encoder', async () => {
    await start()
    engine.pause()
    expect(capture.instance?.pause).toHaveBeenCalled()
    expect(engine.getStatus()).toBe('paused')
    engine.resume()
    expect(capture.instance?.resume).toHaveBeenCalled()
    expect(engine.getStatus()).toBe('recording')
  })

  it('falls back to MediaRecorder when H.264 cannot be encoded', async () => {
    capture.plan = null
    expect(await start()).toBe(true)
    expect(FakeMediaRecorder.created).toBe(1)
    expect(engine.getFormat()?.extension).toBe('webm')
  })

  it('falls back to MediaRecorder when the encoder refuses to start', async () => {
    capture.startRejects = new Error('NotSupportedError')
    expect(await start()).toBe(true)
    expect(FakeMediaRecorder.created).toBe(1)
  })

  it('uses MediaRecorder without WebCodecs or when asked to', async () => {
    capture.webCodecs = false
    await start()
    expect(FakeMediaRecorder.created).toBe(1)
    engine.cancel()
    capture.webCodecs = true
    await start({ preferMp4: false })
    expect(FakeMediaRecorder.created).toBe(2)
  })

  it('reports an encoder failure as recoverable and stops', async () => {
    await start()
    capture.options?.onError(new Error('EncodingError'))
    expect(engine.getStatus()).toBe('error')
    expect(errors[0]).toMatch(/^recorder-error: The encoder stopped unexpectedly \(EncodingError\)/)
    expect(capture.instance?.cancel).toHaveBeenCalled()
  })

  it('reports a failed finish as recoverable', async () => {
    await start()
    capture.stopRejects = new Error('flush failed')
    engine.stop()
    await flush()
    expect(errors[0]).toMatch(/^finalize-failed/)
    expect(completed).toHaveLength(0)
  })

  it('stops the encoder when storage rejects a fragment', async () => {
    await start({ sinkRejects: new Error('QuotaExceededError') })
    capture.options?.onData(new Blob(['frag']))
    await flush()
    expect(errors[0]).toMatch(/^quota-exceeded/)
    expect(capture.instance?.cancel).toHaveBeenCalled()
  })

  it('cancels the encoder when the recording is discarded', async () => {
    await start()
    engine.cancel()
    expect(capture.instance?.cancel).toHaveBeenCalled()
    expect(engine.getStatus()).toBe('idle')
  })
})
