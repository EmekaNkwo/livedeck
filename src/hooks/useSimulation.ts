import { useCallback, useEffect, useRef } from 'react'
import type { SimulationFlags } from '@/types/session'
import { peerManager } from '@/services/webrtc/peer-manager'
import { streamRegistry } from '@/services/media/stream-registry'
import { useSimulationStore } from '@/stores/simulationStore'
import { useGuestStore } from '@/stores/guestStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { useGuests } from './useGuests'

/**
 * The demo panel.
 *
 * Simulations drive the **real** application state transitions rather than
 * painting fake states:
 *  - camera interruption actually disposes the camera's tracks (handled in
 *    `useCamera`, which owns that stream),
 *  - guest disconnect actually closes the RTCPeerConnection,
 *  - source unavailable actually drops the source's stream reference, so the
 *    compositor really has nothing to draw and shows its placeholder,
 *  - recording failure routes through the recorder's real error path.
 *
 * This is why the demo exercises the production code paths. Simulation state
 * is kept in its own store and is always labelled in the UI.
 */

export type SimulationDescriptor = {
  flag: keyof SimulationFlags
  label: string
  description: string
  /** Null when the simulation is available. */
  unavailableReason: string | null
}

export type UseSimulation = {
  demoActive: boolean
  flags: SimulationFlags
  log: ReturnType<typeof useSimulationStore.getState>['log']
  descriptors: SimulationDescriptor[]

  startDemo: () => void
  resetDemo: () => void
  toggleFlag: (flag: keyof SimulationFlags) => void
  addDemoGuest: () => void
}

export function useSimulation(): UseSimulation {
  const demoActive = useSimulationStore((state) => state.demoActive)
  const flags = useSimulationStore((state) => state.flags)
  const log = useSimulationStore((state) => state.log)
  const setDemoActive = useSimulationStore((state) => state.setDemoActive)
  const toggleFlagInStore = useSimulationStore((state) => state.toggleFlag)
  const resetStore = useSimulationStore((state) => state.reset)
  const logEvent = useSimulationStore((state) => state.logEvent)

  const guestsRecord = useGuestStore((state) => state.guests)
  const showToast = useStudioStore((state) => state.showToast)
  const { addSimulatedGuest, guests, removeGuest } = useGuests()

  const startDemo = useCallback(() => {
    setDemoActive(true)
    logEvent('Demo mode started')
    // Seed two simulated guests so the split-screen scenes in the walkthrough
    // have something to show.
    const existing = Object.values(useGuestStore.getState().guests).filter((g) => g.simulated)
    if (existing.length === 0) {
      addSimulatedGuest('Demo Guest 1')
      addSimulatedGuest('Demo Guest 2')
    }
  }, [addSimulatedGuest, logEvent, setDemoActive])

  const resetDemo = useCallback(() => {
    // Remove every simulated guest, which stops their generators and releases
    // their sources through the normal teardown path.
    for (const guest of Object.values(useGuestStore.getState().guests)) {
      if (guest.simulated) removeGuest(guest.id)
    }
    resetStore()
    showToast('Demo reset. Simulated guests and injected failures cleared.', 'info')
  }, [removeGuest, resetStore, showToast])

  const addDemoGuest = useCallback(() => {
    addSimulatedGuest()
  }, [addSimulatedGuest])

  /**
   * Guest disconnect.
   *
   * Closes a real peer connection when one exists. For a simulated guest there
   * is no transport to close, so the generated feed is stopped instead — and
   * the log says which of the two happened.
   */
  const disconnectHandled = useRef(false)
  useEffect(() => {
    if (!flags.guestDisconnect) {
      disconnectHandled.current = false
      return
    }
    if (disconnectHandled.current) return
    disconnectHandled.current = true

    const peerGuest = guests.find((view) => view.peer && view.peer.status === 'connected')
    if (peerGuest?.guest.peerId) {
      peerManager.simulateDisconnect(peerGuest.guest.peerId)
      logEvent(`Peer connection for “${peerGuest.guest.name}” closed (simulated)`)
      return
    }

    const simulatedGuest = guests.find((view) => view.guest.simulated && view.stream)
    if (simulatedGuest) {
      // Dispose through the registry so the compositor and mixer see the feed
      // end exactly as they would for a real dropout.
      const key = `guest:${simulatedGuest.guest.id}`
      streamRegistry.dispose(key, 'ended')
      logEvent(`Simulated feed for “${simulatedGuest.guest.name}” dropped`)
      return
    }

    logEvent('Guest disconnect requested, but there is no guest to disconnect')
  }, [flags.guestDisconnect, guests, logEvent])

  /**
   * Source unavailable.
   *
   * Drops the first live non-camera source's stream, so the compositor really
   * has nothing to draw. The camera is excluded because it has its own
   * dedicated simulation.
   */
  const unavailableHandled = useRef(false)
  useEffect(() => {
    if (!flags.sourceUnavailable) {
      unavailableHandled.current = false
      return
    }
    if (unavailableHandled.current) return
    unavailableHandled.current = true

    const target = Object.values(useSourceStore.getState().sources).find(
      (source) => source.streamKey && source.type !== 'camera',
    )
    if (!target?.streamKey) {
      logEvent('Source unavailable requested, but no eligible live source was found')
      return
    }
    streamRegistry.dispose(target.streamKey, 'ended')
    useSourceStore.getState().setStreamKey(target.id, null)
    logEvent(`Source “${target.name}” marked unavailable`)
  }, [flags.sourceUnavailable, logEvent])

  const toggleFlag = useCallback(
    (flag: keyof SimulationFlags) => {
      toggleFlagInStore(flag)
      const enabled = !useSimulationStore.getState().flags[flag]
      void enabled
    },
    [toggleFlagInStore],
  )

  const hasSimulatedGuest = Object.values(guestsRecord).some((guest) => guest.simulated)
  const hasPeer = Object.keys(useGuestStore.getState().peerStates).length > 0

  const descriptors: SimulationDescriptor[] = [
    {
      flag: 'cameraInterruption',
      label: 'Camera interruption',
      description:
        'Disposes the camera’s tracks the way an unplugged webcam would, so the unavailable state and its retry controls are genuinely exercised.',
      unavailableReason: null,
    },
    {
      flag: 'guestDisconnect',
      label: 'Guest disconnect',
      description:
        'Closes a connected peer, or drops a simulated feed when no peer exists.',
      unavailableReason:
        hasSimulatedGuest || hasPeer ? null : 'Add a guest first — there is nothing to disconnect.',
    },
    {
      flag: 'poorConnection',
      label: 'Poor connection',
      description:
        'Marks peer readings as degraded. Diagnostics label these as simulated and never mix them into real getStats() values.',
      unavailableReason: hasPeer ? null : 'Needs a live peer connection.',
    },
    {
      flag: 'recordingFailure',
      label: 'Recording failure',
      description:
        'Makes the next recording attempt fail through the recorder’s real error path, producing a recoverable error state.',
      unavailableReason: null,
    },
    {
      flag: 'sourceUnavailable',
      label: 'Source unavailable',
      description:
        'Drops a live source’s stream so the compositor shows its real placeholder.',
      unavailableReason: null,
    },
  ]

  return {
    demoActive,
    flags,
    log,
    descriptors,
    startDemo,
    resetDemo,
    toggleFlag,
    addDemoGuest,
  }
}
