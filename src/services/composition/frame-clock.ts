/**
 * A frame clock that keeps ticking when the tab is hidden.
 *
 * `requestAnimationFrame` stops in a background tab, and main-thread timers
 * are throttled to once a second or worse. A recording or a mirror window
 * driven by either freezes the moment the operator switches to their notes.
 *
 * Dedicated workers are not throttled that way. This clock runs its timer in
 * a tiny inline worker and relays ticks to the main thread as messages, which
 * the browser delivers promptly even when the page is hidden. While the page
 * is visible it uses `requestAnimationFrame` as before, so painting stays
 * aligned with the display.
 *
 * The worker is only the metronome; painting still happens on the main
 * thread, where the video elements the compositor samples live. Moving the
 * compositor itself into a worker (OffscreenCanvas + VideoFrame) would also
 * take drawing off the UI thread, and is the next step once the frame
 * providers no longer depend on `HTMLVideoElement`.
 */

const WORKER_SOURCE = `
let timer = null
self.onmessage = (event) => {
  const { type, intervalMs } = event.data
  if (type === 'start') {
    if (timer) clearInterval(timer)
    timer = setInterval(() => self.postMessage('tick'), intervalMs)
  } else if (type === 'stop') {
    if (timer) clearInterval(timer)
    timer = null
  }
}
`

export type FrameClockMode = 'raf' | 'worker' | 'interval'

export type FrameClockOptions = {
  /** Injectable for tests. */
  createWorker?: () => Worker | null
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
  isHidden?: () => boolean
}

export class FrameClock {
  private readonly options: FrameClockOptions
  private onTick: (() => void) | null = null
  private fps = 30
  private running = false
  private mode: FrameClockMode = 'raf'
  private worker: Worker | null = null
  private workerBroken = false
  private rafId = 0
  private intervalId: ReturnType<typeof setInterval> | null = null
  private readonly onVisibility = () => this.reschedule()

  constructor(options: FrameClockOptions = {}) {
    this.options = options
  }

  get currentMode(): FrameClockMode {
    return this.mode
  }

  setFps(fps: number): void {
    this.fps = Math.max(1, Math.min(60, fps))
    if (this.running && this.mode !== 'raf') this.reschedule()
  }

  start(onTick: () => void): void {
    this.onTick = onTick
    if (this.running) return
    this.running = true
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
    this.reschedule()
  }

  stop(): void {
    this.running = false
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
    this.cancelAll()
  }

  dispose(): void {
    this.stop()
    this.worker?.terminate()
    this.worker = null
  }

  /* ------------------------------------------------------------ internals */

  private hidden(): boolean {
    if (this.options.isHidden) return this.options.isHidden()
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  private reschedule(): void {
    this.cancelAll()
    if (!this.running) return
    if (!this.hidden()) {
      this.mode = 'raf'
      this.scheduleRaf()
      return
    }
    const worker = this.ensureWorker()
    if (worker) {
      this.mode = 'worker'
      worker.onmessage = () => {
        if (this.running && this.mode === 'worker') this.onTick?.()
      }
      worker.postMessage({ type: 'start', intervalMs: Math.round(1000 / this.fps) })
      return
    }
    this.mode = 'interval'
    this.intervalId = setInterval(() => this.onTick?.(), Math.round(1000 / this.fps))
  }

  private scheduleRaf(): void {
    const request = this.options.requestFrame ?? ((cb) => requestAnimationFrame(cb))
    const tick = () => {
      if (!this.running || this.mode !== 'raf') return
      this.rafId = request(tick)
      this.onTick?.()
    }
    this.rafId = request(tick)
  }

  private cancelAll(): void {
    if (this.rafId) {
      const cancel = this.options.cancelFrame ?? ((id) => cancelAnimationFrame(id))
      cancel(this.rafId)
      this.rafId = 0
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' })
      this.worker.onmessage = null
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker
    if (this.workerBroken) return null
    try {
      const created = this.options.createWorker
        ? this.options.createWorker()
        : typeof Worker === 'undefined'
          ? null
          : new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' })))
      if (!created) {
        this.workerBroken = true
        return null
      }
      created.onerror = () => {
        this.workerBroken = true
        this.worker = null
        if (this.running) this.reschedule()
      }
      this.worker = created
      return created
    } catch {
      this.workerBroken = true
      return null
    }
  }
}
