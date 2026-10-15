import type { Guest } from '@/types/peer'
import type { Scene } from '@/types/scene'
import type { MediaSource } from '@/types/source'
import type { AudioChannelConfig } from '@/types/audio'
import type { StudioSession } from '@/types/session'
import { reportPersistenceIssue } from './issues'
import { readJson, removeKey, writeJson } from './local-store'
import { StudioDocumentSchema, StudioSessionSchema, validate } from './schemas'

/**
 * Per-session studio documents.
 *
 * A "document" is everything about a production that is worth keeping: its
 * sources, scenes, guests and mixer settings. Documents are keyed by session
 * id, so opening a session from the lobby restores exactly that production
 * rather than whatever was edited last.
 *
 * STRICTLY SERIALIZABLE. Live streams are dropped on save (`streamKey` is
 * nulled) because a MediaStream cannot be serialized and would be meaningless
 * after a reload — capture is re-acquired, with a fresh permission prompt if
 * the browser requires one.
 */

export type StudioDocument = {
  version: 1
  sessionId: string
  savedAt: number
  sources: MediaSource[]
  sourceOrder: string[]
  scenes: Scene[]
  sceneOrder: string[]
  activeSceneId: string | null
  guests: Guest[]
  guestOrder: string[]
  audioChannels: AudioChannelConfig[]
  audioChannelOrder: string[]
}

const SESSION_INDEX = 'sessions'

function documentKey(sessionId: string): string {
  return `doc:${sessionId}`
}

/* ------------------------------------------------------------------ session index */

export function listSessions(): StudioSession[] {
  const sessions = readJson<unknown>(SESSION_INDEX, [])
  if (!Array.isArray(sessions)) {
    reportPersistenceIssue({ record: 'session index', message: 'not a list; it was reset' })
    return []
  }
  const valid: StudioSession[] = []
  let dropped = 0
  for (const candidate of sessions) {
    const result = validate(StudioSessionSchema, candidate, 'session')
    if (result.ok) valid.push(result.data as StudioSession)
    else dropped += 1
  }
  if (dropped > 0) {
    reportPersistenceIssue({ record: 'session index', message: `${dropped} malformed entr${dropped === 1 ? 'y was' : 'ies were'} dropped` })
  }
  return valid.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

export function findSession(sessionId: string): StudioSession | null {
  return listSessions().find((session) => session.id === sessionId) ?? null
}

export function upsertSession(session: StudioSession): void {
  const sessions = listSessions().filter((existing) => existing.id !== session.id)
  writeJson(SESSION_INDEX, [session, ...sessions])
}

export function touchSession(sessionId: string): void {
  const session = findSession(sessionId)
  if (!session) return
  upsertSession({ ...session, lastOpenedAt: Date.now() })
}

export function deleteSession(sessionId: string): void {
  const sessions = listSessions().filter((session) => session.id !== sessionId)
  writeJson(SESSION_INDEX, sessions)
  removeKey(documentKey(sessionId))
}

/* ------------------------------------------------------------------ documents */

/**
 * Load and validate a document.
 *
 * A document that fails validation is discarded and reported, and the
 * session opens with defaults: a corrupt production must never crash the
 * studio or wedge it so a reload hits the same crash. The broken record is
 * kept under a `.corrupt` key for an operator who wants to inspect it.
 */
export function loadDocument(sessionId: string): StudioDocument | null {
  const raw = readJson<unknown>(documentKey(sessionId), null)
  if (raw === null) return null
  const result = validate(StudioDocumentSchema, raw, `production "${sessionId}"`)
  if (!result.ok) {
    reportPersistenceIssue(result.issue)
    writeJson(`${documentKey(sessionId)}.corrupt`, raw)
    removeKey(documentKey(sessionId))
    return null
  }
  const document = result.data as StudioDocument
  // Order lists may name ids that no longer exist; drop those rather than
  // letting a renderer look them up.
  const sourceIds = new Set(document.sources.map((source) => source.id))
  const sceneIds = new Set(document.scenes.map((scene) => scene.id))
  const guestIds = new Set(document.guests.map((guest) => guest.id))
  const channelIds = new Set(document.audioChannels.map((channel) => channel.id))
  return {
    ...document,
    sessionId,
    sourceOrder: document.sourceOrder.filter((id) => sourceIds.has(id)),
    sceneOrder: document.sceneOrder.filter((id) => sceneIds.has(id)),
    activeSceneId: document.activeSceneId && sceneIds.has(document.activeSceneId) ? document.activeSceneId : null,
    guestOrder: document.guestOrder.filter((id) => guestIds.has(id)),
    audioChannelOrder: document.audioChannelOrder.filter((id) => channelIds.has(id)),
  }
}

/**
 * Move legacy data-URL assets into the asset store.
 *
 * Returns the sources whose settings changed, so the caller can update the
 * live store and re-save. Sources that cannot be converted keep their data
 * URL and keep working from it.
 */
export async function migrateLegacyAssets(sources: MediaSource[]): Promise<MediaSource[]> {
  const migrated: MediaSource[] = []
  const legacy = sources.filter(
    (source) =>
      (source.settings.kind === 'image' || source.settings.kind === 'video') &&
      !source.settings.assetId &&
      Boolean(source.settings.dataUrl),
  )
  if (legacy.length === 0) return migrated
  // Loaded on demand: IndexedDB tooling has no business in the landing page.
  const { dataUrlToBlob, putAsset } = await import('./asset-store')
  for (const source of sources) {
    const settings = source.settings
    if ((settings.kind !== 'image' && settings.kind !== 'video') || settings.assetId || !settings.dataUrl) continue
    const blob = dataUrlToBlob(settings.dataUrl)
    if (!blob) continue
    try {
      const asset = await putAsset({ kind: settings.kind, name: source.name, type: blob.type, size: blob.size, blob })
      const { dataUrl: _dropped, ...rest } = settings
      void _dropped
      migrated.push({ ...source, settings: { ...rest, assetId: asset.id } })
    } catch {
      // Storage unavailable: the data URL stays and still renders.
    }
  }
  return migrated
}

export function saveDocument(document: Omit<StudioDocument, 'version' | 'savedAt'>): boolean {
  const payload: StudioDocument = {
    ...document,
    version: 1,
    savedAt: Date.now(),
    /*
     * Null out live references.
     *
     * A stream key and a peer id are both valid only for the page that created
     * them. Persisting either would restore a source or guest pointing at a
     * capture that no longer exists, so the definition is kept and the live
     * handle is dropped.
     */
    sources: document.sources.map((source) => ({ ...source, streamKey: null })),
    guests: document.guests.map((guest) => ({ ...guest, peerId: null })),
  }
  return writeJson(documentKey(document.sessionId), payload)
}

export function hasDocument(sessionId: string): boolean {
  return loadDocument(sessionId) !== null
}
