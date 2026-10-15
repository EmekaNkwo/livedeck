import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNamespace, createSafeStorage, isStorageAvailable, readJson, removeKey, storageKey, writeJson } from './local-store'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('local store', () => {
  it('namespaces keys and round-trips JSON', () => {
    expect(writeJson('thing', { a: 1 })).toBe(true)
    expect(localStorage.getItem(storageKey('thing'))).toBe('{"a":1}')
    expect(readJson('thing', null)).toEqual({ a: 1 })
    removeKey('thing')
    expect(readJson('thing', 'fallback')).toBe('fallback')
  })

  it('returns the fallback for corrupt JSON instead of throwing', () => {
    localStorage.setItem(storageKey('bad'), '{not json')
    expect(readJson('bad', 42)).toBe(42)
  })

  it('reports a failed write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(writeJson('x', 1)).toBe(false)
    expect(isStorageAvailable()).toBe(false)
  })

  it('clears only its own namespace', () => {
    writeJson('mine', 1)
    localStorage.setItem('theirs', '1')
    clearNamespace()
    expect(readJson('mine', null)).toBeNull()
    expect(localStorage.getItem('theirs')).toBe('1')
  })

  it('degrades to memory when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    const storage = createSafeStorage()
    storage.setItem('k', 'v')
    expect(storage.getItem('k')).toBe('v')
    expect(storage.length).toBe(1)
    expect(storage.key(0)).toBe('k')
    storage.removeItem('k')
    expect(storage.getItem('k')).toBeNull()
    storage.setItem('a', '1')
    storage.clear()
    expect(storage.length).toBe(0)
  })
})
