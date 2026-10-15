import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasStub } from '@/test/setup'
import type { PlannedFrame } from './paint-plan'
import type { PaintPlan } from './painter'
import type { ToPaintWorker } from './paint-protocol'
import { MainThreadPainter, WorkerPainter, canPaintInWorker } from './painters'

/**
 * The two painters. The worker one is driven with a fake Worker and fake
 * VideoFrame so its rules can be checked: one frame in flight, video frames
 * transferred and never leaked, still images sent once and released.
 * Chromium runs the real thing in `e2e/paint-thread.spec.ts`.
 */

const plan: PaintPlan = { width: 640, height: 360, background: '#000', current: [], outgoing: null, transition: null }
const frameOf = (media: PlannedFrame['media'] = new Map()): PlannedFrame => ({ plan, media })

class FakeVideoFrame {
  static open = 0
  static failNext = false
  closed = false
  constructor() {
    if (FakeVideoFrame.failNext) {
      FakeVideoFrame.failNext = false
      throw new Error('InvalidStateError')
    }
    FakeVideoFrame.open += 1
  }
  close() {
    if (!this.closed) FakeVideoFrame.open -= 1
    this.closed = true
  }
}
class FakeBitmap {
  closed = false
  close() {
    this.closed = true
  }
}
class FakeWorker {
  posted: Array<{ message: ToPaintWorker; transfer: unknown[] }> = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  postMessage(message: ToPaintWorker, transfer: unknown[] = []) {
    this.posted.push({ message, transfer })
  }
  terminate() {
    this.terminated = true
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
  of(type: ToPaintWorker['type']) {
    return this.posted.filter((entry) => entry.message.type === type)
  }
}

let worker: FakeWorker
let errors: string[]
let imagesReady: number
let bitmapRequests: Array<{ resolve: (bitmap: FakeBitmap) => void; reject: (error: Error) => void }>

function installWorkerApis() {
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal('VideoFrame', FakeVideoFrame)
  vi.stubGlobal('ImageBitmap', FakeBitmap)
  vi.stubGlobal(
    'createImageBitmap',
    () => new Promise((resolve, reject) => bitmapRequests.push({ resolve, reject })),
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    writable: true,
    value: function (this: HTMLCanvasElement) {
      if ((this as unknown as { transferred?: boolean }).transferred) throw new Error('InvalidStateError')
      ;(this as unknown as { transferred?: boolean }).transferred = true
      return { offscreen: true }
    },
  })
}

function createPainter(canvas = document.createElement('canvas')) {
  return WorkerPainter.create(canvas, {
    createWorker: () => {
      worker = new FakeWorker()
      return worker as unknown as Worker
    },
    onImageReady: () => {
      imagesReady += 1
    },
    onError: (message) => errors.push(message),
  })
}

beforeEach(() => {
  FakeVideoFrame.open = 0
  FakeVideoFrame.failNext = false
  errors = []
  imagesReady = 0
  bitmapRequests = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).transferControlToOffscreen
})

describe('MainThreadPainter', () => {
  it('paints on the canvas and resizes its backing store', () => {
    const calls = installCanvasStub()
    const canvas = document.createElement('canvas')
    const painter = MainThreadPainter.create(canvas)
    expect(painter?.thread).toBe('main')
    painter?.resize(320, 180)
    expect([canvas.width, canvas.height]).toEqual([320, 180])
    painter?.resize(320, 180)
    expect(painter?.paint(frameOf())).toBe(true)
    expect(calls.some((call) => call.method === 'fillRect')).toBe(true)
    expect(painter?.lastPaintMs()).toBeGreaterThanOrEqual(0)
    painter?.dispose()
  })

  it('composites transitions through scratch canvases', () => {
    const calls = installCanvasStub()
    const painter = MainThreadPainter.create(document.createElement('canvas'))
    painter?.paint({
      plan: { ...plan, current: [], outgoing: [], transition: { type: 'crossfade', t: 0.5 } },
      media: new Map(),
    })
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(2)
  })

  it('declines a canvas it cannot draw on', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('InvalidStateError')
    })
    expect(MainThreadPainter.create(document.createElement('canvas'))).toBeNull()
  })
})

describe('WorkerPainter', () => {
  it('is unavailable without OffscreenCanvas transfer', () => {
    expect(canPaintInWorker()).toBe(false)
    expect(createPainter()).toBeNull()
  })

  it('hands the canvas to the worker once', () => {
    installWorkerApis()
    const canvas = document.createElement('canvas')
    const painter = createPainter(canvas)
    expect(painter?.thread).toBe('worker')
    expect(worker.of('init')).toHaveLength(1)
    expect(worker.of('init')[0]?.transfer).toHaveLength(1)
    // A canvas can only be transferred once.
    expect(createPainter(canvas)).toBeNull()
  })

  it('transfers a video frame per live source and keeps one paint in flight', () => {
    installWorkerApis()
    const painter = createPainter()
    const video = document.createElement('video')
    const frame = frameOf(new Map([['cam', { drawable: video, live: true }]]))

    expect(painter?.paint(frame)).toBe(true)
    const first = worker.of('paint')[0]
    if (!first) throw new Error('nothing was posted')
    const message = first.message as Extract<ToPaintWorker, { type: 'paint' }>
    expect(first.transfer).toHaveLength(1)
    expect(message.frames[0]?.[0]).toBe('cam')

    // Busy: the next frame is dropped rather than queued, so frames never pile up.
    expect(painter?.paint(frame)).toBe(false)
    expect(worker.of('paint')).toHaveLength(1)

    worker.reply({ type: 'painted', id: message.id, durationMs: 4.5 })
    expect(painter?.lastPaintMs()).toBe(4.5)
    expect(painter?.paint(frame)).toBe(true)
  })

  it('gives up on a frame the worker never finishes', () => {
    installWorkerApis()
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const painter = createPainter()
    painter?.paint(frameOf())
    now.mockReturnValue(1500)
    expect(painter?.paint(frameOf())).toBe(false)
    now.mockReturnValue(3500)
    expect(painter?.paint(frameOf())).toBe(true)
  })

  it('skips a video that has no frame to give', () => {
    installWorkerApis()
    const painter = createPainter()
    FakeVideoFrame.failNext = true
    painter?.paint(frameOf(new Map([['cam', { drawable: document.createElement('video'), live: true }]])))
    expect(worker.of('paint')[0]?.transfer).toHaveLength(0)
  })

  it('sends a still image once, asks for a repaint when it lands, and drops it when unused', async () => {
    installWorkerApis()
    const painter = createPainter()
    const img = document.createElement('img')
    const withLogo = frameOf(new Map([['logo', { drawable: img, live: false }]]))

    painter?.paint(withLogo)
    worker.reply({ type: 'painted', id: 1, durationMs: 1 })
    painter?.paint(withLogo)
    expect(bitmapRequests).toHaveLength(1)

    const bitmap = new FakeBitmap()
    bitmapRequests[0]?.resolve(bitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(worker.of('image')).toHaveLength(1)
    expect(worker.of('image')[0]?.transfer).toEqual([bitmap])
    expect(imagesReady).toBe(1)

    worker.reply({ type: 'painted', id: 2, durationMs: 1 })
    painter?.paint(frameOf())
    expect(worker.of('drop').map((entry) => (entry.message as { key: string }).key)).toEqual(['logo'])
  })

  it('discards a bitmap for an image that changed while it decoded', async () => {
    installWorkerApis()
    const painter = createPainter()
    painter?.paint(frameOf(new Map([['logo', { drawable: document.createElement('img'), live: false }]])))
    worker.reply({ type: 'painted', id: 1, durationMs: 1 })
    painter?.paint(frameOf(new Map([['logo', { drawable: document.createElement('img'), live: false }]])))
    const stale = new FakeBitmap()
    bitmapRequests[0]?.resolve(stale)
    await Promise.resolve()
    await Promise.resolve()
    expect(stale.closed).toBe(true)
    expect(worker.of('image')).toHaveLength(0)
  })

  it('reports an image that cannot be decoded, and tries again next frame', async () => {
    installWorkerApis()
    const painter = createPainter()
    const img = document.createElement('img')
    painter?.paint(frameOf(new Map([['logo', { drawable: img, live: false }]])))
    bitmapRequests[0]?.reject(new Error('decode failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(errors[0]).toMatch(/decode failed/)
    worker.reply({ type: 'painted', id: 1, durationMs: 1 })
    painter?.paint(frameOf(new Map([['logo', { drawable: img, live: false }]])))
    expect(bitmapRequests).toHaveLength(2)
  })

  it('passes worker errors on and unblocks after a crash', () => {
    installWorkerApis()
    const painter = createPainter()
    painter?.paint(frameOf())
    worker.reply({ type: 'error', message: 'paint failed' })
    worker.onerror?.({ message: '' } as ErrorEvent)
    expect(errors).toEqual(['paint failed', 'The paint worker failed.'])
    expect(painter?.paint(frameOf())).toBe(true)
  })

  it('terminates the worker and closes anything sent after disposal', () => {
    installWorkerApis()
    const painter = createPainter()
    painter?.dispose()
    painter?.dispose()
    expect(worker.terminated).toBe(true)
    expect(painter?.paint(frameOf(new Map([['cam', { drawable: document.createElement('video'), live: true }]])))).toBe(false)
    painter?.resize(10, 10)
    expect(worker.of('resize')).toHaveLength(0)
    expect(FakeVideoFrame.open).toBe(0)
  })

  it('forwards resizes', () => {
    installWorkerApis()
    createPainter()?.resize(1920, 1080)
    expect(worker.of('resize')[0]?.message).toEqual({ type: 'resize', width: 1920, height: 1080 })
  })
})
