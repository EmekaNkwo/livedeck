import {
  appendChunk,
  deleteChunks,
  loadChunk,
  loadRecordingBlob,
  putScratchChunk,
  replaceChunks,
} from '@/services/persistence/recording-store'
import { extensionForMimeType } from './mime'
import { PositionalChunkWriter } from './positional-writer'
import { patchWebmDuration } from './webm-duration'
import type { MediaDescription } from './remux'

/**
 * Turn what capture stored into the file the user downloads.
 *
 * Capture writes for crash safety: fragmented MP4, or MediaRecorder's
 * streamed WebM with no duration and no cue index. Finalizing rewrites the
 * packets, without re-encoding, into a standard MP4 or an indexed WebM, which
 * editors open, which report their length and which seek. The rewrite goes to
 * a scratch file beside the recording and replaces it in one transaction.
 *
 * If the rewrite fails the captured file is kept: for WebM its header still
 * gets the duration patched in, so it plays and reports its length. Losing a
 * recording over an index would be the wrong trade.
 */

export type FinalizeInput = {
  id: string
  mimeType: string
  /** Duration the recorder measured; used when the file cannot tell us. */
  durationMs: number
  /** Bytes captured; the size when nothing is rewritten. */
  bytes: number
}

export type FinalizeResult = {
  mimeType: string
  extension: string
  durationMs: number
  size: number
  /** False when the captured file was kept as it was. */
  remuxed: boolean
  /** Why the rewrite was skipped or failed, for the issues panel. */
  warning: string | null
}

export function scratchIdFor(recordingId: string): string {
  return `${recordingId}~final`
}

export async function finalizeRecording(input: FinalizeInput): Promise<FinalizeResult> {
  const source = await loadRecordingBlob(input.id)
  if (!source) throw new Error('The recording has no stored data to finalize.')

  const scratchId = scratchIdFor(input.id)
  try {
    // A crash during an earlier attempt can leave a partial scratch file.
    await deleteChunks(scratchId)
    const { remux, finalContainerFor, describeMedia } = await import('./remux')
    // The bytes decide the container, not the row: the row is written
    // before capture starts and only guesses.
    const before = await describeMedia(source)
    const container = finalContainerFor(before.mimeType)
    const writer = new PositionalChunkWriter({
      write: (index, blob) => putScratchChunk(scratchId, index, blob),
      read: (index) => loadChunk(scratchId, index),
    })
    const result = await remux(source, container, writer.stream())
    await verifyRewrite(scratchId, before, describeMedia)
    await replaceChunks(input.id, scratchId)
    const mimeType = container === 'mp4' ? 'video/mp4' : 'video/webm'
    return {
      mimeType,
      extension: extensionForMimeType(mimeType),
      durationMs: result.durationMs > 0 ? result.durationMs : input.durationMs,
      size: writer.bytes,
      remuxed: true,
      warning: result.discarded.length > 0 ? `Some tracks were left out: ${result.discarded.join('; ')}` : null,
    }
  } catch (error) {
    await deleteChunks(scratchId).catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    const kept = await keepCaptured(input, source)
    return { ...kept, warning: `The recording was kept as captured (${reason}).` }
  }
}

/**
 * The rewrite must carry every track the capture had and play for a
 * duration. A file that opens with a track missing would replace a good
 * recording with a worse one, so it is rejected here.
 */
async function verifyRewrite(
  scratchId: string,
  before: MediaDescription,
  describe: (file: Blob) => Promise<MediaDescription>,
): Promise<void> {
  const rewritten = await loadRecordingBlob(scratchId)
  if (!rewritten) throw new Error('the rewrite produced no data')
  const after = await describe(rewritten)
  if (after.durationMs <= 0) throw new Error('the rewritten file has no duration')
  if (Boolean(before.videoCodec) !== Boolean(after.videoCodec)) throw new Error('the video track was lost')
  if (Boolean(before.audioCodec) !== Boolean(after.audioCodec)) throw new Error('the audio track was lost')
}

/** Fallback: the captured file, with the WebM duration patched in. */
async function keepCaptured(input: FinalizeInput, source: Blob): Promise<Omit<FinalizeResult, 'warning'>> {
  let size = input.bytes
  if (input.mimeType.includes('webm')) {
    const patched = await patchWebmDuration(source, input.durationMs)
    if (patched.patched) {
      // Only the leading bytes changed; rewrite chunk 0 with the new header
      // plus whatever of the original chunk 0 followed it.
      const firstSize = (await loadChunk(input.id, 0))?.size ?? 0
      const headerLength = patched.blob.size - source.size + firstSize
      await appendChunk(input.id, 0, patched.blob.slice(0, headerLength), Date.now())
      size = patched.blob.size
    }
  }
  return {
    mimeType: input.mimeType,
    extension: extensionForMimeType(input.mimeType),
    durationMs: input.durationMs,
    size,
    remuxed: false,
  }
}
