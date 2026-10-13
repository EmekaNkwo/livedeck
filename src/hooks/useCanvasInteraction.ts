import { useCallback, useEffect, useRef, useState } from 'react'
import type { NormalizedRect, Point, Size } from '@/types/geometry'
import type { SnapGuide } from '@/utils/snapping'
import type {
  CropHandleId,
  GestureModifiers,
  GestureState,
  HandleId,
} from '@/services/composition/interaction-controller'
import { applyGesture, hitTestItem } from '@/services/composition/interaction-controller'
import { useSceneStore } from '@/stores/sceneStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Pointer handling for the composition canvas.
 *
 * Thin by design: it converts pointer events into viewport coordinates, hands
 * them to the pure gesture controller, and writes the result to the scene
 * store. All geometry lives in `interaction-controller.ts`.
 *
 * Pointer capture is used so a drag keeps tracking even when the pointer
 * leaves the canvas, and the same code path serves mouse, pen and touch.
 */

export type UseCanvasInteraction = {
  /** Attach to the interactive overlay element. */
  containerRef: React.RefObject<HTMLDivElement | null>
  viewport: Size
  guides: SnapGuide[]
  dragging: boolean
  activeHandle: HandleId | CropHandleId | null
  onPointerDownBackground: (event: React.PointerEvent) => void
  onPointerDownItem: (event: React.PointerEvent, sourceId: string) => void
  onPointerDownHandle: (
    event: React.PointerEvent,
    sourceId: string,
    handle: HandleId | CropHandleId,
  ) => void
}

export function useCanvasInteraction(): UseCanvasInteraction {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })
  const [guides, setGuides] = useState<SnapGuide[]>([])
  const [activeHandle, setActiveHandle] = useState<HandleId | CropHandleId | null>(null)

  const gestureRef = useRef<GestureState | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  /** rAF handle, so a fast pointer does not queue more work than it can draw. */
  const frameRef = useRef<number>(0)
  const pendingRef = useRef<{ pointer: Point; modifiers: GestureModifiers } | null>(null)

  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const setItemTransform = useSceneStore((state) => state.setItemTransform)
  const selectSource = useStudioStore((state) => state.selectSource)
  const setInteracting = useStudioStore((state) => state.setInteracting)
  const snapEnabled = useSettingsStore((state) => state.settings.snapToGuides)
  const snapThresholdPx = useSettingsStore((state) => state.settings.snapThresholdPx)

  /** Track the displayed canvas size so normalized↔pixel conversion is exact. */
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setViewport({ width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const toLocalPoint = useCallback((event: React.PointerEvent | PointerEvent): Point => {
    const element = containerRef.current
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  const readModifiers = (event: React.PointerEvent | PointerEvent): GestureModifiers => ({
    aspectLock: event.shiftKey,
    fromCenter: event.altKey,
    disableSnap: event.ctrlKey || event.metaKey,
  })

  const beginGesture = useCallback(
    (
      event: React.PointerEvent,
      sourceId: string,
      handle: HandleId | CropHandleId,
    ) => {
      if (!activeSceneId) return
      const scene = useSceneStore.getState().scenes[activeSceneId]
      const item = scene?.items.find((candidate) => candidate.sourceId === sourceId)
      if (!item) return

      // A locked item is selectable (so its properties can be inspected and it
      // can be unlocked) but is never draggable.
      if (item.locked) {
        selectSource(sourceId)
        return
      }

      const others: NormalizedRect[] = (scene?.items ?? [])
        .filter((candidate) => candidate.sourceId !== sourceId && candidate.visible)
        .map((candidate) => candidate.transform)

      gestureRef.current = {
        handle,
        sourceId,
        startTransform: item.transform,
        startPointer: toLocalPoint(event),
        viewport,
        others,
        snapThresholdPx,
        snapEnabled,
      }

      pointerIdRef.current = event.pointerId
      // Capture keeps events coming to this element even if the pointer leaves
      // the canvas mid-drag, which is essential for edge-of-screen gestures.
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setActiveHandle(handle)
      setInteracting(true)
      selectSource(sourceId)
      event.preventDefault()
      event.stopPropagation()
    },
    [activeSceneId, selectSource, setInteracting, snapEnabled, snapThresholdPx, toLocalPoint, viewport],
  )

  const flush = useCallback(() => {
    frameRef.current = 0
    const gesture = gestureRef.current
    const pending = pendingRef.current
    if (!gesture || !pending || !activeSceneId) return
    const result = applyGesture(gesture, pending.pointer, pending.modifiers)
    setItemTransform(activeSceneId, gesture.sourceId, result.transform)
    setGuides(result.guides)
  }, [activeSceneId, setItemTransform])

  /**
   * Global move/up listeners while a gesture is live.
   *
   * Registering on `window` rather than on the element means a gesture
   * survives the pointer leaving the window, and the up handler always fires
   * so a drag can never get stuck on.
   */
  useEffect(() => {
    if (!activeHandle) return

    const onMove = (event: PointerEvent) => {
      if (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current) return
      pendingRef.current = { pointer: toLocalPoint(event), modifiers: readModifiers(event) }
      // Coalesce to one transform update per animation frame.
      if (frameRef.current === 0) frameRef.current = requestAnimationFrame(flush)
    }

    const finish = () => {
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
        flush()
      }
      gestureRef.current = null
      pendingRef.current = null
      pointerIdRef.current = null
      setActiveHandle(null)
      setGuides([])
      setInteracting(false)
    }

    const onCancelKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Abort: restore the transform the gesture started from.
      const gesture = gestureRef.current
      if (gesture && activeSceneId) {
        setItemTransform(activeSceneId, gesture.sourceId, gesture.startTransform)
      }
      finish()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('keydown', onCancelKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('keydown', onCancelKey)
    }
  }, [activeHandle, activeSceneId, flush, setInteracting, setItemTransform, toLocalPoint])

  // Safety net: a gesture must never outlive the component.
  useEffect(
    () => () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current)
      setInteracting(false)
    },
    [setInteracting],
  )

  const onPointerDownItem = useCallback(
    (event: React.PointerEvent, sourceId: string) => beginGesture(event, sourceId, 'move'),
    [beginGesture],
  )

  const onPointerDownHandle = useCallback(
    (event: React.PointerEvent, sourceId: string, handle: HandleId | CropHandleId) =>
      beginGesture(event, sourceId, handle),
    [beginGesture],
  )

  /**
   * Clicking the background selects the topmost item under the pointer, or
   * clears the selection when there is nothing there — the behaviour expected
   * of a layered editor.
   */
  const onPointerDownBackground = useCallback(
    (event: React.PointerEvent) => {
      if (!activeSceneId) return
      const scene = useSceneStore.getState().scenes[activeSceneId]
      if (!scene) return
      const point = toLocalPoint(event)

      const candidates = scene.items
        .filter((item) => item.visible)
        .sort((a, b) => b.layer - a.layer)

      for (const item of candidates) {
        if (hitTestItem(point, item.transform, viewport)) {
          beginGesture(event, item.sourceId, 'move')
          return
        }
      }
      selectSource(null)
    },
    [activeSceneId, beginGesture, selectSource, toLocalPoint, viewport],
  )

  return {
    containerRef,
    viewport,
    guides,
    dragging: activeHandle !== null,
    activeHandle,
    onPointerDownBackground,
    onPointerDownItem,
    onPointerDownHandle,
  }
}
