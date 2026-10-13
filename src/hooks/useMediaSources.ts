import { useCallback } from 'react'
import type { MediaSource, SourceSettings, SourceType } from '@/types/source'
import type { AudioChannelKind } from '@/types/audio'
import { isAudioSource } from '@/types/source'
import { ASPECT_RATIOS } from '@/types/scene'
import { streamRegistry } from '@/services/media/stream-registry'
import { assetCache } from '@/services/composition/asset-cache'
import { intrinsicSize } from '@/services/composition/frame-providers'
import { audioMixer } from '@/services/audio/audio-mixer'
import { createSceneItem } from '@/services/sources/source-factory'
import type { CreateSourceInput } from '@/stores/sourceStore'
import { useSourceStore, sourcesUsingStream } from '@/stores/sourceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useAudioStore } from '@/stores/audioStore'
import { useStudioStore } from '@/stores/studioStore'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Source lifecycle: creation, placement into scenes, and — most importantly —
 * correct teardown.
 *
 * THE OWNERSHIP INVARIANT
 * -----------------------
 * **Each source definition that holds a `streamKey` owns exactly one reference
 * in the StreamRegistry.**
 *
 * - acquiring a capture registers the key (reference count 1) on behalf of the
 *   source that is about to be created,
 * - duplicating a source retains the key (+1), because the clone shares the
 *   capture rather than opening the device twice,
 * - removing a source releases the key (-1),
 * - the capture stops only when the count hits zero.
 *
 * Preview components and the compositor *read* from the registry without
 * retaining, which they can do safely because a source reference outlives any
 * view of it. This is what makes "delete the duplicated camera" not black out
 * the original, and "close the inspector" not stop the capture.
 */

export type AddSourceOptions = CreateSourceInput & {
  /** Place the new source into the active scene. Defaults to true. */
  addToScene?: boolean
  /** Register an audio channel for audio-bearing sources. Defaults to true. */
  addToMixer?: boolean
  mixerKind?: AudioChannelKind
  mirrored?: boolean
}

export type UseMediaSources = {
  sources: MediaSource[]
  addSource: (options: AddSourceOptions) => MediaSource
  removeSource: (sourceId: string) => void
  renameSource: (sourceId: string, name: string) => void
  duplicateSource: (sourceId: string) => MediaSource | null
  updateSettings: (sourceId: string, settings: SourceSettings) => void
  addToActiveScene: (sourceId: string) => void
  removeFromActiveScene: (sourceId: string) => void
  isInActiveScene: (sourceId: string) => boolean
  /** Swap a source onto a different capture, releasing the old one. */
  replaceStream: (sourceId: string, streamKey: string | null) => void
}

export function useMediaSources(): UseMediaSources {
  const sources = useSourceStore((state) => state.order)
  const sourceMap = useSourceStore((state) => state.sources)
  const addSourceToStore = useSourceStore((state) => state.addSource)
  const removeSourceFromStore = useSourceStore((state) => state.removeSource)
  const renameInStore = useSourceStore((state) => state.renameSource)
  const duplicateInStore = useSourceStore((state) => state.duplicateSource)
  const updateSettingsInStore = useSourceStore((state) => state.updateSettings)
  const setStreamKey = useSourceStore((state) => state.setStreamKey)

  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const addItem = useSceneStore((state) => state.addItem)
  const removeItem = useSceneStore((state) => state.removeItem)
  const removeSourceEverywhere = useSceneStore((state) => state.removeSourceEverywhere)

  const upsertChannel = useAudioStore((state) => state.upsertChannel)
  const removeChannelConfig = useAudioStore((state) => state.removeChannel)

  const selectSource = useStudioStore((state) => state.selectSource)
  const selectedSourceId = useStudioStore((state) => state.selectedSourceId)

  const aspectRatio = useSettingsStore((state) => state.settings.output.aspectRatio)

  /** Place a source into a scene with a sensible default transform. */
  const placeInScene = useCallback(
    (source: MediaSource, sceneId: string, mirrored: boolean) => {
      const scene = useSceneStore.getState().scenes[sceneId]
      if (!scene) return
      const item = createSceneItem({
        sourceId: source.id,
        type: source.type,
        mirrored,
        context: {
          canvasAspect: ASPECT_RATIOS[aspectRatio],
          intrinsic: intrinsicSize(source),
          existingCount: scene.items.length,
          existingLayers: scene.items.map((existing) => existing.layer),
        },
      })
      addItem(sceneId, item)
    },
    [addItem, aspectRatio],
  )

  const addSource = useCallback(
    (options: AddSourceOptions): MediaSource => {
      const source = addSourceToStore(options)

      if ((options.addToScene ?? true) && activeSceneId) {
        placeInScene(source, activeSceneId, options.mirrored ?? false)
      }

      // Register a mixer channel for anything that carries audio. The actual
      // AudioNode graph is built by useAudioMixer once it sees the config, so
      // this hook stays free of Web Audio details.
      if ((options.addToMixer ?? true) && isAudioSource(source.type)) {
        upsertChannel({
          id: source.id,
          sourceId: source.id,
          kind: options.mixerKind ?? inferChannelKind(source.type),
          label: source.name,
          volume: 1,
          gainDb: 0,
          mutedInMix: source.muted,
          monitoring: false,
        })
      }

      selectSource(source.id)
      return source
    },
    [activeSceneId, addSourceToStore, placeInScene, selectSource, upsertChannel],
  )

  /**
   * Remove a source and release everything it owns.
   *
   * Order matters: the stream reference is released *after* the definition is
   * gone from the store, so the remaining-users count is accurate.
   */
  const removeSource = useCallback(
    (sourceId: string) => {
      const source = useSourceStore.getState().sources[sourceId]
      if (!source) return
      const streamKey = source.streamKey

      removeSourceEverywhere(sourceId)
      removeSourceFromStore(sourceId)

      removeChannelConfig(sourceId)
      audioMixer.removeChannel(sourceId)
      assetCache.release(sourceId)

      if (selectedSourceId === sourceId) selectSource(null)

      if (streamKey) {
        // Release this source's single reference. Any sibling source sharing
        // the key still holds its own, so the capture survives for them.
        streamRegistry.release(streamKey)
      }
    },
    [
      removeChannelConfig,
      removeSourceEverywhere,
      removeSourceFromStore,
      selectSource,
      selectedSourceId,
    ],
  )

  /**
   * Duplicate a source. The clone shares the original's capture, so it takes
   * an extra reference rather than opening the device a second time.
   */
  const duplicateSource = useCallback(
    (sourceId: string): MediaSource | null => {
      const original = useSourceStore.getState().sources[sourceId]
      if (!original) return null

      const clone = duplicateInStore(sourceId)
      if (!clone) return null

      if (clone.streamKey) streamRegistry.retain(clone.streamKey)

      if (activeSceneId) {
        const item = useSceneStore
          .getState()
          .scenes[activeSceneId]?.items.find((candidate) => candidate.sourceId === sourceId)
        if (item) {
          // Offset the copy so it is visibly distinct from the original.
          const offset = 0.04
          addItem(activeSceneId, {
            ...item,
            sourceId: clone.id,
            transform: {
              ...item.transform,
              x: item.transform.x + offset,
              y: item.transform.y + offset,
            },
            layer: item.layer + 1,
          })
        } else {
          placeInScene(clone, activeSceneId, false)
        }
      }

      if (isAudioSource(clone.type)) {
        upsertChannel({
          id: clone.id,
          sourceId: clone.id,
          kind: inferChannelKind(clone.type),
          label: clone.name,
          volume: 1,
          gainDb: 0,
          mutedInMix: clone.muted,
          monitoring: false,
        })
      }

      selectSource(clone.id)
      return clone
    },
    [activeSceneId, addItem, duplicateInStore, placeInScene, selectSource, upsertChannel],
  )

  const replaceStream = useCallback(
    (sourceId: string, streamKey: string | null) => {
      const source = useSourceStore.getState().sources[sourceId]
      if (!source) return
      const previous = source.streamKey
      if (previous === streamKey) return

      setStreamKey(sourceId, streamKey)

      // Release the old capture only if no other source still points at it.
      if (previous && sourcesUsingStream(useSourceStore.getState(), previous).length === 0) {
        streamRegistry.release(previous)
      }
    },
    [setStreamKey],
  )

  const addToActiveScene = useCallback(
    (sourceId: string) => {
      const source = useSourceStore.getState().sources[sourceId]
      if (!source || !activeSceneId) return
      placeInScene(source, activeSceneId, false)
    },
    [activeSceneId, placeInScene],
  )

  const removeFromActiveScene = useCallback(
    (sourceId: string) => {
      if (!activeSceneId) return
      removeItem(activeSceneId, sourceId)
    },
    [activeSceneId, removeItem],
  )

  const isInActiveScene = useCallback(
    (sourceId: string) => {
      if (!activeSceneId) return false
      const scene = useSceneStore.getState().scenes[activeSceneId]
      return Boolean(scene?.items.some((item) => item.sourceId === sourceId))
    },
    [activeSceneId],
  )

  const renameSource = useCallback(
    (sourceId: string, name: string) => {
      renameInStore(sourceId, name)
      // Keep the mixer strip label in step with the source name.
      const updated = useSourceStore.getState().sources[sourceId]
      const channel = useAudioStore.getState().channels[sourceId]
      if (updated && channel) {
        useAudioStore.getState().setLabel(sourceId, updated.name)
      }
    },
    [renameInStore],
  )

  const list = sources
    .map((id) => sourceMap[id])
    .filter((source): source is MediaSource => Boolean(source))

  return {
    sources: list,
    addSource,
    removeSource,
    renameSource,
    duplicateSource,
    updateSettings: updateSettingsInStore,
    addToActiveScene,
    removeFromActiveScene,
    isInActiveScene,
    replaceStream,
  }
}

function inferChannelKind(type: SourceType): AudioChannelKind {
  switch (type) {
    case 'microphone':
      return 'host-mic'
    case 'remote-audio':
      return 'guest'
    case 'screen':
      return 'display'
    default:
      return 'media'
  }
}
