import { useCallback, useRef, useState } from 'react'
import { ASPECT_RATIOS } from '@/types/scene'
import { fitToCanvas } from '@/services/sources/source-factory'
import { intrinsicSize } from '@/services/composition/frame-providers'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Spotlight one source, filling the program output.
 *
 * Implemented as a reversible edit to the active scene rather than a hidden
 * compositor mode: the soloed item is fitted to the canvas and brought to the
 * front, and every other item is hidden. Un-soloing restores the exact
 * visibility and transform that were in place before — captured in a snapshot
 * at solo time.
 *
 * Doing it this way means solo is visible in the scene itself, is recorded like
 * any other composition change, and needs no special case in the renderer.
 */

type Snapshot = {
  sceneId: string
  items: Array<{ sourceId: string; visible: boolean; layer: number }>
  soloTransform: { sourceId: string; transform: ReturnType<typeof fitToCanvas> } | null
}

export type UseSolo = {
  /** The source currently soloed, or null. */
  soloedSourceId: string | null
  isSoloed: (sourceId: string) => boolean
  /** Solo this source, or un-solo if it is already soloed. */
  toggleSolo: (sourceId: string) => void
  clearSolo: () => void
}

export function useSolo(): UseSolo {
  const [soloedSourceId, setSoloedSourceId] = useState<string | null>(null)
  const snapshotRef = useRef<Snapshot | null>(null)
  const aspectRatio = useSettingsStore((state) => state.settings.output.aspectRatio)

  const restore = useCallback(() => {
    const snapshot = snapshotRef.current
    snapshotRef.current = null
    if (!snapshot) return

    const { scenes, updateItem } = useSceneStore.getState()
    // The scene may have been deleted while soloed; nothing to restore then.
    if (!scenes[snapshot.sceneId]) return

    for (const entry of snapshot.items) {
      updateItem(snapshot.sceneId, entry.sourceId, {
        visible: entry.visible,
        layer: entry.layer,
      })
    }
    if (snapshot.soloTransform) {
      updateItem(snapshot.sceneId, snapshot.soloTransform.sourceId, {
        transform: snapshot.soloTransform.transform,
      })
    }
  }, [])

  const clearSolo = useCallback(() => {
    restore()
    setSoloedSourceId(null)
  }, [restore])

  const toggleSolo = useCallback(
    (sourceId: string) => {
      if (soloedSourceId === sourceId) {
        clearSolo()
        return
      }

      // Switching directly from one solo to another: put the first one back
      // before snapshotting again, or the snapshot would capture solo state.
      if (soloedSourceId) restore()

      const { activeSceneId, scenes, updateItem } = useSceneStore.getState()
      if (!activeSceneId) return
      const scene = scenes[activeSceneId]
      const target = scene?.items.find((item) => item.sourceId === sourceId)
      if (!scene || !target) return

      const topLayer = Math.max(...scene.items.map((item) => item.layer), 0)

      snapshotRef.current = {
        sceneId: activeSceneId,
        items: scene.items.map((item) => ({
          sourceId: item.sourceId,
          visible: item.visible,
          layer: item.layer,
        })),
        soloTransform: { sourceId, transform: target.transform },
      }

      for (const item of scene.items) {
        if (item.sourceId === sourceId) continue
        updateItem(activeSceneId, item.sourceId, { visible: false })
      }

      const source = useSourceStore.getState().sources[sourceId]
      updateItem(activeSceneId, sourceId, {
        visible: true,
        layer: topLayer + 1,
        transform: fitToCanvas(
          target.transform,
          source ? intrinsicSize(source) : null,
          ASPECT_RATIOS[aspectRatio],
        ),
      })

      setSoloedSourceId(sourceId)
    },
    [aspectRatio, clearSolo, restore, soloedSourceId],
  )

  return {
    soloedSourceId,
    isSoloed: useCallback((sourceId: string) => soloedSourceId === sourceId, [soloedSourceId]),
    toggleSolo,
    clearSolo,
  }
}
