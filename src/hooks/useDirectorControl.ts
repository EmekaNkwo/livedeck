import { useCallback } from 'react'
import type { ControlAction } from '@shared/protocol'
import { SignalingError } from '@/media/signaling-client'
import { useMediaSessionStore } from '@/media/session-store'
import type { ControlChannelState } from '@/types/room'
import { useGuestStore } from '@/stores/guestStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Director controls.
 *
 * TWO KINDS OF CONTROL, NEVER CONFLATED
 * -------------------------------------
 *  - **Remote** (`muteGuestMic`, `muteGuestCamera`, `cue`, `setGuestLabel`,
 *    `kick`) go through the server, which checks this session's role before
 *    forwarding, and change things on the *guest's* machine. They can be
 *    refused, so each resolves to a result the UI reports.
 *  - **Local** mutes and hides affect only this machine's program mix. The
 *    guest is not told and keeps sending. Those live in `useGuests`.
 */

export type RemoteControlResult = {
  delivered: boolean
  reason: string | null
}

const DELIVERED: RemoteControlResult = { delivered: true, reason: null }

export type UseDirectorControl = {
  controlStateFor: (participantId: string | null) => ControlChannelState | null
  canControlRemotely: (participantId: string | null) => boolean
  muteGuestMic: (participantId: string | null, muted: boolean) => Promise<RemoteControlResult>
  muteGuestCamera: (participantId: string | null, muted: boolean) => Promise<RemoteControlResult>
  sendCue: (participantId: string | null, text: string) => Promise<RemoteControlResult>
  setGuestLabel: (participantId: string | null, label: string) => Promise<RemoteControlResult>
  kick: (participantId: string | null) => Promise<RemoteControlResult>
  /** Tell every participant whether they are live. Resolves to the delivered count. */
  broadcastOnAir: (onAir: boolean) => Promise<number>
  cueAll: (text: string) => Promise<number>
}

export function useDirectorControl(): UseDirectorControl {
  const controlStates = useGuestStore((state) => state.controlStates)
  const showToast = useStudioStore((state) => state.showToast)

  const controlStateFor = useCallback(
    (participantId: string | null) => (participantId ? (controlStates[participantId] ?? null) : null),
    [controlStates],
  )

  const canControlRemotely = useCallback(
    (participantId: string | null) => Boolean(participantId && controlStates[participantId]?.open),
    [controlStates],
  )

  const deliver = useCallback(
    async (participantId: string | null, command: ControlAction): Promise<RemoteControlResult> => {
      const session = useMediaSessionStore.getState().session
      if (!participantId || !session) {
        const reason = 'Not connected to the room, so the command did not reach the guest.'
        showToast(reason, 'error')
        return { delivered: false, reason }
      }
      try {
        await session.control(participantId, command)
        return DELIVERED
      } catch (error) {
        const reason =
          error instanceof SignalingError && error.code === 'forbidden'
            ? 'The server refused this command: your role may not control that participant.'
            : error instanceof Error
              ? error.message
              : 'The command could not be delivered.'
        showToast(reason, 'error')
        return { delivered: false, reason }
      }
    },
    [showToast],
  )

  const broadcast = useCallback(
    async (command: ControlAction): Promise<number> => {
      const session = useMediaSessionStore.getState().session
      if (!session) return 0
      const targets = session.current.participants.filter((p) => p.role !== 'director')
      const results = await Promise.all(
        targets.map((p) => session.control(p.id, command).then(() => true, () => false)),
      )
      return results.filter(Boolean).length
    },
    [],
  )

  return {
    controlStateFor,
    canControlRemotely,
    muteGuestMic: useCallback((id, muted) => deliver(id, { action: 'mute-mic', muted }), [deliver]),
    muteGuestCamera: useCallback((id, muted) => deliver(id, { action: 'mute-camera', muted }), [deliver]),
    sendCue: useCallback((id, text) => deliver(id, { action: 'cue', text }), [deliver]),
    setGuestLabel: useCallback((id, label) => deliver(id, { action: 'label', label }), [deliver]),
    kick: useCallback((id) => deliver(id, { action: 'kick' }), [deliver]),
    broadcastOnAir: useCallback((onAir) => broadcast({ action: 'on-air', onAir }), [broadcast]),
    cueAll: useCallback((text) => broadcast({ action: 'cue', text }), [broadcast]),
  }
}
