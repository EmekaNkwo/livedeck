import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteSession,
  findSession,
  hasDocument,
  loadDocument,
  migrateLegacyAssets,
  saveDocument,
  listSessions,
  touchSession,
  upsertSession,
} from './document-store'
import * as assetStore from './asset-store'
import type { MediaSource } from '@/types/source'
import { onPersistenceIssue, resetPersistenceIssues } from './issues'
import { readJson, storageKey } from './local-store'

const document = {
  sessionId: 'room-1',
  sources: [],
  sourceOrder: [],
  scenes: [
    { id: 'sc1', name: 'Main', order: 0, transition: { type: 'cut' as const, durationMs: 0 }, items: [], createdAt: 1 },
  ],
  sceneOrder: ['sc1', 'ghost'],
  activeSceneId: 'ghost',
  guests: [],
  guestOrder: [],
  audioChannels: [],
  audioChannelOrder: [],
}

beforeEach(() => {
  localStorage.clear()
  resetPersistenceIssues()
})
afterEach(() => vi.restoreAllMocks())

describe('document store', () => {
  it('round-trips a document and prunes dangling ids', () => {
    expect(saveDocument(document)).toBe(true)
    const loaded = loadDocument('room-1')
    expect(loaded?.sceneOrder).toEqual(['sc1'])
    expect(loaded?.activeSceneId).toBeNull()
  })

  it('discards a corrupt document, keeps a copy, and reports it', () => {
    localStorage.setItem(storageKey('doc:room-1'), JSON.stringify({ version: 1, scenes: 'nope' }))
    const issues: string[] = []
    onPersistenceIssue((issue) => issues.push(issue.record))
    expect(loadDocument('room-1')).toBeNull()
    expect(issues).toEqual(['production "room-1"'])
    expect(readJson('doc:room-1.corrupt', null)).toMatchObject({ version: 1 })
    expect(readJson('doc:room-1', null)).toBeNull()
    // A second load opens clean rather than hitting the same corruption.
    expect(loadDocument('room-1')).toBeNull()
  })

  it('replays issues raised before anyone subscribed', () => {
    localStorage.setItem(storageKey('doc:room-2'), 'not json at all')
    localStorage.setItem(storageKey('doc:room-3'), JSON.stringify({ version: 1 }))
    expect(loadDocument('room-2')).toBeNull()
    expect(loadDocument('room-3')).toBeNull()
    const issues: string[] = []
    onPersistenceIssue((issue) => issues.push(issue.record))
    expect(issues).toEqual(['production "room-3"'])
  })

  it('drops malformed sessions from the index', () => {
    upsertSession({ id: 'a', name: 'A', mode: 'peer', createdAt: 1, lastOpenedAt: 2 })
    const key = storageKey('sessions')
    const list = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]
    localStorage.setItem(key, JSON.stringify([...list, { id: 42 }, 'junk']))
    const issues: string[] = []
    onPersistenceIssue((issue) => issues.push(issue.message))
    expect(listSessions().map((session) => session.id)).toEqual(['a'])
    expect(issues[0]).toContain('2 malformed entries')
  })

  it('manages the session index', () => {
    upsertSession({ id: 'a', name: 'A', mode: 'peer', createdAt: 1, lastOpenedAt: 1 })
    upsertSession({ id: 'b', name: 'B', mode: 'local', createdAt: 2, lastOpenedAt: 5 })
    expect(listSessions().map((s) => s.id)).toEqual(['b', 'a'])
    touchSession('a')
    expect(listSessions()[0]?.id).toBe('a')
    expect(findSession('b')?.name).toBe('B')
    expect(findSession('zzz')).toBeNull()
    saveDocument({ ...document, sessionId: 'a' })
    expect(hasDocument('a')).toBe(true)
    deleteSession('a')
    expect(hasDocument('a')).toBe(false)
    expect(findSession('a')).toBeNull()
  })

  it('migrates data-URL assets into the asset store and leaves others alone', async () => {
    vi.spyOn(assetStore, 'putAsset').mockImplementation(async (asset) => ({ ...asset, id: 'asset_new', createdAt: 1 }))
    const legacy: MediaSource = {
      id: 'img',
      name: 'Logo',
      type: 'image',
      visible: true,
      locked: false,
      muted: false,
      layer: 0,
      settings: { kind: 'image', dataUrl: 'data:image/png;base64,aGk=', fit: 'contain' },
      streamKey: null,
      volume: 1,
      createdAt: 1,
    }
    const modern: MediaSource = { ...legacy, id: 'img2', settings: { kind: 'image', assetId: 'asset_old', fit: 'cover' } }
    const text: MediaSource = { ...legacy, id: 't', type: 'text', settings: { kind: 'text', text: 'x', style: { fontSize: 1, fontFamily: 'a', color: '#fff', backgroundColor: null, align: 'left', bold: false } } }
    const migrated = await migrateLegacyAssets([legacy, modern, text])
    expect(migrated).toHaveLength(1)
    expect(migrated[0]?.settings).toEqual({ kind: 'image', assetId: 'asset_new', fit: 'contain' })
  })

  it('keeps the data URL when the asset store is unavailable', async () => {
    vi.spyOn(assetStore, 'putAsset').mockRejectedValue(new Error('no idb'))
    const legacy = {
      id: 'v',
      name: 'Clip',
      type: 'video',
      visible: true,
      locked: false,
      muted: false,
      layer: 0,
      settings: { kind: 'video', dataUrl: 'data:video/webm;base64,aGk=', loop: true, fit: 'contain' },
      streamKey: null,
      volume: 1,
      createdAt: 1,
    } as MediaSource
    expect(await migrateLegacyAssets([legacy])).toEqual([])
  })

  it('reports a failed save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(saveDocument(document)).toBe(false)
  })
})
