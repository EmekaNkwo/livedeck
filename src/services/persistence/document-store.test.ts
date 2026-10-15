import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDocument, saveDocument, listSessions, upsertSession } from './document-store'
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

  it('reports a failed save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(saveDocument(document)).toBe(false)
  })
})
