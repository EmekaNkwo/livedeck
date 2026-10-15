import {
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type AudioCodec,
  type StreamTargetChunk,
} from 'mediabunny'
import { AUDIO_BITRATE } from './mime'

/**
 * Program capture through WebCodecs into fragmented MP4.
 *
 * WHY
 * ---
 * MediaRecorder in Chromium writes WebM, which editors handle badly, and its
 * MP4 output is limited. Encoding with WebCodecs gives H.264 + AAC, the pair
 * every editor and player accepts, with the bitrate and keyframe cadence
 * under our control.
 *
 * CRASH SAFETY
 * ------------
 * The file is fragmented: roughly every second a self-contained fragment
 * (its own index plus its media) is appended. Bytes only ever go to the end,
 * so they are handed to the chunk sink as they come and a crash loses at most
 * the fragment in progress. On Stop the fragments are rewritten into a
 * standard MP4 by the remux step; until then the fragmented file is itself
 * playable, which is what makes recovery possible.
 */

export const MP4_FORMAT_LABEL = 'MP4 · H.264 + AAC'
export const MP4_MIME = 'video/mp4;codecs=avc1,mp4a.40.2'

/** Fragment length. Also bounds what a crash can lose. */
const FRAGMENT_SECONDS = 1
/** A keyframe every two seconds keeps seeking responsive. */
const KEYFRAME_SECONDS = 2

export type Mp4Plan = {
  /** Audio codec to use, or null when the stream has no audio. */
  audioCodec: AudioCodec | null
}

export type Mp4CaptureOptions = {
  video: MediaStreamVideoTrack
  audio: MediaStreamAudioTrack | null
  plan: Mp4Plan
  frameRate: number
  videoBitrate: number
  /** Receives each run of appended bytes, in order. */
  onData: (data: Blob) => void
  /** Called once if the encoder or muxer fails while running. */
  onError: (error: Error) => void
}

/** True when WebCodecs exists at all; cheap, synchronous. */
export function hasWebCodecs(): boolean {
  return typeof globalThis.VideoEncoder === 'function' && typeof globalThis.AudioEncoder === 'function'
}

/**
 * Whether this browser can encode the program as H.264 (+ AAC or Opus) at
 * this size. Resolves null when it cannot, and the caller uses MediaRecorder.
 */
export async function planMp4Capture(
  width: number,
  height: number,
  frameRate: number,
  videoBitrate: number,
  withAudio: boolean,
): Promise<Mp4Plan | null> {
  if (!hasWebCodecs()) return null
  try {
    const video = await canEncodeVideo('avc', { width, height, frameRate, bitrate: videoBitrate })
    if (!video) return null
    if (!withAudio) return { audioCodec: null }
    // AAC first: it is what editors expect in MP4. Opus in MP4 plays in every
    // browser and VLC, so it is an acceptable second choice.
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: AUDIO_BITRATE,
    })
    return audioCodec ? { audioCodec } : null
  } catch {
    return null
  }
}

export class Mp4Capture {
  private readonly output: Output
  private readonly videoSource: MediaStreamVideoTrackSource
  private readonly audioSource: MediaStreamAudioTrackSource | null
  private written = 0
  private failed = false
  private readonly onError: (error: Error) => void

  private constructor(options: Mp4CaptureOptions) {
    this.onError = options.onError
    const sink = new WritableStream<StreamTargetChunk>({
      write: (chunk) => {
        // Fragmented output only appends. Anything else would be a muxer bug
        // that silently corrupts the stored file, so stop on it.
        if (chunk.position !== this.written) {
          throw new Error(`Unexpected write at ${chunk.position}; ${this.written} bytes were written.`)
        }
        this.written += chunk.data.byteLength
        options.onData(new Blob([chunk.data]))
      },
    })
    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: FRAGMENT_SECONDS }),
      // Unchunked: the muxer flushes once per finished fragment and each flush
      // arrives as one contiguous write, so every fragment reaches storage as
      // soon as it is complete. Buffering into larger chunks would hold back
      // seconds of video at low bitrates, all of it lost in a crash.
      target: new StreamTarget(sink),
    })
    this.videoSource = new MediaStreamVideoTrackSource(
      options.video,
      {
        codec: 'avc',
        bitrate: options.videoBitrate,
        keyFrameInterval: KEYFRAME_SECONDS,
        // The canvas size is locked while recording; refuse a change rather
        // than encode a stretched picture.
        sizeChangeBehavior: 'deny',
      },
      { frameRate: options.frameRate },
    )
    this.output.addVideoTrack(this.videoSource, { frameRate: options.frameRate })
    this.audioSource =
      options.audio && options.plan.audioCodec
        ? new MediaStreamAudioTrackSource(options.audio, {
            codec: options.plan.audioCodec,
            bitrate: AUDIO_BITRATE,
          })
        : null
    if (this.audioSource) this.output.addAudioTrack(this.audioSource)

    for (const source of [this.videoSource, this.audioSource]) {
      source?.errorPromise.catch((error: unknown) => this.fail(error))
    }
  }

  /** Start encoding. Rejects if the encoder cannot be configured. */
  static async start(options: Mp4CaptureOptions): Promise<Mp4Capture> {
    const capture = new Mp4Capture(options)
    await capture.output.start()
    return capture
  }

  get bytesWritten(): number {
    return this.written
  }

  pause(): void {
    this.videoSource.pause()
    this.audioSource?.pause()
  }

  resume(): void {
    this.videoSource.resume()
    this.audioSource?.resume()
  }

  /** Flush the last fragment. Every byte has reached `onData` when this resolves. */
  async stop(): Promise<void> {
    await this.output.finalize()
  }

  /** Abandon the file; nothing more reaches `onData`. */
  async cancel(): Promise<void> {
    this.failed = true
    try {
      await this.output.cancel()
    } catch {
      // Already torn down.
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.onError(error instanceof Error ? error : new Error(String(error)))
  }
}
