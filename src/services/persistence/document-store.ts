import type { Guest } from '@/types/peer'
import type { Scene } from '@/types/scene'
import type { MediaSource } from '@/types/source'
import type { AudioChannelConfig } from '@/types/audio'
import type { StudioSession } from '@/types/session'
import { readJson, removeKey, writeJson } from './local-store'

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
  const sessions = readJson<StudioSession[]>(SESSION_INDEX, [])
  if (!Array.isArray(sessions)) return []
  return sessions
    .filter((session): session is StudioSession => Boolean(session?.id))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
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

export function loadDocument(sessionId: string): StudioDocument | null {
  const raw = readJson<StudioDocument | null>(documentKey(sessionId), null)
  if (!raw || raw.version !== 1) return null
  // Defensive normalization: a hand-edited or partially-written document must
  // not be able to crash the studio on open.
  return {
    version: 1,
    sessionId,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    sourceOrder: Array.isArray(raw.sourceOrder) ? raw.sourceOrder : [],
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
    sceneOrder: Array.isArray(raw.sceneOrder) ? raw.sceneOrder : [],
    activeSceneId: typeof raw.activeSceneId === 'string' ? raw.activeSceneId : null,
    guests: Array.isArray(raw.guests) ? raw.guests : [],
    guestOrder: Array.isArray(raw.guestOrder) ? raw.guestOrder : [],
    audioChannels: Array.isArray(raw.audioChannels) ? raw.audioChannels : [],
    audioChannelOrder: Array.isArray(raw.audioChannelOrder) ? raw.audioChannelOrder : [],
  }
}

export function saveDocument(document: Omit<StudioDocument, 'version' | 'savedAt'>): boolean {
  const payload: StudioDocument = {
    ...document,
    version: 1,
    savedAt: Date.now(),
    // Null out live references and drop simulated sources: a demo guest's
    // synthetic feed cannot be recreated from a saved definition, and
    // restoring a dead reference would show a broken source.
    sources: document.sources
      .filter((source) => !source.simulated)
      .map((source) => ({ ...source, streamKey: null })),
    guests: document.guests
      .filter((guest) => !guest.simulated)
      .map((guest) => ({ ...guest, peerId: null })),
  }
  const removedSourceIds = new Set(
    document.sources.filter((source) => source.simulated).map((source) => source.id),
  )
  if (removedSourceIds.size > 0) {
    payload.sourceOrder = payload.sourceOrder.filter((id) => !removedSourceIds.has(id))
    payload.scenes = payload.scenes.map((scene) => ({
      ...scene,
      items: scene.items.filter((item) => !removedSourceIds.has(item.sourceId)),
    }))
    payload.audioChannels = payload.audioChannels.filter(
      (channel) => !removedSourceIds.has(channel.sourceId),
    )
    payload.audioChannelOrder = payload.audioChannelOrder.filter(
      (id) => !removedSourceIds.has(id),
    )
  }
  return writeJson(documentKey(document.sessionId), payload)
}

export function hasDocument(sessionId: string): boolean {
  return loadDocument(sessionId) !== null
}
