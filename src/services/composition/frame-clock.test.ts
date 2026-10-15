import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameClock } from './frame-clock'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  interval: ReturnType<typeof setInterval> | null = null
  messages: unknown[] = []
  terminated = false
  postMessage(message: { type: string; intervalMs?: number }): void {
    this.messages.push(message)
    if (message.type === 'start') {
      if (this.interval) clearInterval(this.interval)
      this.interval = setInterval(() => this.onmessage?.({ data: 'tick' } as MessageEvent), message.intervalMs)
    } else if (message.type === 'stop') {
      if (this.interval) clearInterval(this.interval)
      this.interval = null
    }
  }
  terminate(): void {
    this.terminated = true
    if (this.interval) clearInterval(this.interval)
  }
}

let hidden = false
let frames: Array<() => void> = []
const requestFrame = (cb: () => void) => {
  frames.push(cb)
  return frames.length
}
const cancelFrame = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  frames = []
  cancelFrame.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('FrameClock', () => {
  it('uses requestAnimationFrame while visible', () => {
    const clock = new FrameClock({ requestFrame, cancelFrame, isHidden: () => hidden })
    const tick = vi.fn()
    clock.start(tick)
    expect(clock.currentMode).toBe('raf')
    frames.shift()?.()
    frames.shift()?.()
    expect(tick).toHaveBeenCalledTimes(2)
    clock.stop()
    expect(cancelFrame).toHaveBeenCalled()
  })

  it('switches to the worker metronome when hidden and keeps ticking at the target rate', () => {
    const worker = new FakeWorker()
    const clock = new FrameClock({
      requestFrame,
      cancelFrame,
      isHidden: () => hidden,
      createWorker: () => worker as unknown as Worker,
    })
    const tick = vi.fn()
    clock.setFps(20)
    clock.start(tick)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clock.currentMode).toBe('worker')
    expect(worker.messages).toContainEqual({ type: 'start', intervalMs: 50 })
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(20)

    // Back to the foreground: rAF again, worker paused.
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clock.currentMode).toBe('raf')
    expect(worker.messages.at(-1)).toEqual({ type: 'stop' })
    clock.dispose()
    expect(worker.terminated).toBe(true)
  })

  it('falls back to a plain interval when workers are unavailable', () => {
    const clock = new FrameClock({ requestFrame, cancelFrame, isHidden: () => true, createWorker: () => null })
    const tick = vi.fn()
    clock.setFps(10)
    clock.start(tick)
    expect(clock.currentMode).toBe('interval')
    vi.advanceTimersByTime(500)
    expect(tick).toHaveBeenCalledTimes(5)
    clock.stop()
    vi.advanceTimersByTime(500)
    expect(tick).toHaveBeenCalledTimes(5)
  })
})
