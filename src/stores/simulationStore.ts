import { create } from 'zustand'
import type { SimulationFlags } from '@/types/session'
import { NO_SIMULATIONS } from '@/types/session'

/**
 * Demo and fault-injection state.
 *
 * Kept entirely separate from real browser and WebRTC state. Nothing in here
 * is ever merged into the diagnostics panel's real metrics; where a simulated
 * value is displayed it is explicitly labelled as such.
 *
 * Simulations drive the *real* application state transitions — a simulated
 * camera interruption actually tears the track down, a simulated guest
 * disconnect actually closes the peer — so the error paths they exercise are
 * the production ones.
 */

export type SimulationEvent = {
  id: number
  label: string
  at: number
}

type SimulationState = {
  demoActive: boolean
  flags: SimulationFlags
  /** Recent injected events, newest first — shown in the demo panel. */
  log: SimulationEvent[]
  nextEventId: number

  setDemoActive: (active: boolean) => void
  setFlag: (flag: keyof SimulationFlags, value: boolean) => void
  toggleFlag: (flag: keyof SimulationFlags) => void
  logEvent: (label: string) => void
  reset: () => void
}

const MAX_LOG = 20

export const useSimulationStore = create<SimulationState>()((set) => ({
  demoActive: false,
  flags: NO_SIMULATIONS,
  log: [],
  nextEventId: 1,

  setDemoActive: (demoActive) => set({ demoActive }),

  setFlag: (flag, value) =>
    set((state) => ({ flags: { ...state.flags, [flag]: value } })),

  toggleFlag: (flag) =>
    set((state) => ({ flags: { ...state.flags, [flag]: !state.flags[flag] } })),

  logEvent: (label) =>
    set((state) => ({
      log: [{ id: state.nextEventId, label, at: Date.now() }, ...state.log].slice(0, MAX_LOG),
      nextEventId: state.nextEventId + 1,
    })),

  reset: () => set({ demoActive: false, flags: NO_SIMULATIONS, log: [] }),
}))

export const selectActiveSimulationCount = (state: SimulationState): number =>
  Object.values(state.flags).filter(Boolean).length

export const selectAnySimulationActive = (state: SimulationState): boolean =>
  selectActiveSimulationCount(state) > 0
