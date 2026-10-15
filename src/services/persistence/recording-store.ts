import Dexie, { type EntityTable } from 'dexie'
import type { RecordingEntry } from '@/types/recording'
import { detectCapabilities } from '@/lib/capabilities'

/**
 * IndexedDB storage for recordings, written as they happen.
 *
 * A recording is a row in `recordings` plus a run of rows in `chunks`, one
 * per MediaRecorder timeslice. Chunks are appended while the recorder runs,
 * so nothing accumulates in memory and a crash two hours in loses at most
 * the last second. The row's `status` says whether the run was finished
 * properly; on the next load an unfinished one is recovered from its chunks.
 *
 * Reading a recording back builds one `Blob` out of the chunk blobs. The
 * browser keeps those on disk and the composite is a list of references, so
 * a multi-gigabyte file is never pulled into the JavaScript heap.
 *
 * Quota exhaustion is expected rather than exceptional: a failed append is
 * reported as {@link QuotaExceededError} and the recorder decides what to do.
 */

export type StoredRecording = RecordingEntry & {
  /** `recording` while chunks are arriving; `interrupted` when found that way on load. */
  status: 'recording' | 'complete' | 'interrupted'
  startedAt: number
  /** Index of the last chunk that reached the store, or -1. */
  lastChunkIndex: number
  updatedAt: number
}

export type StoredChunk = {
  /** `${recordingId}:${index}` so order is a string sort and keys are unique. */
  key: string
  recordingId: string
  index: number
  bytes: number
  at: number
  blob: Blob
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

class RecordingDatabase extends Dexie {
  recordings!: EntityTable<StoredRecording, 'id'>
  chunks!: EntityTable<StoredChunk, 'key'>

  constructor() {
    super('livedeck-recordings')
    // v1 held whole blobs under `blobs` and metadata under `metadata`. v2
    // moves to chunks; v1 rows are read once and converted to a single chunk.
    this.version(2)
      .stores({
        recordings: 'id, createdAt, sessionId, status',
        chunks: 'key, recordingId, [recordingId+index]',
        blobs: '',
        metadata: 'id',
      })
      .upgrade(async (tx) => {
        const legacyMeta = tx.table('metadata')
        const legacyBlobs = tx.table('blobs')
        const metas = (await legacyMeta.toArray()) as RecordingEntry[]
        for (const meta of metas) {
          const blob = (await legacyBlobs.get(meta.id)) as Blob | undefined
          await tx.table('recordings').put({
            ...meta,
            status: 'complete',
            startedAt: meta.createdAt,
            lastChunkIndex: blob ? 0 : -1,
            updatedAt: meta.createdAt,
          } satisfies StoredRecording)
          if (blob) {
            await tx.table('chunks').put({
              key: `${meta.id}:${pad(0)}`,
              recordingId: meta.id,
              index: 0,
              bytes: blob.size,
              at: meta.createdAt,
              blob,
            } satisfies StoredChunk)
          }
        }
        await legacyMeta.clear()
        await legacyBlobs.clear()
      })
  }
}

let database: RecordingDatabase | null = null

function db(): RecordingDatabase {
  if (!detectCapabilities().indexedDb) throw new Error('IndexedDB is unavailable in this browser.')
  if (!database) database = new RecordingDatabase()
  return database
}

function pad(index: number): string {
  return String(index).padStart(8, '0')
}

function normalizeError(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name
  if (name === 'QuotaExceededError' || /quota/i.test(String((error as { message?: string })?.message ?? ''))) {
    return new QuotaExceededError(
      'There is not enough storage space to keep this recording. You can still download what was captured.',
    )
  }
  if (error instanceof Error) return error
  return new Error(String(error ?? 'Unknown IndexedDB error'))
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw normalizeError(error)
  }
}

/* -------------------------------------------------------------- writing */

/** Open a recording row before the first chunk arrives. */
export async function beginRecording(entry: RecordingEntry, startedAt: number): Promise<void> {
  await guard(() =>
    db().recordings.put({
      ...entry,
      persisted: true,
      status: 'recording',
      startedAt,
      lastChunkIndex: -1,
      updatedAt: startedAt,
    }),
  )
}

/** Append one timeslice. Throws {@link QuotaExceededError} when storage is full. */
export async function appendChunk(recordingId: string, index: number, blob: Blob, at: number): Promise<void> {
  await guard(() =>
    db().transaction('rw', db().chunks, db().recordings, async () => {
      await db().chunks.put({ key: `${recordingId}:${pad(index)}`, recordingId, index, bytes: blob.size, at, blob })
      await db().recordings.update(recordingId, { lastChunkIndex: index, updatedAt: at })
    }),
  )
}

/** Mark a recording finished, with its final metadata. */
export async function finishRecording(
  recordingId: string,
  patch: Partial<Pick<RecordingEntry, 'durationMs' | 'size' | 'mimeType' | 'extension' | 'name'>>,
): Promise<void> {
  await guard(() =>
    db().recordings.update(recordingId, { ...patch, status: 'complete', persisted: true, updatedAt: Date.now() }),
  )
}

/* -------------------------------------------------------------- reading */

/** All finished recordings, newest first. */
export async function listRecordings(): Promise<RecordingEntry[]> {
  const rows = await guard(() => db().recordings.where('status').equals('complete').toArray())
  return rows.map(toEntry).sort((a, b) => b.createdAt - a.createdAt)
}

/** Recordings that were still running when the page last went away. */
export async function listUnfinishedRecordings(): Promise<StoredRecording[]> {
  return guard(() => db().recordings.where('status').anyOf(['recording', 'interrupted']).toArray())
}

export async function markInterrupted(recordingId: string): Promise<void> {
  await guard(() => db().recordings.update(recordingId, { status: 'interrupted', updatedAt: Date.now() }))
}

/** Size, chunk count and the time span of what reached the store. */
export async function describeChunks(
  recordingId: string,
): Promise<{ count: number; bytes: number; firstAt: number | null; lastAt: number | null }> {
  const rows = await guard(() => db().chunks.where('recordingId').equals(recordingId).toArray())
  if (rows.length === 0) return { count: 0, bytes: 0, firstAt: null, lastAt: null }
  const sorted = [...rows].sort((a, b) => a.index - b.index)
  return {
    count: sorted.length,
    bytes: sorted.reduce((sum, row) => sum + row.bytes, 0),
    firstAt: sorted[0]?.at ?? null,
    lastAt: sorted[sorted.length - 1]?.at ?? null,
  }
}

/** A single chunk's blob, or null. */
export async function loadChunk(recordingId: string, index: number): Promise<Blob | null> {
  const row = await guard(() => db().chunks.get(`${recordingId}:${pad(index)}`))
  return row?.blob ?? null
}

/** One Blob over every chunk, in order. Null when there are no chunks. */
export async function loadRecordingBlob(id: string): Promise<Blob | null> {
  const row = await guard(() => db().recordings.get(id))
  const chunks = await guard(() => db().chunks.where('recordingId').equals(id).toArray())
  if (chunks.length === 0) return null
  chunks.sort((a, b) => a.index - b.index)
  return new Blob(
    chunks.map((chunk) => chunk.blob),
    { type: row?.mimeType ?? chunks[0]?.blob.type ?? 'video/webm' },
  )
}

/* -------------------------------------------------------------- deleting */

export async function deleteRecording(id: string): Promise<void> {
  await guard(() =>
    db().transaction('rw', db().chunks, db().recordings, async () => {
      await db().chunks.where('recordingId').equals(id).delete()
      await db().recordings.delete(id)
    }),
  )
}

export async function deleteAllRecordings(): Promise<void> {
  await guard(() =>
    db().transaction('rw', db().chunks, db().recordings, async () => {
      await db().chunks.clear()
      await db().recordings.clear()
    }),
  )
}

/* -------------------------------------------------------------- storage */

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage
  if (!storage || typeof storage.estimate !== 'function') return null
  try {
    const estimate = await storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}

/** Ask the browser not to evict this origin's storage under pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage
  if (!storage || typeof storage.persist !== 'function') return false
  try {
    return await storage.persist()
  } catch {
    return false
  }
}

function toEntry(row: StoredRecording): RecordingEntry {
  const { status: _status, startedAt: _startedAt, lastChunkIndex: _last, updatedAt: _updated, ...entry } = row
  void _status
  void _startedAt
  void _last
  void _updated
  return entry
}

/** Test seam: drop the cached connection. */
export function resetRecordingStore(): void {
  database?.close()
  database = null
}
