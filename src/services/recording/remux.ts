import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from 'mediabunny'
import type { PositionalWrite } from './positional-writer'

/**
 * Rewrite a recording into its final, editor-friendly container without
 * re-encoding.
 *
 * Capture writes formats that survive a crash but that editors handle
 * poorly: fragmented MP4 (each fragment self-contained) or MediaRecorder's
 * streamed WebM (no duration, no cues). On Stop, and when recovering an
 * interrupted recording, the packets are copied into:
 *
 *   mp4    a standard MP4 with its index at the end — what Premiere,
 *          Resolve, QuickTime and VLC expect
 *   webm   a WebM with a duration and a cue index, so it reports its length
 *          and seeks
 *
 * The source is read from a disk-backed Blob in slices and the output goes
 * to a positional writer, so neither side is held in memory.
 */

export type FinalContainer = 'mp4' | 'webm'

export type RemuxResult = {
  durationMs: number
  /** Tracks that could not be carried over, with the reason; normally empty. */
  discarded: string[]
}

const CHUNK_SIZE = 1 << 20

export async function remux(
  source: Blob,
  container: FinalContainer,
  sink: WritableStream<PositionalWrite>,
  onProgress?: (fraction: number) => void,
): Promise<RemuxResult> {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS })
  try {
    const output = new Output({
      format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(sink as WritableStream<{ type: 'write'; data: Uint8Array<ArrayBuffer>; position: number }>, {
        chunked: true,
        chunkSize: CHUNK_SIZE,
      }),
    })
    const conversion = await Conversion.init({ input, output, showWarnings: false })
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((entry) => `${entry.track.type}: ${entry.reason}`)
      throw new Error(`The recording could not be rewritten (${reasons.join('; ') || 'no usable tracks'}).`)
    }
    if (onProgress) conversion.onProgress = (progress) => onProgress(progress)
    await conversion.execute()
    const duration = await input.computeDuration()
    return {
      durationMs: Math.round(duration * 1000),
      discarded: conversion.discardedTracks.map((entry) => `${entry.track.type}: ${entry.reason}`),
    }
  } finally {
    input.dispose()
  }
}

/** Which final container a captured MIME type becomes. */
export function finalContainerFor(mimeType: string): FinalContainer {
  return /mp4|quicktime/i.test(mimeType) ? 'mp4' : 'webm'
}

export type MediaDescription = {
  mimeType: string
  durationMs: number
  /** Duration written in the header, or null when the container has none. */
  headerDurationMs: number | null
  videoCodec: string | null
  audioCodec: string | null
}

/**
 * Read a file back the way a player would: its container, the duration its
 * header claims and the duration its packets span, and its codecs. Used to
 * check a rewritten recording before it replaces the captured one.
 */
export async function describeMedia(file: Blob): Promise<MediaDescription> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const [mimeType, duration, headerDuration, video, audio] = await Promise.all([
      input.getMimeType(),
      input.computeDuration(),
      input.getDurationFromMetadata(),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ])
    return {
      mimeType,
      durationMs: Math.round(duration * 1000),
      headerDurationMs: headerDuration === null ? null : Math.round(headerDuration * 1000),
      videoCodec: video ? await video.getCodec() : null,
      audioCodec: audio ? await audio.getCodec() : null,
    }
  } finally {
    input.dispose()
  }
}
