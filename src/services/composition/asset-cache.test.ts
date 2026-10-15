import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeStream } from '@/test/setup'
import type { StoredAsset } from '@/services/persistence/asset-store'
import { assetCache } from './asset-cache'

/**
 * The decoded-asset cache. jsdom never fetches or decodes media, so "decoded"
 * is simulated by dispatching the element's own load/error events, and the
 * IndexedDB asset store and object URLs are replaced with doubles.
 */

const { getAsset } = vi.hoisted(() => ({
  getAsset: vi.fn<(id: string) => Promise<StoredAsset | null>>(),
}))
vi.mock('@/services/persistence/asset-store', () => ({ getAsset }))

const IMAGE_URL = 'data:image/png;base64,AAAA'
const VIDEO_URL = 'data:video/mp4;base64,BBBB'

const createObjectURL = vi.fn<(blob: Blob) => string>()
const revokeObjectURL = vi.fn<(url: string) => void>()

function storedAsset(id: string): StoredAsset {
  return { id, kind: 'image', name: 'a.png', type: 'image/png', size: 4, createdAt: 0, blob: new Blob(['png']) }
}

beforeEach(() => {
  let serial = 0
  createObjectURL.mockReset().mockImplementation(() => `blob:fake/${(serial += 1)}`)
  revokeObjectURL.mockReset()
  getAsset.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
})

afterEach(() => {
  assetCache.releaseAll()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('assetCache: images from a data URL', () => {
  it('starts decoding, then reports ready and notifies listeners on load', () => {
    const listener = vi.fn()
    const unsubscribe = assetCache.onReady(listener)

    const entry = assetCache.load('img-1', 'image', { dataUrl: IMAGE_URL })
    expect(entry.kind).toBe('image')
    expect(entry.element.getAttribute('src')).toBe(IMAGE_URL)
    expect((entry.element as HTMLImageElement).decoding).toBe('async')
    expect(entry.ready).toBe(false)
    expect(assetCache.get('img-1')).toBe(entry)

    entry.element.dispatchEvent(new Event('load'))
    expect(entry.ready).toBe(true)
    expect(entry.error).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    const other = assetCache.load('img-2', 'image', { dataUrl: IMAGE_URL })
    other.element.dispatchEvent(new Event('load'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('records a decode error', () => {
    const entry = assetCache.load('img-1', 'image', { dataUrl: IMAGE_URL })
    entry.element.dispatchEvent(new Event('error'))
    expect(entry.error).toBe('The image could not be decoded.')
    expect(entry.ready).toBe(false)
  })

  it('is idempotent for the same reference and re-decodes for a new one', () => {
    const first = assetCache.load('img-1', 'image', { dataUrl: IMAGE_URL })
    expect(assetCache.load('img-1', 'image', { dataUrl: IMAGE_URL })).toBe(first)

    const second = assetCache.load('img-1', 'image', { dataUrl: 'data:image/png;base64,CCCC' })
    expect(second).not.toBe(first)
    expect(first.element.hasAttribute('src')).toBe(false)
    expect(first.element.onload).toBeNull()
    expect(assetCache.get('img-1')).toBe(second)
  })

  it('reports a source with no media at all', () => {
    const entry = assetCache.load('img-1', 'image', {})
    expect(entry.error).toBe('This source has no media file.')
    expect(entry.element.hasAttribute('src')).toBe(false)
    expect(getAsset).not.toHaveBeenCalled()
  })
})

describe('assetCache: videos', () => {
  it('configures a muted, inline, autoplaying element and becomes ready on loadeddata', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const listener = vi.fn()
    assetCache.onReady(listener)

    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL }, false)
    const video = entry.element as HTMLVideoElement
    expect(entry.kind).toBe('video')
    expect([video.muted, video.defaultMuted, video.loop, video.playsInline, video.preload]).toEqual([
      true,
      true,
      false,
      true,
      'auto',
    ])
    expect(video.getAttribute('src')).toBe(VIDEO_URL)
    expect(play).toHaveBeenCalledTimes(1)

    video.dispatchEvent(new Event('loadeddata'))
    expect(entry.ready).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('loops by default', () => {
    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    expect((entry.element as HTMLVideoElement).loop).toBe(true)
  })

  it('records a decode error', () => {
    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    entry.element.dispatchEvent(new Event('error'))
    expect(entry.error).toBe('The video could not be decoded.')
  })

  it('explains blocked autoplay', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    await vi.waitFor(() => expect(entry.error).toMatch(/Playback was blocked/))
  })

  it('pauses, unloads and stops captured audio on release', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const unload = vi.spyOn(HTMLMediaElement.prototype, 'load')
    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    const audio = createFakeStream(['audio'])
    Object.defineProperty(entry.element, 'captureStream', { value: () => audio })
    expect(assetCache.captureAudio('vid-1')).toBe(audio)

    assetCache.release('vid-1')
    expect(pause).toHaveBeenCalledTimes(1)
    expect(unload).toHaveBeenCalledTimes(1)
    expect(entry.element.hasAttribute('src')).toBe(false)
    expect(audio.getTracks()[0]!.readyState).toBe('ended')
    expect(assetCache.get('vid-1')).toBeNull()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    // Releasing twice, or something never loaded, is harmless.
    expect(() => assetCache.release('vid-1')).not.toThrow()
  })
})

describe('assetCache.captureAudio', () => {
  it('captures once and reuses the stream', () => {
    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    const capture = vi.fn(() => createFakeStream(['audio']))
    Object.defineProperty(entry.element, 'captureStream', { value: capture })
    const first = assetCache.captureAudio('vid-1')
    expect(assetCache.captureAudio('vid-1')).toBe(first)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('falls back to mozCaptureStream, called on the element', () => {
    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    const stream = createFakeStream(['audio'])
    const capture = vi.fn(() => stream)
    Object.defineProperty(entry.element, 'mozCaptureStream', { value: capture })
    expect(assetCache.captureAudio('vid-1')).toBe(stream)
    expect(capture.mock.contexts[0]).toBe(entry.element)
  })

  it('returns null when capture is impossible or fails', () => {
    expect(assetCache.captureAudio('missing')).toBeNull()
    assetCache.load('img-1', 'image', { dataUrl: IMAGE_URL })
    expect(assetCache.captureAudio('img-1')).toBeNull()

    const entry = assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    expect(assetCache.captureAudio('vid-1')).toBeNull()

    Object.defineProperty(entry.element, 'captureStream', {
      value: () => {
        throw new DOMException('no', 'NotSupportedError')
      },
    })
    expect(assetCache.captureAudio('vid-1')).toBeNull()
  })
})

describe('assetCache: assets from the store', () => {
  it('reads the blob, decodes it through an object URL, and revokes it on release', async () => {
    getAsset.mockResolvedValue(storedAsset('a1'))
    const entry = assetCache.load('img-1', 'image', { assetId: 'a1', dataUrl: IMAGE_URL })
    expect(entry.key).toBe('asset:a1')
    expect(entry.element.hasAttribute('src')).toBe(false)

    await vi.waitFor(() => expect(entry.objectUrl).toBe('blob:fake/1'))
    expect(getAsset).toHaveBeenCalledWith('a1')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(entry.element.getAttribute('src')).toBe('blob:fake/1')

    assetCache.release('img-1')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake/1')
    expect(entry.objectUrl).toBeNull()
  })

  it('is idempotent by asset id, even when the data URL changes', async () => {
    getAsset.mockResolvedValue(storedAsset('a1'))
    const first = assetCache.load('img-1', 'image', { assetId: 'a1' })
    expect(assetCache.load('img-1', 'image', { assetId: 'a1', dataUrl: IMAGE_URL })).toBe(first)
    await vi.waitFor(() => expect(first.objectUrl).not.toBeNull())
    expect(getAsset).toHaveBeenCalledTimes(1)
  })

  it('reports an asset missing from storage', async () => {
    getAsset.mockResolvedValue(null)
    const entry = assetCache.load('img-1', 'image', { assetId: 'gone' })
    await vi.waitFor(() => expect(entry.error).toBe('The media file is missing from this browser’s storage.'))
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('reports a storage read failure', async () => {
    getAsset.mockRejectedValue(new Error('idb'))
    const entry = assetCache.load('vid-1', 'video', { assetId: 'a1' })
    await vi.waitFor(() => expect(entry.error).toBe('The media file could not be read.'))
  })

  it('drops a late result for an entry that was released or replaced meanwhile', async () => {
    let resolveRead: (asset: StoredAsset | null) => void = () => {}
    getAsset.mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)))
    const stale = assetCache.load('img-1', 'image', { assetId: 'a1' })
    await vi.waitFor(() => expect(getAsset).toHaveBeenCalledTimes(1))
    assetCache.release('img-1')
    resolveRead(storedAsset('a1'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(stale.element.hasAttribute('src')).toBe(false)

    let rejectRead: (reason: Error) => void = () => {}
    getAsset.mockImplementationOnce(() => new Promise((_, reject) => (rejectRead = reject)))
    const replaced = assetCache.load('img-2', 'image', { assetId: 'a2' })
    await vi.waitFor(() => expect(getAsset).toHaveBeenCalledTimes(2))
    const current = assetCache.load('img-2', 'image', { dataUrl: IMAGE_URL })
    rejectRead(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replaced.error).toBeNull()
    expect(current.error).toBeNull()
  })

  it('releaseAll tears down every entry', async () => {
    getAsset.mockResolvedValue(storedAsset('a1'))
    const fromStore = assetCache.load('img-1', 'image', { assetId: 'a1' })
    assetCache.load('vid-1', 'video', { dataUrl: VIDEO_URL })
    await vi.waitFor(() => expect(fromStore.objectUrl).not.toBeNull())

    assetCache.releaseAll()
    expect(assetCache.get('img-1')).toBeNull()
    expect(assetCache.get('vid-1')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })
})
