import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { OutputSettings, StudioSettings } from '@/types/session'
import { DEFAULT_SETTINGS } from '@/types/session'
import type { FrameRateId } from '@/types/scene'
import { reportPersistenceIssue } from '@/services/persistence/issues'
import { createSafeStorage, storageKey } from '@/services/persistence/local-store'
import { salvageSettings } from '@/services/persistence/schemas'

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
  setSignalingServerUrl: (url: string) => void
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

      setSignalingServerUrl: (signalingServerUrl) =>
        set((state) => ({ settings: { ...state.settings, signalingServerUrl } })),

      reset: () => set((state) => ({ settings: DEFAULT_SETTINGS, revision: state.revision + 1 })),
    }),
    {
      name: storageKey('settings'),
      storage: createJSONStorage(() => createSafeStorage()),
      // Only `settings` is persisted; `revision` is a render-scheduling detail.
      partialize: (state) => ({ settings: state.settings }),
      version: 4,
      /**
       * v1/v2 dropped the signaling transport choice; v3 the static STUN
       * list. Both, and anything older, are dropped here; the server URL and
       * every other preference are kept.
       */
      /*
       * v3 → v4: extra ICE servers are gone. Media travels through Jitsi,
       * which brings its own STUN and TURN; a list here would do nothing.
       */
      migrate: (persisted, version) => {
        if (version >= 4) return persisted
        const state = persisted as { settings?: unknown } | undefined
        // Only an object can be migrated; anything else goes to validation,
        // which reports it and restores the defaults.
        if (!state?.settings || typeof state.settings !== 'object') return persisted
        const { signalingTransport: _transport, iceServerUrls: _ice, ...rest } = state.settings as Record<string, unknown>
        void _transport
        void _ice
        return { ...state, settings: rest }
      },
      // Merge rather than replace, so a settings key added in a later version
      // gets its default instead of becoming undefined.
      merge: (persisted, current) => {
        const raw = (persisted as { settings?: unknown } | undefined)?.settings
        if (raw === undefined) return { ...current, settings: DEFAULT_SETTINGS }
        // Field by field: a corrupt frame rate costs that one preference, not
        // every setting the operator chose, and never a crash on open.
        const { settings: incoming, dropped } = salvageSettings(raw)
        if (dropped.length > 0) {
          reportPersistenceIssue({
            record: 'settings',
            message: `invalid value${dropped.length === 1 ? '' : 's'} for ${dropped.join(', ')}; default${dropped.length === 1 ? '' : 's'} restored`,
          })
        }
        const output = (incoming.output as Partial<StudioSettings['output']> | undefined) ?? {}
        return {
          ...current,
          settings: {
            ...DEFAULT_SETTINGS,
            ...(incoming as Partial<StudioSettings>),
            output: { ...DEFAULT_SETTINGS.output, ...output },
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
