import { useCallback, useMemo } from 'react'
import type { AspectRatioId, FrameRateId, OutputResolutionId } from '@/types/scene'
import type { StudioSettings } from '@/types/session'
import { resolveCanvasSize } from '@/services/composition/composition-model'
import { detectCapabilities } from '@/lib/capabilities'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSourceStore } from '@/stores/sourceStore'
import { streamRegistry } from '@/services/media/stream-registry'

/**
 * Output quality and editor preferences.
 *
 * These settings change the *real* composition and recording configuration:
 * aspect ratio and resolution resize the program canvas, and frame rate is
 * what `canvas.captureStream(fps)` is given.
 *
 * `warnings` exists so the studio does not promise quality it cannot deliver.
 * Requesting 1080p60 output from a 720p30 camera will encode and upscale
 * fine — but it will not invent detail or frames, and saying so is more useful
 * than letting the operator assume otherwise.
 */

export type QualityWarning = {
  severity: 'info' | 'warning'
  message: string
}

export type UseStudioSettings = {
  settings: StudioSettings
  canvasSize: { width: number; height: number }
  warnings: QualityWarning[]

  setAspectRatio: (aspectRatio: AspectRatioId) => void
  setResolution: (resolution: OutputResolutionId) => void
  setFrameRate: (frameRate: FrameRateId) => void
  setPreviewFrameRate: (frameRate: FrameRateId) => void
  setSnapToGuides: (enabled: boolean) => void
  setSnapThreshold: (px: number) => void
  setShowSafeAreas: (enabled: boolean) => void
  setReducedMotion: (mode: StudioSettings['reducedMotion']) => void
  setIceServerUrls: (urls: string[]) => void
  reset: () => void
}

export function useStudioSettings(): UseStudioSettings {
  const settings = useSettingsStore((state) => state.settings)
  const setOutput = useSettingsStore((state) => state.setOutput)
  const setPreviewFrameRate = useSettingsStore((state) => state.setPreviewFrameRate)
  const setSnapToGuides = useSettingsStore((state) => state.setSnapToGuides)
  const setSnapThreshold = useSettingsStore((state) => state.setSnapThreshold)
  const setShowSafeAreas = useSettingsStore((state) => state.setShowSafeAreas)
  const setReducedMotion = useSettingsStore((state) => state.setReducedMotion)
  const setIceServerUrls = useSettingsStore((state) => state.setIceServerUrls)
  const reset = useSettingsStore((state) => state.reset)

  const sources = useSourceStore((state) => state.sources)

  const canvasSize = useMemo(
    () => resolveCanvasSize(settings.output.aspectRatio, settings.output.resolution),
    [settings.output.aspectRatio, settings.output.resolution],
  )

  /**
   * Compare the requested output against what the live sources can actually
   * sustain, reading real track settings rather than guessing.
   */
  const warnings = useMemo<QualityWarning[]>(() => {
    const list: QualityWarning[] = []
    const caps = detectCapabilities()

    if (!caps.mediaRecorder) {
      list.push({
        severity: 'warning',
        message: 'Recording is unavailable in this browser, so output settings affect preview only.',
      })
    }

    const pixels = canvasSize.width * canvasSize.height
    if (pixels >= 1920 * 1080 && settings.output.frameRate === 60) {
      list.push({
        severity: 'warning',
        message:
          '1080p at 60 fps is demanding. If the compositor cannot keep up, the recording will ' +
          'contain fewer frames than requested. The diagnostics panel shows the actual rate.',
      })
    }

    // Does any live video source actually reach the requested resolution?
    let bestHeight = 0
    let bestFrameRate = 0
    let liveVideoSources = 0
    for (const source of Object.values(sources)) {
      if (!source.streamKey) continue
      if (source.type !== 'camera' && source.type !== 'screen' && source.type !== 'remote-video') {
        continue
      }
      const stream = streamRegistry.getStream(source.streamKey)
      const track = stream?.getVideoTracks()[0]
      if (!track) continue
      liveVideoSources += 1
      const trackSettings = track.getSettings()
      bestHeight = Math.max(bestHeight, trackSettings.height ?? 0)
      bestFrameRate = Math.max(bestFrameRate, trackSettings.frameRate ?? 0)
    }

    if (liveVideoSources > 0 && bestHeight > 0 && bestHeight < canvasSize.height) {
      list.push({
        severity: 'info',
        message:
          `The highest-resolution live source is ${bestHeight}p, below the ${canvasSize.height}p ` +
          'output. The recording will be upscaled rather than genuinely sharper.',
      })
    }

    if (liveVideoSources > 0 && bestFrameRate > 0 && bestFrameRate < settings.output.frameRate) {
      list.push({
        severity: 'info',
        message:
          `The fastest live source runs at ${Math.round(bestFrameRate)} fps, below the ` +
          `${settings.output.frameRate} fps output. Frames will be repeated, not added.`,
      })
    }

    if (settings.previewFrameRate < settings.output.frameRate) {
      list.push({
        severity: 'info',
        message:
          'The preview is capped below the output rate to save CPU. Recording still runs at the ' +
          'full output rate.',
      })
    }

    return list
  }, [canvasSize.height, canvasSize.width, settings.output.frameRate, settings.previewFrameRate, sources])

  const setAspectRatio = useCallback(
    (aspectRatio: AspectRatioId) => setOutput({ aspectRatio }),
    [setOutput],
  )
  const setResolution = useCallback(
    (resolution: OutputResolutionId) => setOutput({ resolution }),
    [setOutput],
  )
  const setFrameRate = useCallback(
    (frameRate: FrameRateId) => setOutput({ frameRate }),
    [setOutput],
  )

  return {
    settings,
    canvasSize,
    warnings,
    setAspectRatio,
    setResolution,
    setFrameRate,
    setPreviewFrameRate,
    setSnapToGuides,
    setSnapThreshold,
    setShowSafeAreas,
    setReducedMotion,
    setIceServerUrls,
    reset,
  }
}

/** Resolve the effective reduced-motion preference for *interface* animation. */
export function useReducedMotion(): boolean {
  const mode = useSettingsStore((state) => state.settings.reducedMotion)
  return useMemo(() => {
    if (mode === 'always') return true
    if (mode === 'never') return false
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [mode])
}
