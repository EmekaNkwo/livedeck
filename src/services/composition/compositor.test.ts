import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasStub, type CanvasCall } from '@/test/setup'
import type { CompositionSnapshot } from './composition-model'
import { EMPTY_SNAPSHOT } from './composition-model'
import { CanvasCompositor } from './compositor'

/**
 * The compositor loop on the main-thread painter (jsdom has no
 * OffscreenCanvas): frame gating, the size lock, stats, and attach/detach.
 */

let calls: CanvasCall[]
let compositor: CanvasCompositor
let canvas: HTMLCanvasElement
let snapshot: CompositionSnapshot
let tick: (() => void) | null

beforeEach(() => {
  calls = installCanvasStub()
  tick = null
  // Drive the frame clock by hand.
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    tick = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  compositor = new CanvasCompositor()
  canvas = document.createElement('canvas')
  canvas.width = 300
  canvas.height = 150
  snapshot = { ...EMPTY_SNAPSHOT, canvas: { width: 640, height: 360 }, revision: 1 }
  compositor.setSnapshotSource(() => snapshot)
})

afterEach(() => {
  compositor.detach()
  vi.unstubAllGlobals()
})

const fills = () => calls.filter((call) => call.method === 'fillRect').length

describe('CanvasCompositor', () => {
  it('paints on the main thread when no worker is available, at the snapshot size', () => {
    compositor.attach(canvas)
    expect(compositor.getStats().paintThread).toBe('main')
    compositor.renderOnce()
    expect(compositor.getOutputSize()).toEqual({ width: 640, height: 360 })
    expect([canvas.width, canvas.height]).toEqual([640, 360])
    expect(fills()).toBe(1)
    expect(compositor.getStats().framesRendered).toBe(1)
  })

  it('skips a static frame whose revision has not moved, and repaints when invalidated', () => {
    compositor.attach(canvas)
    compositor.setTargetFps(60)
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    compositor.start()
    const runTick = (at: number) => {
      now.mockReturnValue(at)
      const callback = tick
      tick = null
      callback?.()
    }
    runTick(1000)
    expect(fills()).toBe(1)
    runTick(1100)
    expect(fills()).toBe(1)
    compositor.invalidate()
    runTick(1200)
    expect(fills()).toBe(2)
    // Stats refresh when a frame is painted.
    expect(compositor.getStats().framesSkipped).toBe(1)
    snapshot = { ...snapshot, revision: 2 }
    runTick(1300)
    expect(fills()).toBe(3)
    // Faster than the target rate: gated.
    snapshot = { ...snapshot, revision: 3 }
    runTick(1301)
    expect(fills()).toBe(3)
    runTick(2400)
    expect(compositor.getStats().fps).toBeGreaterThan(0)
    expect(compositor.isRunning()).toBe(true)
    expect(['raf', 'worker', 'interval']).toContain(compositor.getClockMode())
    compositor.stop()
    expect(compositor.isRunning()).toBe(false)
  })

  it('keeps the output size while locked', () => {
    compositor.attach(canvas)
    compositor.renderOnce()
    compositor.lockSize(true)
    expect(compositor.isSizeLocked()).toBe(true)
    snapshot = { ...snapshot, canvas: { width: 1920, height: 1080 } }
    compositor.renderOnce()
    compositor.resize({ width: 1920, height: 1080 })
    expect(compositor.getOutputSize()).toEqual({ width: 640, height: 360 })
    compositor.lockSize(false)
    compositor.resize({ width: 1920, height: 1080 })
    expect([canvas.width, canvas.height]).toEqual([1920, 1080])
  })

  it('does nothing without a canvas, and forgets it on detach', () => {
    compositor.renderOnce()
    compositor.resize({ width: 10, height: 10 })
    expect(fills()).toBe(0)
    compositor.attach(canvas)
    expect(compositor.getCanvas()).toBe(canvas)
    compositor.detach()
    expect(compositor.getCanvas()).toBeNull()
    expect(compositor.getStats().paintThread).toBeNull()
  })

  it('switching canvases detaches the old one', () => {
    compositor.attach(canvas)
    const other = document.createElement('canvas')
    compositor.attach(other)
    expect(compositor.getCanvas()).toBe(other)
  })

  it('reports a canvas it cannot paint', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    compositor.attach(canvas)
    expect(compositor.getStats()).toMatchObject({ paintThread: null, paintError: 'The program canvas could not be painted.' })
    compositor.renderOnce()
    expect(compositor.getStats().framesRendered).toBe(0)
  })
})
