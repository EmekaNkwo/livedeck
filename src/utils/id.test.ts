import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGuestId,
  createId,
  createPeerId,
  createRecordingId,
  createRoomCode,
  createSceneId,
  createSessionId,
  createSourceId,
  shortId,
  uniqueName,
} from './id'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shortId', () => {
  it('is lowercase alphanumeric with the requested length', () => {
    expect(shortId()).toMatch(/^[a-z0-9]{6}$/)
    expect(shortId(12)).toMatch(/^[a-z0-9]{12}$/)
    expect(shortId(0)).toBe('')
  })

  it('maps random bytes onto the alphabet', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.set([0, 1, 25, 26, 35, 36])
      return array
    })
    // 36 wraps back to the start of the 36-character alphabet.
    expect(shortId(6)).toBe('abz09a')
  })

  it('falls back to Math.random without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    // floor(0.5 * 256) = 128; 128 % 36 = 20 → 'u'.
    expect(shortId(3)).toBe('uuu')
    expect(random).toHaveBeenCalledTimes(3)
  })
})

describe('prefixed ids', () => {
  it.each([
    ['src', createSourceId],
    ['scn', createSceneId],
    ['gst', createGuestId],
    ['peer', createPeerId],
    ['rec', createRecordingId],
  ] as const)('%s ids carry their prefix', (prefix, make) => {
    expect(make()).toMatch(new RegExp(`^${prefix}_[a-z0-9]{8}$`))
  })

  it('createId uses any prefix', () => {
    expect(createId('x')).toMatch(/^x_[a-z0-9]{8}$/)
  })

  it('session ids are six characters with no prefix', () => {
    expect(createSessionId()).toMatch(/^[a-z0-9]{6}$/)
  })

  it('does not repeat across many draws', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createSourceId()))
    expect(ids.size).toBe(500)
  })
})

describe('createRoomCode', () => {
  it('has the abc-defg-hij shape using only unambiguous letters', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = createRoomCode()
      expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
      expect(code).not.toMatch(/[lo0-9]/)
    }
  })

  it('maps bytes onto the 24-letter alphabet in order', () => {
    vi.stubGlobal('crypto', undefined)
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((byte) => (byte + 0.01) / 256)
    let call = 0
    vi.spyOn(Math, 'random').mockImplementation(() => values[call++] ?? 0)
    expect(createRoomCode()).toBe('abc-defg-hij')
  })
})

describe('uniqueName', () => {
  it('keeps a name that is not taken', () => {
    expect(uniqueName('Camera', [])).toBe('Camera')
    expect(uniqueName('Camera', ['Mic'])).toBe('Camera')
  })

  it('appends the first free counter', () => {
    expect(uniqueName('Camera', ['Camera'])).toBe('Camera 2')
    expect(uniqueName('Camera', ['Camera', 'Camera 2', 'Camera 3'])).toBe('Camera 4')
  })

  it('replaces an existing numeric suffix instead of stacking another', () => {
    expect(uniqueName('Camera 2', ['Camera', 'Camera 2'])).toBe('Camera 3')
  })
})
