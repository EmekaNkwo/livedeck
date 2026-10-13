import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Size } from '@/types/geometry'
import { compositor } from '@/services/composition/compositor'
import type { CompositionSnapshot } from '@/services/composition/composition-model'
import { resolveCanvasSize, resolveScene } from '@/services/composition/composition-model'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useRecordingStore } from '@/stores/recordingStore'

/**
 * Bind the compositor to application state.
 *
 * THE IMPORTANT PART
 * ------------------
 * The snapshot callback reads store state with `getState()`, *not* with a
 * React subscription. The render loop therefore samples the latest state up to
 * 60 times a second without React re-rendering anything. A camera moving on
 * the canvas costs zero React renders; only the editor overlay, which is
 * genuinely interactive, is driven by React state.
 *
 * The compositor also owns the program canvas, so this hook only attaches,
 * configures and starts it — it never draws.
 */

export type UseProgramCompositor = {
  /** Attach to the canvas element that displays the program output. */
  canvasRef: (element: HTMLCanvasElement | null) => void
  /** Logical output size in pixels. */
  canvasSize: Size
  canvasAspect: number
  /** The live canvas, for the recorder to capture. */
  getCanvas: () => HTMLCanvasElement | null
}

export function useProgramCompositor(): UseProgramCompositor {
  const aspectRatio = useSettingsStore((state) => state.settings.output.aspectRatio)
  const resolution = useSettingsStore((state) => state.settings.output.resolution)
  const previewFrameRate = useSettingsStore((state) => state.settings.previewFrameRate)
  const recordingFrameRate = useSettingsStore((state) => state.settings.output.frameRate)
  const recordingStatus = useRecordingStore((state) => state.status)

  const attachedRef = useRef<HTMLCanvasElement | null>(null)

  const canvasSize = useMemo(
    () => resolveCanvasSize(aspectRatio, resolution),
    [aspectRatio, resolution],
  )
  const canvasAspect = canvasSize.width / canvasSize.height

  /**
   * While recording, the compositor must run at the *recording* frame rate —
   * the preview cap is a performance convenience and must not silently reduce
   * the frame rate of the file being produced.
   */
  const targetFps =
    recordingStatus === 'recording' ? recordingFrameRate : Math.min(previewFrameRate, recordingFrameRate)

  const buildSnapshot = useCallback((): CompositionSnapshot => {
    const sceneState = useSceneStore.getState()
    const sourceState = useSourceStore.getState()
    const settingsState = useSettingsStore.getState()

    const size = resolveCanvasSize(
      settingsState.settings.output.aspectRatio,
      settingsState.settings.output.resolution,
    )

    // Rebuilt per frame. Allocating one Map here is far cheaper than keeping a
    // memoized copy in sync with every source mutation.
    const sourcesById = new Map(Object.entries(sourceState.sources))

    const activeScene = sceneState.activeSceneId
      ? (sceneState.scenes[sceneState.activeSceneId] ?? null)
      : null
    const previousScene = sceneState.previousSceneId
      ? (sceneState.scenes[sceneState.previousSceneId] ?? null)
      : null

    return {
      canvas: size,
      background: '#08090c',
      current: resolveScene(activeScene, sourcesById),
      outgoing: sceneState.transition ? resolveScene(previousScene, sourcesById) : null,
      transition: sceneState.transition,
      revision:
        sceneState.revision + sourceState.revision + settingsState.revision,
    }
  }, [])

  const canvasRef = useCallback(
    (element: HTMLCanvasElement | null) => {
      if (element === attachedRef.current) return
      attachedRef.current = element
      if (!element) {
        compositor.detach()
        return
      }
      compositor.attach(element)
      compositor.setSnapshotSource(buildSnapshot)
      compositor.resize(canvasSize)
      compositor.start()
    },
    [buildSnapshot, canvasSize],
  )

  useEffect(() => {
    compositor.setTargetFps(targetFps)
  }, [targetFps])

  useEffect(() => {
    compositor.resize(canvasSize)
  }, [canvasSize])

  // Pause the loop when the document is hidden — but never while recording,
  // because the recorder needs frames to keep arriving.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && useRecordingStore.getState().status !== 'recording') {
        compositor.stop()
      } else if (attachedRef.current) {
        compositor.start()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  useEffect(
    () => () => {
      // Unmounting the studio view tears the loop down. Stream and audio
      // lifetimes are owned elsewhere and are untouched here.
      compositor.detach()
      attachedRef.current = null
    },
    [],
  )

  return {
    canvasRef,
    canvasSize,
    canvasAspect,
    getCanvas: () => compositor.getCanvas(),
  }
}
