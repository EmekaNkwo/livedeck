import Dexie, { type EntityTable } from 'dexie'
import { detectCapabilities } from '@/lib/capabilities'

/**
 * IndexedDB storage for local media assets: the images and video files an
 * operator drops into a production.
 *
 * These used to travel inside the studio document as data URLs, which put
 * tens of megabytes of base64 into localStorage — a store capped at about
 * 5 MB — so any real asset made the whole production unsaveable, silently.
 * Here the bytes live as Blobs on disk and the document carries only an id.
 */

export type StoredAsset = {
  id: string
  kind: 'image' | 'video'
  name: string
  type: string
  size: number
  createdAt: number
  blob: Blob
}

/** Larger than this and the browser's decode path, not storage, is the limit. */
export const MAX_ASSET_BYTES = 500 * 1024 * 1024

class AssetDatabase extends Dexie {
  assets!: EntityTable<StoredAsset, 'id'>

  constructor() {
    super('livedeck-assets')
    this.version(1).stores({ assets: 'id, kind, createdAt' })
  }
}

let database: AssetDatabase | null = null

function db(): AssetDatabase {
  if (!detectCapabilities().indexedDb) throw new Error('IndexedDB is unavailable in this browser.')
  if (!database) database = new AssetDatabase()
  return database
}

export function createAssetId(): string {
  return `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export async function putAsset(asset: Omit<StoredAsset, 'id' | 'createdAt'> & { id?: string }): Promise<StoredAsset> {
  const stored: StoredAsset = { ...asset, id: asset.id ?? createAssetId(), createdAt: Date.now() }
  await db().assets.put(stored)
  return stored
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  return (await db().assets.get(id)) ?? null
}

export async function deleteAsset(id: string): Promise<void> {
  await db().assets.delete(id)
}

export async function listAssetIds(): Promise<string[]> {
  return db().assets.toCollection().primaryKeys()
}

/** Drop assets no source references any more. */
export async function pruneAssets(referenced: ReadonlySet<string>): Promise<number> {
  const ids = await listAssetIds()
  const doomed = ids.filter((id) => !referenced.has(id))
  if (doomed.length > 0) await db().assets.bulkDelete(doomed)
  return doomed.length
}

/** Decode a data URL into a Blob, for migrating legacy documents. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const type = match[1] ?? 'application/octet-stream'
  const payload = match[3] ?? ''
  try {
    if (match[2]) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type })
    }
    return new Blob([decodeURIComponent(payload)], { type })
  } catch {
    return null
  }
}

/** Test seam. */
export function resetAssetStore(): void {
  database?.close()
  database = null
}
