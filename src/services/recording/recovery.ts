import {
  appendChunk,
  deleteRecording,
  describeChunks,
  finishRecording,
  listUnfinishedRecordings,
  loadChunk,
  loadRecordingBlob,
} from '@/services/persistence/recording-store'
import { patchWebmDuration } from './webm-duration'

/**
 * Turn recordings that were cut off into usable library entries.
 *
 * A row left in `recording` state means the page went away while chunks were
 * still arriving: a crash, a closed tab, a power cut. Its chunks are intact,
 * so the recording is finalized from what reached storage: the duration is
 * taken from the chunk timestamps, written into the WebM header, and the row
 * is marked complete so it shows up in the library like any other.
 *
 * A row with no chunks at all is dropped; there is nothing to recover.
 *
 * Returns the number of recordings recovered.
 */
export async function recoverInterruptedRecordings(): Promise<number> {
  let unfinished
  try {
    unfinished = await listUnfinishedRecordings()
  } catch {
    return 0
  }
  let recovered = 0
  for (const row of unfinished) {
    try {
      const chunks = await describeChunks(row.id)
      if (chunks.count === 0) {
        await deleteRecording(row.id)
        continue
      }
      // The chunk timestamps bound the recording; the last slice is one
      // timeslice long, which is close enough for a header.
      const durationMs = Math.max(1000, (chunks.lastAt ?? row.startedAt) - row.startedAt + 1000)
      let size = chunks.bytes
      if (row.mimeType.includes('webm')) {
        const whole = await loadRecordingBlob(row.id)
        if (whole) {
          const patched = await patchWebmDuration(whole, durationMs)
          if (patched.patched) {
            const firstSize = (await loadChunk(row.id, 0))?.size ?? 0
            const headerLength = patched.blob.size - whole.size + firstSize
            await appendChunk(row.id, 0, patched.blob.slice(0, headerLength), Date.now())
            size = patched.blob.size
          }
        }
      }
      await finishRecording(row.id, {
        durationMs,
        size,
        name: row.name.includes('(recovered)') ? row.name : `${row.name} (recovered)`,
      })
      recovered += 1
    } catch {
      // Leave the row for the next attempt rather than losing it.
    }
  }
  return recovered
}
