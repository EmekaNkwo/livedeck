import type { RecordingEntry } from '@/types/recording'
import { detectCapabilities } from '@/lib/capabilities'

/**
 * IndexedDB storage for recorded video blobs.
 *
 * localStorage is the wrong tool here — it is string-only and capped at a few
 * megabytes, while a short 1080p recording is tens of megabytes. IndexedDB
 * stores Blobs natively and has a far larger quota.
 *
 * Quota exhaustion is expected rather than exceptional: when a write fails the
 * caller keeps the blob in memory and marks the entry `persisted: false`, so
 * the user can still download it — they just lose it on reload. Nothing is
 * ever uploaded anywhere; all of this lives on the user's device.
 */

const DB_NAME = 'livedeck-recordings'
const DB_VERSION = 1
const BLOB_STORE = 'blobs'
const META_STORE = 'metadata'

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (!detectCapabilities().indexedDb) {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser.'))
  }
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE)
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        store.createIndex('sessionId', 'sessionId')
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // A version change from another tab invalidates this handle; drop the
      // cached promise so the next call reopens cleanly.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'))
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'))
  }).catch((error: unknown) => {
    dbPromise = null
    throw error
  })

  return dbPromise
}

function runTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction
        try {
          tx = db.transaction(storeNames, mode)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        let result: T
        let settled = false
        tx.oncomplete = () => {
          if (!settled) resolve(result)
        }
        tx.onerror = () => {
          settled = true
          reject(normalizeError(tx.error))
        }
        tx.onabort = () => {
          settled = true
          reject(normalizeError(tx.error))
        }
        Promise.resolve(work(tx))
          .then((value) => {
            result = value
          })
          .catch((error: unknown) => {
            settled = true
            try {
              tx.abort()
            } catch {
              // Already aborting.
            }
            reject(normalizeError(error))
          })
      }),
  )
}

function normalizeError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new QuotaExceededError(
      'There is not enough storage space to keep this recording. You can still download it.',
    )
  }
  if (error instanceof Error) return error
  return new Error(String(error ?? 'Unknown IndexedDB error'))
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(normalizeError(request.error))
  })
}

/**
 * Persist a recording's blob and metadata atomically.
 * Throws {@link QuotaExceededError} when storage is full.
 */
export async function saveRecording(entry: RecordingEntry, blob: Blob): Promise<void> {
  await runTransaction([BLOB_STORE, META_STORE], 'readwrite', async (tx) => {
    await promisify(tx.objectStore(BLOB_STORE).put(blob, entry.id))
    await promisify(tx.objectStore(META_STORE).put({ ...entry, persisted: true }))
  })
}

/** All persisted recordings, newest first. */
export async function listRecordings(): Promise<RecordingEntry[]> {
  const entries = await runTransaction([META_STORE], 'readonly', (tx) =>
    promisify(tx.objectStore(META_STORE).getAll() as IDBRequest<RecordingEntry[]>),
  )
  return entries.sort((a, b) => b.createdAt - a.createdAt)
}

export async function loadRecordingBlob(id: string): Promise<Blob | null> {
  const blob = await runTransaction([BLOB_STORE], 'readonly', (tx) =>
    promisify(tx.objectStore(BLOB_STORE).get(id) as IDBRequest<Blob | undefined>),
  )
  return blob ?? null
}

export async function deleteRecording(id: string): Promise<void> {
  await runTransaction([BLOB_STORE, META_STORE], 'readwrite', async (tx) => {
    await promisify(tx.objectStore(BLOB_STORE).delete(id))
    await promisify(tx.objectStore(META_STORE).delete(id))
  })
}

export async function deleteAllRecordings(): Promise<void> {
  await runTransaction([BLOB_STORE, META_STORE], 'readwrite', async (tx) => {
    await promisify(tx.objectStore(BLOB_STORE).clear())
    await promisify(tx.objectStore(META_STORE).clear())
  })
}

/** Remaining storage, when the browser is willing to estimate it. */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  const storage = navigator.storage as StorageManager | undefined
  if (!storage || typeof storage.estimate !== 'function') return null
  try {
    const estimate = await storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}

/** Test seam: drop the cached connection. */
export function resetRecordingStore(): void {
  dbPromise = null
}
