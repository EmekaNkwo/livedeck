import { Crop, Grid3x3, Maximize2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { useCanvasInteraction } from '@/hooks/useCanvasInteraction'
import { useProgramCompositor } from '@/hooks/useProgramCompositor'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStudioStore } from '@/stores/studioStore'
import { useRecordingStore } from '@/stores/recordingStore'
import { formatDuration } from '@/utils/format'
import { Badge } from '@/components/shared/Status'
import { Button } from '@/components/shared/Button'
import { CanvasOverlay } from './CanvasOverlay'

/**
 * The program output and its editor.
 *
 * WHAT YOU SEE IS WHAT IS RECORDED
 * --------------------------------
 * The `<canvas>` below *is* the program canvas. The compositor paints it, and
 * `canvas.captureStream()` for the recorder and for peer senders is taken from
 * this same element. There is no separate preview render, so the preview and
 * the file cannot drift.
 *
 * The canvas is letterboxed inside its container at the logical aspect ratio,
 * so the composition is stable no matter how the browser window is sized.
 */

export function ProgramCanvas() {
  const { canvasRef, canvasSize, canvasAspect } = useProgramCompositor()
  const interaction = useCanvasInteraction()
  const [cropMode, setCropMode] = useState(false)

  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const scenes = useSceneStore((state) => state.scenes)
  const transition = useSceneStore((state) => state.transition)
  const sources = useSourceStore((state) => state.sources)
  const selectedSourceId = useStudioStore((state) => state.selectedSourceId)
  const showSafeAreas = useSettingsStore((state) => state.settings.showSafeAreas)
  const setShowSafeAreas = useSettingsStore((state) => state.setShowSafeAreas)
  const recordingStatus = useRecordingStore((state) => state.status)
  const recordingElapsed = useRecordingStore((state) => state.elapsedMs)

  const activeScene = activeSceneId ? scenes[activeSceneId] : null
  const items = activeScene?.items ?? []

  const sourceNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [id, source] of Object.entries(sources)) map[id] = source.name
    return map
  }, [sources])

  const selectedHasCrop = useMemo(() => {
    if (!selectedSourceId) return false
    const source = sources[selectedSourceId]
    // Crop only means something for sources that sample a bitmap.
    return (
      source?.type === 'camera' ||
      source?.type === 'screen' ||
      source?.type === 'remote-video' ||
      source?.type === 'image' ||
      source?.type === 'video'
    )
  }, [selectedSourceId, sources])

  const recording = recordingStatus === 'recording'
  const paused = recordingStatus === 'paused'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      {/* Canvas viewport. aspect-ratio keeps the logical frame intact while the
          surrounding layout flexes. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-panel border border-deck-700 bg-canvas-void p-2">
        <div
          className="relative max-h-full max-w-full"
          style={{ aspectRatio: String(canvasAspect), width: '100%' }}
        >
          <div className="relative h-full w-full">
            <canvas
              ref={canvasRef}
              // NOTE: `width`/`height` are deliberately NOT set here. Assigning
              // a canvas's dimension attributes resets its backing store, so
              // letting React re-apply them on an unrelated re-render would
              // silently blank the program output — and the compositor would
              // skip the repaint, because its change-detection revision had not
              // moved. The compositor owns these attributes exclusively, via
              // `resize()`. Ownership of the canvas is undivided.
              // The canvas is the production output, not a decorative image.
              // Its content is described by the scene and source panels, which
              // are the accessible representation of the composition.
              role="img"
              aria-label={
                activeScene
                  ? `Program output. Scene: ${activeScene.name}. ${items.filter((item) => item.visible).length} visible sources.`
                  : 'Program output. No scene selected.'
              }
              className="block h-full w-full rounded-sm bg-deck-950 object-contain"
            />

            {/* Interactive layer. Sits exactly over the canvas, so overlay
                coordinates and canvas coordinates share one viewport. */}
            <div
              ref={interaction.containerRef}
              onPointerDown={interaction.onPointerDownBackground}
              className="absolute inset-0 touch-none"
            >
              <CanvasOverlay
                items={items}
                selectedSourceId={selectedSourceId}
                viewport={interaction.viewport}
                guides={interaction.guides}
                showSafeAreas={showSafeAreas}
                dragging={interaction.dragging}
                activeHandle={interaction.activeHandle}
                cropMode={cropMode && selectedHasCrop}
                sourceNames={sourceNames}
                onPointerDownItem={interaction.onPointerDownItem}
                onPointerDownHandle={interaction.onPointerDownHandle}
              />
            </div>

            {/* On-air indicator, over the canvas but outside the recorded
                pixels. Pulses, but also always carries the word. */}
            {recording || paused ? (
              <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-2 rounded-md bg-deck-950/85 px-2 py-1">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    recording ? 'animate-live-pulse bg-live-500' : 'bg-warn-400',
                  )}
                />
                <span className="text-[11px] font-semibold tracking-wide text-ink-100 uppercase">
                  {recording ? 'Recording' : 'Paused'}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-ink-300">
                  {formatDuration(recordingElapsed)}
                </span>
              </div>
            ) : null}

            {transition ? (
              <div className="pointer-events-none absolute top-2 right-2">
                <Badge tone="accent">Transition</Badge>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Canvas toolbar. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
        <span className="font-mono text-[11px] text-ink-500 tabular-nums">
          {canvasSize.width}×{canvasSize.height}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            active={cropMode}
            aria-pressed={cropMode}
            disabled={!selectedHasCrop}
            onClick={() => setCropMode((value) => !value)}
            title={
              selectedHasCrop
                ? 'Toggle crop handles for the selected source'
                : 'Select an image or video source to crop'
            }
          >
            <Crop aria-hidden="true" className="h-3.5 w-3.5" />
            Crop
          </Button>

          <Button
            variant="ghost"
            size="sm"
            active={showSafeAreas}
            aria-pressed={showSafeAreas}
            onClick={() => setShowSafeAreas(!showSafeAreas)}
            title="Show title-safe and action-safe guides"
          >
            <Grid3x3 aria-hidden="true" className="h-3.5 w-3.5" />
            Guides
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const element = document.querySelector('canvas')
              void element?.parentElement?.parentElement?.requestFullscreen?.().catch(() => {
                // Fullscreen can be refused by permissions policy; harmless.
              })
            }}
            title="Fullscreen program output"
          >
            <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="sr-only">Fullscreen program output</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
