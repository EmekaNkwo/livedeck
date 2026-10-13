import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { streamRegistry } from '@/services/media/stream-registry'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useAudioStore } from '@/stores/audioStore'
import { useStudioStore } from '@/stores/studioStore'
import { createFakeStream } from '@/test/setup'
import { useMediaSources } from './useMediaSources'

/**
 * Source lifecycle, with the ownership invariant exercised through the hook.
 *
 * The scenarios here are the ones that break naive implementations: deleting a
 * duplicated source must not stop the shared capture, and deleting a source
 * must clean up its scene placements, mixer channel and stream reference
 * together.
 */

beforeEach(() => {
  useSourceStore.getState().clear()
  useSceneStore.getState().clear()
  useAudioStore.getState().clear()
  useStudioStore.getState().selectSource(null)
  streamRegistry.disposeAll()
  // The program output always needs a scene to point at.
  useSceneStore.getState().createScene('Main')
})

const setup = () => renderHook(() => useMediaSources())

describe('addSource', () => {
  it('adds a source and places it in the active scene', () => {
    const { result } = setup()

    act(() => {
      result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      })
    })

    expect(result.current.sources).toHaveLength(1)
    const sceneId = useSceneStore.getState().activeSceneId!
    expect(useSceneStore.getState().scenes[sceneId]!.items).toHaveLength(1)
  })

  it('does not place an audio-only source in the scene', () => {
    const { result } = setup()

    act(() => {
      result.current.addSource({
        name: 'Mic',
        type: 'microphone',
        settings: { kind: 'microphone', deviceId: null },
        addToScene: false,
      })
    })

    const sceneId = useSceneStore.getState().activeSceneId!
    expect(useSceneStore.getState().scenes[sceneId]!.items).toHaveLength(0)
  })

  it('registers a mixer channel for an audio-bearing source', () => {
    const { result } = setup()

    act(() => {
      result.current.addSource({
        name: 'Mic',
        type: 'microphone',
        settings: { kind: 'microphone', deviceId: null },
        addToScene: false,
      })
    })

    const channels = Object.values(useAudioStore.getState().channels)
    expect(channels).toHaveLength(1)
    expect(channels[0]?.kind).toBe('host-mic')
  })

  it('selects the new source', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })
    expect(useStudioStore.getState().selectedSourceId).toBe(id)
  })

  it('de-duplicates names', () => {
    const { result } = setup()
    act(() => {
      result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      })
      result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      })
    })
    expect(result.current.sources.map((source) => source.name)).toEqual(['Camera', 'Camera 2'])
  })
})

describe('removeSource', () => {
  it('releases the stream when it was the only user', () => {
    const { result } = setup()
    const stream = createFakeStream(['video'])
    streamRegistry.register('camera:a', stream)

    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        streamKey: 'camera:a',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })

    act(() => result.current.removeSource(id))

    expect(streamRegistry.has('camera:a')).toBe(false)
    expect(stream.getVideoTracks()[0]?.readyState).toBe('ended')
  })

  it('removes the source from every scene', () => {
    const { result } = setup()
    const second = useSceneStore.getState().createScene('Second')

    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })
    act(() => result.current.addToActiveScene(id))
    // Place it in the second scene too.
    act(() => {
      useSceneStore.getState().activateScene(second.id, { immediate: true })
      result.current.addToActiveScene(id)
    })

    act(() => result.current.removeSource(id))

    for (const scene of Object.values(useSceneStore.getState().scenes)) {
      expect(scene.items.some((item) => item.sourceId === id)).toBe(false)
    }
  })

  it('removes the mixer channel', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Mic',
        type: 'microphone',
        settings: { kind: 'microphone', deviceId: null },
        addToScene: false,
      }).id
    })
    expect(Object.keys(useAudioStore.getState().channels)).toHaveLength(1)

    act(() => result.current.removeSource(id))
    expect(Object.keys(useAudioStore.getState().channels)).toHaveLength(0)
  })

  it('clears the selection when the selected source is removed', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })
    act(() => result.current.removeSource(id))
    expect(useStudioStore.getState().selectedSourceId).toBeNull()
  })

  it('tolerates removing an unknown source', () => {
    const { result } = setup()
    expect(() => act(() => result.current.removeSource('src_ghost'))).not.toThrow()
  })
})

describe('duplicateSource', () => {
  it('shares the original capture rather than reopening the device', () => {
    const { result } = setup()
    streamRegistry.register('camera:a', createFakeStream(['video']))

    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        streamKey: 'camera:a',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })

    act(() => {
      result.current.duplicateSource(id)
    })

    // Two source definitions, two references, one capture.
    expect(result.current.sources).toHaveLength(2)
    expect(streamRegistry.refCount('camera:a')).toBe(2)
  })

  it('deleting the duplicate leaves the original’s video running', () => {
    // The bug this invariant exists to prevent.
    const { result } = setup()
    const stream = createFakeStream(['video'])
    streamRegistry.register('camera:a', stream)

    let originalId = ''
    act(() => {
      originalId = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        streamKey: 'camera:a',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })

    let cloneId = ''
    act(() => {
      cloneId = result.current.duplicateSource(originalId)!.id
    })

    act(() => result.current.removeSource(cloneId))

    expect(streamRegistry.has('camera:a')).toBe(true)
    expect(stream.getVideoTracks()[0]?.readyState).toBe('live')
    expect(result.current.sources.map((source) => source.id)).toEqual([originalId])
  })

  it('offsets the copy so it is visibly distinct', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })

    let cloneId = ''
    act(() => {
      cloneId = result.current.duplicateSource(id)!.id
    })

    const sceneId = useSceneStore.getState().activeSceneId!
    const items = useSceneStore.getState().scenes[sceneId]!.items
    const original = items.find((item) => item.sourceId === id)!
    const clone = items.find((item) => item.sourceId === cloneId)!
    expect(clone.transform.x).toBeGreaterThan(original.transform.x)
    expect(clone.layer).toBeGreaterThan(original.layer)
  })

  it('returns null for an unknown source', () => {
    const { result } = setup()
    let outcome: unknown = 'unset'
    act(() => {
      outcome = result.current.duplicateSource('src_ghost')
    })
    expect(outcome).toBeNull()
  })
})

describe('replaceStream', () => {
  it('releases the old capture when nothing else is using it', () => {
    const { result } = setup()
    const first = createFakeStream(['video'])
    const second = createFakeStream(['video'])
    streamRegistry.register('camera:a', first)

    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        streamKey: 'camera:a',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })

    streamRegistry.register('camera:b', second)
    act(() => result.current.replaceStream(id, 'camera:b'))

    expect(streamRegistry.has('camera:a')).toBe(false)
    expect(streamRegistry.has('camera:b')).toBe(true)
    expect(useSourceStore.getState().sources[id]?.streamKey).toBe('camera:b')
  })

  it('keeps the old capture alive when a sibling still references it', () => {
    const { result } = setup()
    streamRegistry.register('camera:a', createFakeStream(['video']))

    let firstId = ''
    act(() => {
      firstId = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        streamKey: 'camera:a',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })
    act(() => {
      result.current.duplicateSource(firstId)
    })

    streamRegistry.register('camera:b', createFakeStream(['video']))
    act(() => result.current.replaceStream(firstId, 'camera:b'))

    expect(streamRegistry.has('camera:a')).toBe(true)
  })
})

describe('scene membership', () => {
  it('adds to and removes from the active scene without deleting the source', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Camera',
        type: 'camera',
        settings: { kind: 'camera', deviceId: null, mirrored: false },
        addToMixer: false,
      }).id
    })

    expect(result.current.isInActiveScene(id)).toBe(true)

    act(() => result.current.removeFromActiveScene(id))
    expect(result.current.isInActiveScene(id)).toBe(false)
    // The source itself survives.
    expect(useSourceStore.getState().sources[id]).toBeDefined()

    act(() => result.current.addToActiveScene(id))
    expect(result.current.isInActiveScene(id)).toBe(true)
  })
})

describe('renameSource', () => {
  it('keeps the mixer strip label in step', () => {
    const { result } = setup()
    let id = ''
    act(() => {
      id = result.current.addSource({
        name: 'Mic',
        type: 'microphone',
        settings: { kind: 'microphone', deviceId: null },
        addToScene: false,
      }).id
    })

    act(() => result.current.renameSource(id, 'Host Microphone'))

    expect(useSourceStore.getState().sources[id]?.name).toBe('Host Microphone')
    expect(useAudioStore.getState().channels[id]?.label).toBe('Host Microphone')
  })
})
