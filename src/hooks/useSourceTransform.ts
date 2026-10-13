import { useCallback, useMemo } from 'react'
import type { CropInsets, SourceTransform } from '@/types/geometry'
import type { SceneItem } from '@/types/source'
import { ASPECT_RATIOS } from '@/types/scene'
import { ZERO_CROP } from '@/types/geometry'
import {
  alignTransform,
  centerTransform,
  normalizeCrop,
  normalizeTransform,
} from '@/utils/geometry'
import type { AlignEdge } from '@/utils/geometry'
import { fillCanvas, fitToCanvas } from '@/services/sources/source-factory'
import { intrinsicSize } from '@/services/composition/frame-providers'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Numeric and programmatic editing of the selected item's transform.
 *
 * This is the accessible counterpart to dragging on the canvas: every
 * geometric operation the pointer can perform is available here as a plain
 * function, which is what lets the properties panel offer keyboard- and
 * screen-reader-operable position, size, crop and rotation controls. Drag and
 * drop is never the only way to configure a source.
 *
 * All edits are validated through `normalizeTransform`, so no input — typed,
 * pasted or dragged — can push an item into an unrecoverable state.
 */

export type UseSourceTransform = {
  item: SceneItem | null
  transform: SourceTransform | null
  crop: CropInsets
  locked: boolean

  setPosition: (patch: { x?: number; y?: number }) => void
  setSize: (patch: { width?: number; height?: number }) => void
  setRotation: (degrees: number) => void
  setCrop: (patch: Partial<CropInsets>) => void
  resetCrop: () => void
  setMirrored: (mirrored: boolean) => void
  setOpacity: (opacity: number) => void
  setVisible: (visible: boolean) => void
  setLocked: (locked: boolean) => void

  nudge: (dx: number, dy: number) => void
  scaleBy: (factor: number) => void
  align: (edge: AlignEdge) => void
  center: () => void
  fit: () => void
  fill: () => void
  resetTransform: () => void
  rotateBy: (degrees: number) => void

  moveLayer: (direction: 'up' | 'down' | 'front' | 'back') => void
}

export function useSourceTransform(sourceId: string | null): UseSourceTransform {
  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const scenes = useSceneStore((state) => state.scenes)
  const updateItem = useSceneStore((state) => state.updateItem)
  const moveItemLayer = useSceneStore((state) => state.moveItemLayer)
  const aspectRatio = useSettingsStore((state) => state.settings.output.aspectRatio)
  const showToast = useStudioStore((state) => state.showToast)

  const item = useMemo(() => {
    if (!sourceId || !activeSceneId) return null
    return scenes[activeSceneId]?.items.find((candidate) => candidate.sourceId === sourceId) ?? null
  }, [activeSceneId, scenes, sourceId])

  const transform = item?.transform ?? null
  const crop = transform?.crop ?? ZERO_CROP
  const locked = item?.locked ?? false

  /**
   * Apply a transform change.
   *
   * Locked items reject geometric edits — that is the point of locking — and
   * say so once rather than failing silently.
   */
  const applyTransform = useCallback(
    (next: SourceTransform, options?: { ignoreLock?: boolean }) => {
      if (!sourceId || !activeSceneId || !item) return
      if (item.locked && !options?.ignoreLock) {
        showToast('This source is locked. Unlock it to change its position or size.', 'info')
        return
      }
      updateItem(activeSceneId, sourceId, { transform: normalizeTransform(next) })
    },
    [activeSceneId, item, showToast, sourceId, updateItem],
  )

  const patchItem = useCallback(
    (patch: Partial<SceneItem>) => {
      if (!sourceId || !activeSceneId) return
      updateItem(activeSceneId, sourceId, patch)
    },
    [activeSceneId, sourceId, updateItem],
  )

  const setPosition = useCallback(
    (patch: { x?: number; y?: number }) => {
      if (!transform) return
      applyTransform({
        ...transform,
        x: patch.x ?? transform.x,
        y: patch.y ?? transform.y,
      })
    },
    [applyTransform, transform],
  )

  const setSize = useCallback(
    (patch: { width?: number; height?: number }) => {
      if (!transform) return
      applyTransform({
        ...transform,
        width: patch.width ?? transform.width,
        height: patch.height ?? transform.height,
      })
    },
    [applyTransform, transform],
  )

  const setRotation = useCallback(
    (degrees: number) => {
      if (!transform) return
      applyTransform({ ...transform, rotation: degrees })
    },
    [applyTransform, transform],
  )

  const rotateBy = useCallback(
    (degrees: number) => {
      if (!transform) return
      applyTransform({ ...transform, rotation: transform.rotation + degrees })
    },
    [applyTransform, transform],
  )

  const setCrop = useCallback(
    (patch: Partial<CropInsets>) => {
      if (!transform) return
      const nextCrop = normalizeCrop({ ...(transform.crop ?? ZERO_CROP), ...patch })
      applyTransform({ ...transform, crop: nextCrop })
    },
    [applyTransform, transform],
  )

  const resetCrop = useCallback(() => {
    if (!transform) return
    const { crop: _crop, ...rest } = transform
    void _crop
    applyTransform(rest)
  }, [applyTransform, transform])

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!transform) return
      applyTransform({ ...transform, x: transform.x + dx, y: transform.y + dy })
    },
    [applyTransform, transform],
  )

  /** Scale about the item's centre, so it does not drift while resizing. */
  const scaleBy = useCallback(
    (factor: number) => {
      if (!transform) return
      const width = transform.width * factor
      const height = transform.height * factor
      applyTransform({
        ...transform,
        width,
        height,
        x: transform.x + (transform.width - width) / 2,
        y: transform.y + (transform.height - height) / 2,
      })
    },
    [applyTransform, transform],
  )

  const align = useCallback(
    (edge: AlignEdge) => {
      if (!transform) return
      applyTransform(alignTransform(transform, edge))
    },
    [applyTransform, transform],
  )

  const center = useCallback(() => {
    if (!transform) return
    applyTransform(centerTransform(transform))
  }, [applyTransform, transform])

  const resolveIntrinsic = useCallback(() => {
    if (!sourceId) return null
    const source = useSourceStore.getState().sources[sourceId]
    return source ? intrinsicSize(source) : null
  }, [sourceId])

  const fit = useCallback(() => {
    if (!transform) return
    applyTransform(fitToCanvas(transform, resolveIntrinsic(), ASPECT_RATIOS[aspectRatio]))
  }, [applyTransform, aspectRatio, resolveIntrinsic, transform])

  const fill = useCallback(() => {
    if (!transform) return
    applyTransform(fillCanvas(transform, resolveIntrinsic(), ASPECT_RATIOS[aspectRatio]))
  }, [applyTransform, aspectRatio, resolveIntrinsic, transform])

  const resetTransform = useCallback(() => {
    applyTransform({ x: 0, y: 0, width: 1, height: 1, rotation: 0 })
  }, [applyTransform])

  const moveLayer = useCallback(
    (direction: 'up' | 'down' | 'front' | 'back') => {
      if (!sourceId || !activeSceneId) return
      moveItemLayer(activeSceneId, sourceId, direction)
    },
    [activeSceneId, moveItemLayer, sourceId],
  )

  return {
    item,
    transform,
    crop,
    locked,
    setPosition,
    setSize,
    setRotation,
    setCrop,
    resetCrop,
    setMirrored: (mirrored) => patchItem({ mirrored }),
    setOpacity: (opacity) => patchItem({ opacity }),
    setVisible: (visible) => patchItem({ visible }),
    // Locking is itself allowed on a locked item, otherwise it could never be
    // undone from the properties panel.
    setLocked: (nextLocked) => patchItem({ locked: nextLocked }),
    nudge,
    scaleBy,
    align,
    center,
    fit,
    fill,
    resetTransform,
    rotateBy,
    moveLayer,
  }
}
