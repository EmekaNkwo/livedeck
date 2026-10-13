import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { OutputSettings, StudioSettings } from '@/types/session'
import { DEFAULT_SETTINGS } from '@/types/session'
import type { FrameRateId } from '@/types/scene'
import { createSafeStorage, storageKey } from '@/services/persistence/local-store'

/**
 * Studio preferences.
 *
 * Global rather than per-session: output quality, snapping and motion
 * preferences belong to the operator, not to one production. Everything here
 * is plain JSON, so it is safe to persist directly.
 */

type SettingsState = {
  settings: StudioSettings
  revision: number

  setOutput: (patch: Partial<OutputSettings>) => void
  setSnapToGuides: (enabled: boolean) => void
  setSnapThreshold: (px: number) => void
  setShowSafeAreas: (enabled: boolean) => void
  setReducedMotion: (mode: StudioSettings['reducedMotion']) => void
  setPreviewFrameRate: (fps: FrameRateId) => void
  setMonitorProgramAudio: (enabled: boolean) => void
  setIceServerUrls: (urls: string[]) => void
  reset: () => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      revision: 0,

      setOutput: (patch) =>
        set((state) => ({
          settings: { ...state.settings, output: { ...state.settings.output, ...patch } },
          revision: state.revision + 1,
        })),

      setSnapToGuides: (snapToGuides) =>
        set((state) => ({ settings: { ...state.settings, snapToGuides } })),

      setSnapThreshold: (snapThresholdPx) =>
        set((state) => ({
          settings: { ...state.settings, snapThresholdPx: Math.max(0, Math.min(40, snapThresholdPx)) },
        })),

      setShowSafeAreas: (showSafeAreas) =>
        set((state) => ({
          settings: { ...state.settings, showSafeAreas },
          revision: state.revision + 1,
        })),

      setReducedMotion: (reducedMotion) =>
        set((state) => ({ settings: { ...state.settings, reducedMotion } })),

      setPreviewFrameRate: (previewFrameRate) =>
        set((state) => ({ settings: { ...state.settings, previewFrameRate } })),

      setMonitorProgramAudio: (monitorProgramAudio) =>
        set((state) => ({ settings: { ...state.settings, monitorProgramAudio } })),

      setIceServerUrls: (iceServerUrls) =>
        set((state) => ({ settings: { ...state.settings, iceServerUrls } })),

      reset: () => set((state) => ({ settings: DEFAULT_SETTINGS, revision: state.revision + 1 })),
    }),
    {
      name: storageKey('settings'),
      storage: createJSONStorage(() => createSafeStorage()),
      // Only `settings` is persisted; `revision` is a render-scheduling detail.
      partialize: (state) => ({ settings: state.settings }),
      version: 1,
      // Merge rather than replace, so a settings key added in a later version
      // gets its default instead of becoming undefined.
      merge: (persisted, current) => {
        const incoming = (persisted as { settings?: Partial<StudioSettings> } | undefined)?.settings
        return {
          ...current,
          settings: {
            ...DEFAULT_SETTINGS,
            ...incoming,
            output: { ...DEFAULT_SETTINGS.output, ...incoming?.output },
          },
        }
      },
    },
  ),
)

export const selectOutput = (state: SettingsState) => state.settings.output
export const selectSnapping = (state: SettingsState) => ({
  enabled: state.settings.snapToGuides,
  thresholdPx: state.settings.snapThresholdPx,
})
