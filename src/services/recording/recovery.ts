import {
  deleteRecording,
  describeChunks,
  finishRecording,
  listUnfinishedRecordings,
} from '@/services/persistence/recording-store'
import { finalizeRecording } from './finalize'

/**
 * Turn recordings that were cut off into usable library entries.
 *
 * A row left in `recording` state means the page went away while chunks were
 * still arriving: a crash, a closed tab, a power cut. Its chunks are intact,
 * so the recording is finalized from what reached storage, exactly as Stop
 * would: rewritten into a standard MP4 or an indexed WebM, with the duration
 * read from the media itself. The row is then marked complete so it shows up
 * in the library like any other.
 *
 * A row with no chunks at all is dropped; there is nothing to recover.
 *
 * A recording that cannot be recovered is left in place for the next attempt
 * and reported in `failed` with the reason, so the operator hears about it.
 */
export type RecoveryReport = {
  recovered: number
  failed: Array<{ id: string; name: string; reason: string }>
}

export async function recoverInterruptedRecordings(): Promise<RecoveryReport> {
  const unfinished = await listUnfinishedRecordings()
  let recovered = 0
  const failed: RecoveryReport['failed'] = []
  for (const row of unfinished) {
    try {
      const chunks = await describeChunks(row.id)
      if (chunks.count === 0) {
        await deleteRecording(row.id)
        continue
      }
      // The chunk timestamps bound the recording; the last slice is one
      // timeslice long. Used only when the media cannot say for itself.
      const estimateMs = Math.max(1000, (chunks.lastAt ?? row.startedAt) - row.startedAt + 1000)
      const final = await finalizeRecording({
        id: row.id,
        mimeType: row.mimeType,
        durationMs: estimateMs,
        bytes: chunks.bytes,
      })
      await finishRecording(row.id, {
        durationMs: final.durationMs,
        size: final.size,
        mimeType: final.mimeType,
        extension: final.extension,
        name: row.name.includes('(recovered)') ? row.name : `${row.name} (recovered)`,
      })
      recovered += 1
    } catch (error) {
      // Leave the row for the next attempt rather than losing it.
      failed.push({ id: row.id, name: row.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { recovered, failed }
}
