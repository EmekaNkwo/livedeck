import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamRegistry } from './stream-registry'
import { createFakeStream } from '@/test/setup'

/**
 * The ownership invariant, tested directly.
 *
 * This is the single most load-bearing piece of resource management in the
 * project: it is what stops "delete the duplicated camera source" from killing
 * the original's video, and what stops an unmounted preview from stopping a
 * capture the compositor is still drawing.
 */

let registry: StreamRegistry

beforeEach(() => {
  registry = new StreamRegistry()
})

describe('register', () => {
  it('registers a stream with one reference', () => {
    const stream = createFakeStream(['video'])
    const entry = registry.register('camera:a', stream)
    expect(entry.refCount).toBe(1)
    expect(registry.getStream('camera:a')).toBe(stream)
  })

  it('creates a hidden video element for video streams only', () => {
    registry.register('camera:a', createFakeStream(['video']))
    registry.register('mic:a', createFakeStream(['audio']))
    expect(registry.getElement('camera:a')).not.toBeNull()
    expect(registry.getElement('mic:a')).toBeNull()
  })

  it('increments the count when the same stream is registered again', () => {
    const stream = createFakeStream(['video'])
    registry.register('camera:a', stream)
    registry.register('camera:a', stream)
    expect(registry.refCount('camera:a')).toBe(2)
  })

  it('replaces and stops the old stream when a key is reused', () => {
    // This is the device-switch path.
    const first = createFakeStream(['video'])
    const second = createFakeStream(['video'])
    registry.register('camera:a', first)
    registry.register('camera:a', second)

    expect(first.getTracks()[0]?.readyState).toBe('ended')
    expect(registry.getStream('camera:a')).toBe(second)
    expect(registry.refCount('camera:a')).toBe(1)
  })
})

describe('retain and release', () => {
  it('keeps the stream alive while any reference remains', () => {
    const stream = createFakeStream(['video'])
    registry.register('camera:a', stream)
    registry.retain('camera:a')
    expect(registry.refCount('camera:a')).toBe(2)

    // One consumer goes away — the capture must survive for the other.
    registry.release('camera:a')
    expect(registry.has('camera:a')).toBe(true)
    expect(stream.getTracks()[0]?.readyState).toBe('live')
  })

  it('stops the tracks when the last reference is released', () => {
    const stream = createFakeStream(['video', 'audio'])
    registry.register('camera:a', stream)
    registry.release('camera:a')

    expect(registry.has('camera:a')).toBe(false)
    for (const track of stream.getTracks()) {
      expect(track.readyState).toBe('ended')
    }
  })

  it('tolerates releasing an unknown key, so cleanup is idempotent', () => {
    expect(() => registry.release('nope')).not.toThrow()
    registry.register('camera:a', createFakeStream(['video']))
    registry.release('camera:a')
    expect(() => registry.release('camera:a')).not.toThrow()
  })

  it('returns null when retaining an unknown key', () => {
    expect(registry.retain('nope')).toBeNull()
  })
})

describe('ended tracks', () => {
  it('disposes the entry when the browser ends a track', () => {
    // This is the "user pressed the browser's Stop sharing button" path.
    const stream = createFakeStream(['video'])
    registry.register('screen:primary', stream)

    const listener = vi.fn()
    registry.onStreamEnded(listener)

    stream.getVideoTracks()[0]?.dispatchEvent(new Event('ended'))

    expect(registry.has('screen:primary')).toBe(false)
    expect(listener).toHaveBeenCalledWith('screen:primary', 'ended')
  })

  it('disposes even when several references are outstanding', () => {
    // A track that genuinely ended cannot be kept alive by refcounts.
    const stream = createFakeStream(['video'])
    registry.register('screen:primary', stream)
    registry.retain('screen:primary')
    registry.retain('screen:primary')

    stream.getVideoTracks()[0]?.dispatchEvent(new Event('ended'))
    expect(registry.has('screen:primary')).toBe(false)
  })

  it('reports the reason to listeners', () => {
    const listener = vi.fn()
    registry.onStreamEnded(listener)
    registry.register('camera:a', createFakeStream(['video']))
    registry.release('camera:a')
    expect(listener).toHaveBeenCalledWith('camera:a', 'released')
  })

  it('unsubscribes listeners', () => {
    const listener = vi.fn()
    const unsubscribe = registry.onStreamEnded(listener)
    unsubscribe()
    registry.register('camera:a', createFakeStream(['video']))
    registry.release('camera:a')
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps tearing down when a listener throws', () => {
    const bad = vi.fn(() => {
      throw new Error('listener exploded')
    })
    const good = vi.fn()
    registry.onStreamEnded(bad)
    registry.onStreamEnded(good)

    registry.register('camera:a', createFakeStream(['video']))
    expect(() => registry.release('camera:a')).not.toThrow()
    expect(good).toHaveBeenCalled()
  })
})

describe('disposeAll', () => {
  it('stops every stream', () => {
    const a = createFakeStream(['video'])
    const b = createFakeStream(['audio'])
    registry.register('camera:a', a)
    registry.register('mic:a', b)

    registry.disposeAll()

    expect(registry.keys()).toHaveLength(0)
    expect(a.getTracks()[0]?.readyState).toBe('ended')
    expect(b.getTracks()[0]?.readyState).toBe('ended')
  })

  it('ignores a track that is already stopped', () => {
    const stream = createFakeStream(['video'])
    registry.register('camera:a', stream)
    stream.getTracks()[0]?.stop()
    expect(() => registry.disposeAll()).not.toThrow()
  })
})

describe('snapshotTracks', () => {
  it('reports observable track facts', () => {
    const stream = createFakeStream(['video', 'audio'])
    registry.register('camera:a', stream)

    const tracks = registry.snapshotTracks('camera:a')
    expect(tracks).toHaveLength(2)
    const video = tracks.find((track) => track.kind === 'video')!
    expect(video.readyState).toBe('live')
    expect(video.enabled).toBe(true)
    expect(video.settings.width).toBe(1280)
  })

  it('reflects a disabled track', () => {
    const stream = createFakeStream(['audio'])
    registry.register('mic:a', stream)
    const track = stream.getAudioTracks()[0]!
    track.enabled = false

    expect(registry.snapshotTracks('mic:a')[0]?.enabled).toBe(false)
  })

  it('returns nothing for an unknown key', () => {
    expect(registry.snapshotTracks('nope')).toEqual([])
  })
})
