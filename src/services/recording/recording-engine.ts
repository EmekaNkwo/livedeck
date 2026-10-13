import type { RecordingError, RecordingFormat, RecordingStatus } from '@/types/recording'
import { detectCapabilities } from '@/lib/capabilities'
import {
  AUDIO_BITRATE,
  extensionForMimeType,
  selectRecordingFormat,
  suggestVideoBitrate,
} from './mime'

/**
 * Local recording of the composed program output.
 *
 * WHAT IS RECORDED
 * ----------------
 * The video track comes from `canvas.captureStream()` on the *program canvas*
 * — the same canvas the operator is previewing. The audio track comes from the
 * mixer's `MediaStreamAudioDestinationNode`. So scene switches, transforms,
 * crops, hidden sources, mutes and fader moves are all in the file by
 * construction, because there is no separate render or mix for recording.
 *
 * HONESTY
 * -------
 * `status` only reaches `'complete'` after MediaRecorder has fired `stop` and
 * the blob has been assembled. Nothing here reports success before the browser
 * has actually produced data.
 */

export type RecordingResult = {
  blob: Blob
  mimeType: string
  extension: string
  durationMs: number
  width: number
  height: number
  frameRate: number
}

export type RecordingEngineEvents = {
  onStatusChange: (status: RecordingStatus) => void
  onError: (error: RecordingError) => void
  onComplete: (result: RecordingResult) => void
  /** Fired roughly every 250ms while recording, for the elapsed-time display. */
  onTick: (elapsedMs: number) => void
}

export type StartRecordingOptions = {
  canvas: HTMLCanvasElement
  /** Program audio from the mixer; null records video only. */
  audioStream: MediaStream | null
  frameRate: number
}

export class RecordingEngine {
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private captureStream: MediaStream | null = null
  private status: RecordingStatus = 'idle'
  private format: RecordingFormat | null = null

  private startedAt = 0
  private accumulatedMs = 0
  private pausedAt = 0
  private tickTimer: ReturnType<typeof setInterval> | null = null

  private dimensions = { width: 0, height: 0 }
  private frameRate = 30

  private events: Partial<RecordingEngineEvents> = {}

  setEvents(events: Partial<RecordingEngineEvents>): void {
    this.events = events
  }

  getStatus(): RecordingStatus {
    return this.status
  }

  getFormat(): RecordingFormat | null {
    return this.format
  }

  /** Elapsed recorded time, excluding paused spans. */
  getElapsedMs(): number {
    if (this.status === 'recording') {
      return this.accumulatedMs + (performance.now() - this.startedAt)
    }
    return this.accumulatedMs
  }

  canPause(): boolean {
    return detectCapabilities().recorderPause
  }

  /**
   * Begin recording. Resolves once MediaRecorder is running, or rejects having
   * already reported a structured error through `onError`.
   */
  async start(options: StartRecordingOptions): Promise<boolean> {
    if (this.status === 'recording' || this.status === 'starting') return false

    this.setStatus('starting')
    const caps = detectCapabilities()

    if (!caps.mediaRecorder) {
      this.fail({
        code: 'unsupported',
        message: 'This browser does not support MediaRecorder, so recording is unavailable.',
        recoverable: false,
        at: Date.now(),
      })
      return false
    }
    if (!caps.canvasCaptureStream) {
      this.fail({
        code: 'unsupported',
        message:
          'This browser cannot capture a stream from a canvas, so the program output cannot be recorded.',
        recoverable: false,
        at: Date.now(),
      })
      return false
    }

    const format = selectRecordingFormat()
    if (!format) {
      this.fail({
        code: 'unsupported',
        message:
          'No video container supported by both this browser and MediaRecorder could be found.',
        recoverable: false,
        at: Date.now(),
      })
      return false
    }
    this.format = format

    let stream: MediaStream
    try {
      // Capturing at the target rate ties encoder cadence to the compositor's
      // cadence, so a 30fps production does not get encoded as 60fps of
      // duplicated frames.
      stream = options.canvas.captureStream(options.frameRate)
    } catch (error) {
      this.fail({
        code: 'no-video-track',
        message: 'The program canvas could not be captured.',
        recoverable: true,
        at: Date.now(),
      })
      void error
      return false
    }

    if (stream.getVideoTracks().length === 0) {
      this.fail({
        code: 'no-video-track',
        message: 'The program canvas produced no video track.',
        recoverable: true,
        at: Date.now(),
      })
      return false
    }

    // Combine program video with mixed program audio into one stream.
    const combined = new MediaStream(stream.getVideoTracks())
    const audioTracks = options.audioStream?.getAudioTracks() ?? []
    for (const track of audioTracks) combined.addTrack(track)

    this.captureStream = stream
    this.dimensions = { width: options.canvas.width, height: options.canvas.height }
    this.frameRate = options.frameRate
    this.chunks = []

    const recorderOptions: MediaRecorderOptions = {
      mimeType: format.mimeType,
      videoBitsPerSecond: suggestVideoBitrate(
        this.dimensions.width,
        this.dimensions.height,
        options.frameRate,
      ),
    }
    if (audioTracks.length > 0) recorderOptions.audioBitsPerSecond = AUDIO_BITRATE

    try {
      this.recorder = new MediaRecorder(combined, recorderOptions)
    } catch {
      // Some builds accept a mimeType in isTypeSupported but reject the full
      // options object (usually the bitrate hints). Retry bare before failing.
      try {
        this.recorder = new MediaRecorder(combined, { mimeType: format.mimeType })
      } catch (error) {
        this.releaseCapture()
        this.fail({
          code: 'recorder-error',
          message: 'The recorder could not be created with any supported configuration.',
          recoverable: false,
          at: Date.now(),
        })
        void error
        return false
      }
    }

    this.attachRecorderListeners(this.recorder)

    try {
      // A timeslice makes the browser flush chunks as it goes. Without it, a
      // crash mid-recording loses everything, and memory grows unbounded in
      // one opaque buffer.
      this.recorder.start(1000)
    } catch {
      this.releaseCapture()
      this.fail({
        code: 'recorder-error',
        message: 'The recorder failed to start.',
        recoverable: true,
        at: Date.now(),
      })
      return false
    }

    this.accumulatedMs = 0
    this.startedAt = performance.now()
    this.setStatus('recording')
    this.startTicking()
    return true
  }

  pause(): void {
    if (this.status !== 'recording' || !this.recorder) return
    if (!this.canPause()) return
    try {
      this.recorder.pause()
    } catch {
      return
    }
    this.accumulatedMs += performance.now() - this.startedAt
    this.pausedAt = performance.now()
    this.stopTicking()
    this.setStatus('paused')
  }

  resume(): void {
    if (this.status !== 'paused' || !this.recorder) return
    try {
      this.recorder.resume()
    } catch {
      return
    }
    void this.pausedAt
    this.startedAt = performance.now()
    this.startTicking()
    this.setStatus('recording')
  }

  /**
   * Stop and finalize. The result arrives through `onComplete` once the
   * recorder's `stop` event fires — this method does not resolve with the blob,
   * because the blob does not exist yet when `stop()` returns.
   */
  stop(): void {
    if (this.status !== 'recording' && this.status !== 'paused') return
    if (!this.recorder) return
    if (this.status === 'recording') {
      this.accumulatedMs += performance.now() - this.startedAt
    }
    this.stopTicking()
    this.setStatus('finalizing')
    try {
      this.recorder.stop()
    } catch {
      this.fail({
        code: 'finalize-failed',
        message: 'The recording could not be finalized.',
        recoverable: false,
        at: Date.now(),
      })
    }
  }

  /** Abandon an in-flight recording without producing a result. */
  cancel(): void {
    this.stopTicking()
    const recorder = this.recorder
    this.recorder = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      try {
        recorder.stop()
      } catch {
        // Nothing more to do; we are discarding the data regardless.
      }
    }
    this.chunks = []
    this.releaseCapture()
    this.setStatus('idle')
  }

  private attachRecorderListeners(recorder: MediaRecorder): void {
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data)
    }

    recorder.onerror = () => {
      this.stopTicking()
      this.releaseCapture()
      this.fail({
        code: 'recorder-error',
        message: 'The recorder stopped unexpectedly. Any data captured so far was kept.',
        recoverable: true,
        at: Date.now(),
      })
    }

    recorder.onstop = () => {
      // Trust the recorder's own mimeType over the one we requested: browsers
      // are permitted to substitute, and the file extension must follow the
      // real contents.
      const effectiveMime = recorder.mimeType || this.format?.mimeType || 'video/webm'
      const blob = new Blob(this.chunks, { type: effectiveMime })
      this.chunks = []
      this.releaseCapture()
      this.recorder = null

      if (blob.size === 0) {
        this.fail({
          code: 'finalize-failed',
          message: 'The recording finished with no data. Nothing was saved.',
          recoverable: true,
          at: Date.now(),
        })
        return
      }

      this.setStatus('complete')
      this.events.onComplete?.({
        blob,
        mimeType: effectiveMime,
        extension: extensionForMimeType(effectiveMime),
        durationMs: Math.round(this.accumulatedMs),
        width: this.dimensions.width,
        height: this.dimensions.height,
        frameRate: this.frameRate,
      })
    }
  }

  /**
   * Release the canvas capture tracks.
   *
   * These tracks belong to the recorder alone — they are created per recording
   * from the canvas and are not shared — so stopping them here is correct and
   * is required to let the browser release the encoder.
   */
  private releaseCapture(): void {
    if (!this.captureStream) return
    for (const track of this.captureStream.getTracks()) {
      try {
        track.stop()
      } catch {
        // Already stopped.
      }
    }
    this.captureStream = null
  }

  private startTicking(): void {
    this.stopTicking()
    this.tickTimer = setInterval(() => {
      this.events.onTick?.(this.getElapsedMs())
    }, 250)
  }

  private stopTicking(): void {
    if (this.tickTimer === null) return
    clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  private setStatus(status: RecordingStatus): void {
    if (this.status === status) return
    this.status = status
    this.events.onStatusChange?.(status)
  }

  private fail(error: RecordingError): void {
    this.setStatus('error')
    this.events.onError?.(error)
  }

  /** Full teardown, used when a session ends or the app unmounts. */
  dispose(): void {
    this.cancel()
    this.events = {}
    this.format = null
  }
}

export const recordingEngine = new RecordingEngine()
