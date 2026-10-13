import { create } from 'zustand'
import type { CaptureStatus, MediaError, PermissionStatus } from '@/types/media'
import type { StudioMode } from '@/types/peer'
import type { SessionStatus, StudioSession } from '@/types/session'

/**
 * Session and UI state.
 *
 * Three clearly separated concerns live here, and only the first is persisted:
 *  - session metadata (serializable)
 *  - ephemeral device/capture status (recreated on every load)
 *  - UI state: selection, open panels, dialogs, drag state
 */

export type PanelId = 'sources' | 'properties' | 'audio' | 'scenes' | 'diagnostics' | 'guests'

export type DialogId =
  | 'settings'
  | 'shortcuts'
  | 'command-palette'
  | 'add-source'
  | 'recordings'
  | null

export type ConfirmRequest = {
  title: string
  message: string
  confirmLabel: string
  destructive: boolean
  onConfirm: () => void
} | null

type StudioState = {
  session: StudioSession | null
  status: SessionStatus

  /* ---- capture status (ephemeral) ---- */
  cameraStatus: CaptureStatus
  microphoneStatus: CaptureStatus
  screenStatus: CaptureStatus
  cameraPermission: PermissionStatus
  microphonePermission: PermissionStatus
  lastMediaError: MediaError | null

  /* ---- UI state (ephemeral) ---- */
  selectedSourceId: string | null
  collapsedPanels: Record<PanelId, boolean>
  dialog: DialogId
  confirm: ConfirmRequest
  /** True while a canvas drag/resize gesture is in flight. */
  interacting: boolean
  toast: { message: string; tone: 'info' | 'success' | 'error' } | null

  setSession: (session: StudioSession | null) => void
  setStatus: (status: SessionStatus) => void
  setMode: (mode: StudioMode) => void
  renameSession: (name: string) => void

  setCameraStatus: (status: CaptureStatus) => void
  setMicrophoneStatus: (status: CaptureStatus) => void
  setScreenStatus: (status: CaptureStatus) => void
  setCameraPermission: (status: PermissionStatus) => void
  setMicrophonePermission: (status: PermissionStatus) => void
  setMediaError: (error: MediaError | null) => void

  selectSource: (sourceId: string | null) => void
  togglePanel: (panel: PanelId) => void
  setPanelCollapsed: (panel: PanelId, collapsed: boolean) => void
  openDialog: (dialog: DialogId) => void
  closeDialog: () => void
  requestConfirm: (request: NonNullable<ConfirmRequest>) => void
  resolveConfirm: (confirmed: boolean) => void
  setInteracting: (interacting: boolean) => void
  showToast: (message: string, tone?: 'info' | 'success' | 'error') => void
  dismissToast: () => void

  resetEphemeral: () => void
}

const INITIAL_PANELS: Record<PanelId, boolean> = {
  sources: false,
  properties: false,
  audio: false,
  scenes: false,
  diagnostics: true,
  guests: false,
}

export const useStudioStore = create<StudioState>()((set, get) => ({
  session: null,
  status: 'idle',

  cameraStatus: 'idle',
  microphoneStatus: 'idle',
  screenStatus: 'idle',
  cameraPermission: 'unknown',
  microphonePermission: 'unknown',
  lastMediaError: null,

  selectedSourceId: null,
  collapsedPanels: INITIAL_PANELS,
  dialog: null,
  confirm: null,
  interacting: false,
  toast: null,

  setSession: (session) => set({ session }),
  setStatus: (status) => set({ status }),

  setMode: (mode) =>
    set((state) => (state.session ? { session: { ...state.session, mode } } : state)),

  renameSession: (name) =>
    set((state) => {
      const trimmed = name.trim()
      if (!state.session || !trimmed) return state
      return { session: { ...state.session, name: trimmed } }
    }),

  setCameraStatus: (cameraStatus) => set({ cameraStatus }),
  setMicrophoneStatus: (microphoneStatus) => set({ microphoneStatus }),
  setScreenStatus: (screenStatus) => set({ screenStatus }),
  setCameraPermission: (cameraPermission) => set({ cameraPermission }),
  setMicrophonePermission: (microphonePermission) => set({ microphonePermission }),
  setMediaError: (lastMediaError) => set({ lastMediaError }),

  selectSource: (selectedSourceId) => set({ selectedSourceId }),

  togglePanel: (panel) =>
    set((state) => ({
      collapsedPanels: { ...state.collapsedPanels, [panel]: !state.collapsedPanels[panel] },
    })),

  setPanelCollapsed: (panel, collapsed) =>
    set((state) => ({ collapsedPanels: { ...state.collapsedPanels, [panel]: collapsed } })),

  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  requestConfirm: (confirm) => set({ confirm }),

  resolveConfirm: (confirmed) => {
    const { confirm } = get()
    set({ confirm: null })
    if (confirmed && confirm) confirm.onConfirm()
  },

  setInteracting: (interacting) => set({ interacting }),

  showToast: (message, tone = 'info') => set({ toast: { message, tone } }),
  dismissToast: () => set({ toast: null }),

  /** Called when a session ends: forget live status, keep preferences. */
  resetEphemeral: () =>
    set({
      cameraStatus: 'idle',
      microphoneStatus: 'idle',
      screenStatus: 'idle',
      lastMediaError: null,
      selectedSourceId: null,
      dialog: null,
      confirm: null,
      interacting: false,
    }),
}))

export const selectSession = (state: StudioState) => state.session
export const selectMode = (state: StudioState): StudioMode => state.session?.mode ?? 'local'
export const selectSelectedSourceId = (state: StudioState) => state.selectedSourceId
export const selectIsPanelCollapsed = (panel: PanelId) => (state: StudioState) =>
  state.collapsedPanels[panel]
