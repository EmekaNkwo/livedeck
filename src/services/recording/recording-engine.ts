import type { RecordingError, RecordingFormat, RecordingStatus } from '@/types/recording'
import { detectCapabilities } from '@/lib/capabilities'
import {
  AUDIO_BITRATE,
  extensionForMimeType,
  selectRecordingFormat,
  suggestVideoBitrate,
} from './mime'
import type { Mp4Capture } from './mp4-capture'

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
 * HOW IT IS ENCODED
 * ------------------
 * Where WebCodecs can encode H.264 at the program size, frames go through
 * {@link Mp4Capture} into fragmented MP4 (H.264 + AAC). Elsewhere
 * MediaRecorder encodes, in whatever container the browser offers. Either
 * way the stored file is rewritten into its final container after Stop.
 *
 * WHERE THE DATA GOES
 * -------------------
 * Nowhere in this process. Every timeslice is handed to the {@link ChunkSink}
 * the caller supplied and forgotten; the engine never holds more than the
 * chunk in flight. A two-hour recording costs the same memory as a two-second
 * one, and a crash loses at most the last slice.
 *
 * HONESTY
 * -------
 * `status` only reaches `'complete'` after MediaRecorder has fired `stop` and
 * the last chunk has reached the sink. Nothing here reports success before the
 * browser has actually produced data.
 */

export type RecordingResult = {
  mimeType: string
  extension: string
  durationMs: number
  width: number
  height: number
  frameRate: number
  chunkCount: number
  bytes: number
}

/** Where chunks go. Rejecting stops the recording with `persist-failed`. */
export type ChunkSink = (index: number, chunk: Blob, at: number) => Promise<void>

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
  sink: ChunkSink
  /** Timeslice between chunks. Default one second. */
  timesliceMs?: number
  /** Try WebCodecs + MP4 before MediaRecorder. Default true. */
  preferMp4?: boolean
}

const DEFAULT_TIMESLICE_MS = 1000

export class RecordingEngine {
  private recorder: MediaRecorder | null = null
  private mp4: Mp4Capture | null = null
  private captureStream: MediaStream | null = null
  private status: RecordingStatus = 'idle'
  private format: RecordingFormat | null = null
  private sink: ChunkSink | null = null

  private chunkIndex = 0
  private bytes = 0
  /** Chained so chunks reach the sink in order even when writes overlap. */
  private writeQueue: Promise<void> = Promise.resolve()
  private sinkFailed = false

  private startedAt = 0
  private accumulatedMs = 0
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

  /** The dimensions locked at start; the file keeps them whatever the UI does. */
  getDimensions(): { width: number; height: number } {
    return this.dimensions
  }

  /** Elapsed recorded time, excluding paused spans. */
  getElapsedMs(): number {
    if (this.status === 'recording') {
      return this.accumulatedMs + (performance.now() - this.startedAt)
    }
    return this.accumulatedMs
  }

  canPause(): boolean {
    return this.mp4 !== null || detectCapabilities().recorderPause
  }

  /**
   * Begin recording. Resolves once MediaRecorder is running, or rejects having
   * already reported a structured error through `onError`.
   */
  async start(options: StartRecordingOptions): Promise<boolean> {
    if (this.status === 'recording' || this.status === 'starting') return false

    this.setStatus('starting')
    const caps = detectCapabilities()

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

    let stream: MediaStream
    try {
      // Capturing at the target rate ties encoder cadence to the compositor's
      // cadence, so a 30fps production does not get encoded as 60fps of
      // duplicated frames.
      stream = options.canvas.captureStream(options.frameRate)
    } catch {
      this.fail({
        code: 'no-video-track',
        message: 'The program canvas could not be captured.',
        recoverable: true,
        at: Date.now(),
      })
      return false
    }

    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) {
      this.fail({
        code: 'no-video-track',
        message: 'The program canvas produced no video track.',
        recoverable: true,
        at: Date.now(),
      })
      return false
    }

    this.captureStream = stream
    this.dimensions = { width: options.canvas.width, height: options.canvas.height }
    this.frameRate = options.frameRate
    this.sink = options.sink
    this.chunkIndex = 0
    this.bytes = 0
    this.sinkFailed = false
    this.writeQueue = Promise.resolve()

    const audioTrack = options.audioStream?.getAudioTracks()[0] ?? null
    const videoBitrate = suggestVideoBitrate(this.dimensions.width, this.dimensions.height, options.frameRate)

    const started =
      (options.preferMp4 !== false &&
        (await this.startMp4(videoTrack, audioTrack, options.frameRate, videoBitrate))) ||
      this.startMediaRecorder(stream, options, videoBitrate)
    if (!started) return false

    this.accumulatedMs = 0
    this.startedAt = performance.now()
    this.setStatus('recording')
    this.startTicking()
    return true
  }

  /** WebCodecs + fragmented MP4. False when unavailable, to fall back. */
  private async startMp4(
    video: MediaStreamVideoTrack,
    audio: MediaStreamAudioTrack | null,
    frameRate: number,
    videoBitrate: number,
  ): Promise<boolean> {
    try {
      const capture = await import('./mp4-capture')
      if (!capture.hasWebCodecs()) return false
      const plan = await capture.planMp4Capture(
        this.dimensions.width,
        this.dimensions.height,
        frameRate,
        videoBitrate,
        audio !== null,
      )
      if (!plan) return false
      this.mp4 = await capture.Mp4Capture.start({
        video,
        audio,
        plan,
        frameRate,
        videoBitrate,
        onData: (data) => this.enqueueChunk(data),
        onError: (error) => this.onMp4Error(error),
      })
      this.format = {
        mimeType: capture.MP4_MIME,
        extension: 'mp4',
        label: plan.audioCodec === 'opus' ? 'MP4 · H.264 + Opus' : capture.MP4_FORMAT_LABEL,
      }
      return true
    } catch {
      // The encoder refused this configuration; MediaRecorder may not.
      this.mp4 = null
      return false
    }
  }

  private startMediaRecorder(stream: MediaStream, options: StartRecordingOptions, videoBitrate: number): boolean {
    if (!detectCapabilities().mediaRecorder) {
      this.releaseCapture()
      this.fail({
        code: 'unsupported',
        message: 'This browser does not support MediaRecorder, so recording is unavailable.',
        recoverable: false,
        at: Date.now(),
      })
      return false
    }
    const format = selectRecordingFormat()
    if (!format) {
      this.releaseCapture()
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

    // Combine program video with mixed program audio into one stream.
    const combined = new MediaStream(stream.getVideoTracks())
    const audioTracks = options.audioStream?.getAudioTracks() ?? []
    for (const track of audioTracks) combined.addTrack(track)

    const recorderOptions: MediaRecorderOptions = {
      mimeType: format.mimeType,
      videoBitsPerSecond: videoBitrate,
    }
    if (audioTracks.length > 0) recorderOptions.audioBitsPerSecond = AUDIO_BITRATE

    try {
      this.recorder = new MediaRecorder(combined, recorderOptions)
    } catch {
      // Some builds accept a mimeType in isTypeSupported but reject the full
      // options object (usually the bitrate hints). Retry bare before failing.
      try {
        this.recorder = new MediaRecorder(combined, { mimeType: format.mimeType })
      } catch {
        this.releaseCapture()
        this.fail({
          code: 'recorder-error',
          message: 'The recorder could not be created with any supported configuration.',
          recoverable: false,
          at: Date.now(),
        })
        return false
      }
    }

    this.attachRecorderListeners(this.recorder)

    try {
      this.recorder.start(options.timesliceMs ?? DEFAULT_TIMESLICE_MS)
    } catch {
      this.recorder = null
      this.releaseCapture()
      this.fail({
        code: 'recorder-error',
        message: 'The recorder failed to start.',
        recoverable: true,
        at: Date.now(),
      })
      return false
    }
    return true
  }

  pause(): void {
    if (this.status !== 'recording') return
    if (this.mp4) {
      this.mp4.pause()
    } else {
      if (!this.recorder || !this.canPause()) return
      try {
        this.recorder.pause()
      } catch {
        return
      }
    }
    this.accumulatedMs += performance.now() - this.startedAt
    this.stopTicking()
    this.setStatus('paused')
  }

  resume(): void {
    if (this.status !== 'paused') return
    if (this.mp4) {
      this.mp4.resume()
    } else {
      if (!this.recorder) return
      try {
        this.recorder.resume()
      } catch {
        return
      }
    }
    this.startedAt = performance.now()
    this.startTicking()
    this.setStatus('recording')
  }

  /**
   * Stop and finalize. The result arrives through `onComplete` once the
   * recorder's `stop` event fires and the last chunk has been written.
   */
  stop(): void {
    if (this.status !== 'recording' && this.status !== 'paused') return
    if (!this.recorder && !this.mp4) return
    if (this.status === 'recording') {
      this.accumulatedMs += performance.now() - this.startedAt
    }
    this.stopTicking()
    this.setStatus('finalizing')
    if (this.mp4) {
      void this.stopMp4(this.mp4)
      return
    }
    try {
      this.recorder?.stop()
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
    const mp4 = this.mp4
    this.mp4 = null
    if (mp4) void mp4.cancel()
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
    this.sink = null
    this.releaseCapture()
    this.setStatus('idle')
  }

  private attachRecorderListeners(recorder: MediaRecorder): void {
    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return
      this.enqueueChunk(event.data)
    }

    recorder.onerror = () => {
      this.stopTicking()
      this.releaseCapture()
      this.fail({
        code: 'recorder-error',
        message:
          'The recorder stopped unexpectedly. Everything captured so far is stored and can be recovered.',
        recoverable: true,
        at: Date.now(),
      })
    }

    recorder.onstop = () => {
      // Trust the recorder's own mimeType over the one we requested: browsers
      // are permitted to substitute, and the file extension must follow the
      // real contents.
      const effectiveMime = recorder.mimeType || this.format?.mimeType || 'video/webm'
      this.releaseCapture()
      this.recorder = null

      this.completeAfterWrites(effectiveMime)
    }
  }

  private async stopMp4(capture: Mp4Capture): Promise<void> {
    try {
      // Resolves once the last fragment has been handed to the sink queue.
      await capture.stop()
    } catch {
      this.mp4 = null
      this.releaseCapture()
      this.fail({
        code: 'finalize-failed',
        message: 'The encoder could not finish the file. Everything captured so far is stored and can be recovered.',
        recoverable: true,
        at: Date.now(),
      })
      return
    }
    this.mp4 = null
    this.releaseCapture()
    this.completeAfterWrites(this.format?.mimeType ?? 'video/mp4')
  }

  private onMp4Error(error: Error): void {
    if (!this.mp4) return
    const capture = this.mp4
    this.mp4 = null
    void capture.cancel()
    this.stopTicking()
    this.releaseCapture()
    this.fail({
      code: 'recorder-error',
      message: `The encoder stopped unexpectedly (${error.message}). Everything captured so far is stored and can be recovered.`,
      recoverable: true,
      at: Date.now(),
    })
  }

  /** Wait for the last chunk to land before claiming completion. */
  private completeAfterWrites(mimeType: string): void {
    void this.writeQueue.then(() => {
      if (this.sinkFailed) return
      if (this.chunkIndex === 0) {
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
        mimeType,
        extension: extensionForMimeType(mimeType),
        durationMs: Math.round(this.accumulatedMs),
        width: this.dimensions.width,
        height: this.dimensions.height,
        frameRate: this.frameRate,
        chunkCount: this.chunkIndex,
        bytes: this.bytes,
      })
    })
  }

  private enqueueChunk(chunk: Blob): void {
    const sink = this.sink
    if (!sink || this.sinkFailed) return
    const index = this.chunkIndex
    this.chunkIndex += 1
    this.bytes += chunk.size
    const at = Date.now()
    this.writeQueue = this.writeQueue
      .then(() => sink(index, chunk, at))
      .catch((error: unknown) => {
        if (this.sinkFailed) return
        this.sinkFailed = true
        const message = error instanceof Error ? error.message : String(error)
        // Stop the recorder: there is nowhere to put the next chunk.
        this.stopTicking()
        const mp4 = this.mp4
        this.mp4 = null
        if (mp4) void mp4.cancel()
        const recorder = this.recorder
        this.recorder = null
        if (recorder && recorder.state !== 'inactive') {
          recorder.ondataavailable = null
          recorder.onstop = null
          try {
            recorder.stop()
          } catch {
            // Already stopping.
          }
        }
        this.releaseCapture()
        this.fail({
          code: /quota/i.test(message) ? 'quota-exceeded' : 'persist-failed',
          message: `${message} The recording stopped; the ${index} chunk${index === 1 ? '' : 's'} already stored can be recovered.`,
          recoverable: true,
          at: Date.now(),
        })
      })
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
