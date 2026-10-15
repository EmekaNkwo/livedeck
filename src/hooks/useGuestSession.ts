import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControlAction } from '@shared/protocol'
import { useMediaSessionStore } from '@/media/session-store'
import { streamRegistry } from '@/services/media/stream-registry'
import { useCamera } from './useCamera'
import { useMicrophone } from './useMicrophone'

/**
 * The guest side of director control.
 *
 * Commands arrive from the server, which has already checked that the sender
 * may issue them. They are applied to this guest's **actual tracks**: a remote
 * mute sets `track.enabled = false`, so nothing is captured or sent.
 *
 * The guest reports its real track state back after every change, read from
 * the tracks rather than from local booleans, so the control room shows what
 * the hardware is doing and a guest unmuting themselves is visible upstream.
 */

export type GuestCue = {
  text: string
  at: number
}

export type UseGuestSession = {
  cue: GuestCue | null
  dismissCue: () => void
  onAir: boolean
  assignedLabel: string | null
  cameraMutedByDirector: boolean
}

function readTrackState(cameraKey: string | null, micMuted: boolean) {
  const cameraStream = cameraKey ? streamRegistry.getStream(cameraKey) : null
  const videoTracks = cameraStream?.getVideoTracks() ?? []
  return {
    micMuted,
    cameraMuted: videoTracks.length > 0 && videoTracks.every((track) => !track.enabled),
  }
}

export function useGuestSession(): UseGuestSession {
  const camera = useCamera()
  const microphone = useMicrophone()
  const session = useMediaSessionStore((state) => state.session)
  const self = useMediaSessionStore((state) => state.snapshot.self)
  const status = useMediaSessionStore((state) => state.snapshot.status)

  const [cue, setCue] = useState<GuestCue | null>(null)
  const [cameraMutedByDirector, setCameraMutedByDirector] = useState(false)

  const devicesRef = useRef({ camera, microphone })
  useEffect(() => {
    devicesRef.current = { camera, microphone }
  }, [camera, microphone])

  const applyControl = useCallback((command: ControlAction) => {
    const { camera: cam, microphone: mic } = devicesRef.current
    switch (command.action) {
      case 'mute-mic':
        mic.setMuted(command.muted)
        return
      case 'mute-camera': {
        const key = cam.source?.streamKey
        const stream = key ? streamRegistry.getStream(key) : null
        for (const track of stream?.getVideoTracks() ?? []) track.enabled = !command.muted
        setCameraMutedByDirector(command.muted)
        return
      }
      case 'cue':
        setCue({ text: command.text, at: Date.now() })
        return
      case 'on-air':
      case 'label':
        // Reflected by the server in this participant's public state.
        return
      case 'kick':
        return
    }
  }, [])

  useEffect(() => {
    if (!session) return
    return session.on('control', ({ command }) => applyControl(command))
  }, [applyControl, session])

  // Report real track state whenever it changes.
  useEffect(() => {
    if (!session || status !== 'joined') return
    const state = readTrackState(camera.source?.streamKey ?? null, microphone.muted)
    void session.updateState(state).catch(() => undefined)
  }, [camera.source?.streamKey, microphone.muted, cameraMutedByDirector, session, status])

  return {
    cue,
    dismissCue: useCallback(() => setCue(null), []),
    onAir: self?.onAir ?? false,
    assignedLabel: self?.label ?? null,
    cameraMutedByDirector,
  }
}
