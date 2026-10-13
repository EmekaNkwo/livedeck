import { useCallback } from 'react'
import type { ControlChannelState } from '@/types/room'
import { peerManager } from '@/services/webrtc/peer-manager'
import { useGuestStore } from '@/stores/guestStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Director controls, as VDO.Ninja's control room has them.
 *
 * TWO KINDS OF CONTROL, NEVER CONFLATED
 * -------------------------------------
 *  - **Remote** (`muteGuestMic`, `muteGuestCamera`, `cue`) travel over the data
 *    channel and change things on the *guest's* machine. They can fail — the
 *    channel may not be open — so each returns a boolean and the UI reports the
 *    failure instead of showing a state that never took effect.
 *  - **Local** (`setMutedInLocalMix`) only affect this machine's program mix.
 *    The guest is not told and keeps sending.
 *
 * A real VDO.Ninja director can do both; conflating them would mean telling an
 * operator they had silenced someone when they had only silenced their own
 * monitor.
 */

export type RemoteControlResult = {
  delivered: boolean
  /** Why it did not reach the guest, when it did not. */
  reason: string | null
}

const NOT_CONNECTED: RemoteControlResult = {
  delivered: false,
  reason:
    'The control channel to this guest is not open, so the command did not reach them. They may ' +
    'still be connecting, or their connection may have dropped.',
}

const DELIVERED: RemoteControlResult = { delivered: true, reason: null }

export type UseDirectorControl = {
  /** Control-channel state for a guest's peer, or null if there is no peer. */
  controlStateFor: (peerId: string | null) => ControlChannelState | null
  canControlRemotely: (peerId: string | null) => boolean

  muteGuestMic: (peerId: string | null, muted: boolean) => RemoteControlResult
  muteGuestCamera: (peerId: string | null, muted: boolean) => RemoteControlResult
  sendCue: (peerId: string | null, text: string) => RemoteControlResult
  setGuestLabel: (peerId: string | null, label: string) => RemoteControlResult
  /** Tell every connected guest whether they are live in the program output. */
  broadcastOnAir: (onAir: boolean) => number
  cueAll: (text: string) => number
}

export function useDirectorControl(): UseDirectorControl {
  const controlStates = useGuestStore((state) => state.controlStates)
  const showToast = useStudioStore((state) => state.showToast)

  const controlStateFor = useCallback(
    (peerId: string | null) => (peerId ? (controlStates[peerId] ?? null) : null),
    [controlStates],
  )

  const canControlRemotely = useCallback(
    (peerId: string | null) => Boolean(peerId && controlStates[peerId]?.open),
    [controlStates],
  )

  /** Shared delivery path, so every remote command reports failure the same way. */
  const deliver = useCallback(
    (peerId: string | null, send: () => boolean): RemoteControlResult => {
      if (!peerId) return NOT_CONNECTED
      const ok = send()
      if (!ok) {
        showToast(NOT_CONNECTED.reason ?? 'The command could not be delivered.', 'error')
        return NOT_CONNECTED
      }
      return DELIVERED
    },
    [showToast],
  )

  const muteGuestMic = useCallback(
    (peerId: string | null, muted: boolean) =>
      deliver(peerId, () =>
        peerManager.sendControl(peerId as string, { v: 1, type: 'mute-mic', muted }),
      ),
    [deliver],
  )

  const muteGuestCamera = useCallback(
    (peerId: string | null, muted: boolean) =>
      deliver(peerId, () =>
        peerManager.sendControl(peerId as string, { v: 1, type: 'mute-camera', muted }),
      ),
    [deliver],
  )

  const sendCue = useCallback(
    (peerId: string | null, text: string) =>
      deliver(peerId, () =>
        peerManager.sendControl(peerId as string, { v: 1, type: 'cue', text }),
      ),
    [deliver],
  )

  const setGuestLabel = useCallback(
    (peerId: string | null, label: string) =>
      deliver(peerId, () =>
        peerManager.sendControl(peerId as string, { v: 1, type: 'label', label }),
      ),
    [deliver],
  )

  const broadcastOnAir = useCallback(
    (onAir: boolean) => peerManager.broadcastControl({ v: 1, type: 'on-air', onAir }),
    [],
  )

  const cueAll = useCallback(
    (text: string) => peerManager.broadcastControl({ v: 1, type: 'cue', text }),
    [],
  )

  return {
    controlStateFor,
    canControlRemotely,
    muteGuestMic,
    muteGuestCamera,
    sendCue,
    setGuestLabel,
    broadcastOnAir,
    cueAll,
  }
}
