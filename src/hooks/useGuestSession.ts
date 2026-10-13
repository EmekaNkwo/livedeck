import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControlMessage } from '@/types/room'
import { peerManager } from '@/services/webrtc/peer-manager'
import { streamRegistry } from '@/services/media/stream-registry'
import { useCamera } from './useCamera'
import { useMicrophone } from './useMicrophone'

/**
 * The guest side of the control channel.
 *
 * Director commands are applied to the guest's **actual tracks** — a remote
 * mute sets `track.enabled = false`, so nothing is captured or sent. That is
 * what separates this from a cosmetic "you are muted" badge.
 *
 * The guest also reports its real track state back after every change, read
 * from the tracks rather than from local booleans. So the control room shows
 * what the guest's hardware is doing, not what the director last asked for —
 * and a guest unmuting themselves is visible upstream.
 */

export type GuestCue = {
  text: string
  at: number
}

export type UseGuestSession = {
  /** Last cue the director sent, or null. */
  cue: GuestCue | null
  dismissCue: () => void
  /** True when the director says this guest is live in the program output. */
  onAir: boolean
  /** A label the director assigned, which overrides the URL's `?label=`. */
  assignedLabel: string | null
  /** True when the director muted this guest's camera remotely. */
  cameraMutedByDirector: boolean
  /** Handler to pass to `useWebRTC({ onControlMessage })`. */
  handleControlMessage: (message: ControlMessage) => void
}

/** Read a guest's real track state straight from the live streams. */
function readTrackState(cameraKey: string | null, micMuted: boolean) {
  const cameraStream = cameraKey ? streamRegistry.getStream(cameraKey) : null
  const videoTracks = cameraStream?.getVideoTracks() ?? []
  return {
    micMuted,
    // A camera with no track at all is not "muted", it is absent — reporting
    // muted would make the director think a mute command had taken effect.
    cameraMuted: videoTracks.length > 0 && videoTracks.every((track) => !track.enabled),
  }
}

export function useGuestSession(): UseGuestSession {
  const camera = useCamera()
  const microphone = useMicrophone()

  const [cue, setCue] = useState<GuestCue | null>(null)
  const [onAir, setOnAir] = useState(false)
  const [assignedLabel, setAssignedLabel] = useState<string | null>(null)
  const [cameraMutedByDirector, setCameraMutedByDirector] = useState(false)

  /**
   * Latest device controls, held in a ref.
   *
   * The control handler is registered with the peer manager once; a handler
   * closing over this render's `camera`/`microphone` would go stale and try to
   * mute a track that no longer exists.
   */
  const devicesRef = useRef({ camera, microphone })
  useEffect(() => {
    devicesRef.current = { camera, microphone }
  }, [camera, microphone])

  const handleControlMessage = useCallback((message: ControlMessage) => {
    const { camera: cam, microphone: mic } = devicesRef.current

    switch (message.type) {
      case 'mute-mic':
        // Disables the track itself: no samples are captured or transmitted.
        mic.setMuted(message.muted)
        return

      case 'mute-camera': {
        /*
         * The camera has no mute concept of its own, so the video track is
         * disabled directly rather than stopping the capture. That keeps
         * unmuting instant and avoids a second permission prompt.
         */
        const key = cam.source?.streamKey
        const stream = key ? streamRegistry.getStream(key) : null
        for (const track of stream?.getVideoTracks() ?? []) {
          track.enabled = !message.muted
        }
        setCameraMutedByDirector(message.muted)
        return
      }

      case 'cue':
        setCue({ text: message.text, at: Date.now() })
        return

      case 'on-air':
        setOnAir(message.onAir)
        return

      case 'label':
        setAssignedLabel(message.label)
        return

      case 'ping':
        // Answered inside ControlChannel; nothing to do at this level.
        return
    }
  }, [])

  /**
   * Report real track state upstream whenever it changes.
   *
   * Keyed on the inputs that can actually change it: which capture is live, the
   * microphone's track state, and any remote camera mute.
   */
  useEffect(() => {
    const state = readTrackState(camera.source?.streamKey ?? null, microphone.muted)
    peerManager.broadcastControl({ v: 1, type: 'state', ...state })
  }, [camera.source?.streamKey, microphone.muted, cameraMutedByDirector])

  /**
   * Introduce this guest once a control channel is open.
   *
   * Polled briefly rather than hooked to an event, because the channel opens
   * asynchronously after the handshake and there is no React-visible signal for
   * it. The interval stops as soon as a `hello` lands.
   */
  const greetedRef = useRef(false)
  useEffect(() => {
    if (greetedRef.current) return
    const timer = setInterval(() => {
      const openPeer = peerManager
        .listPeers()
        .find((peer) => peerManager.isControlOpen(peer.peerId))
      if (!openPeer) return

      const state = readTrackState(
        devicesRef.current.camera.source?.streamKey ?? null,
        devicesRef.current.microphone.muted,
      )
      peerManager.sendControl(openPeer.peerId, {
        v: 1,
        type: 'hello',
        label: devicesRef.current.camera.source?.name ?? 'Guest',
        hasVideo: Boolean(devicesRef.current.camera.source?.streamKey),
        hasAudio: Boolean(devicesRef.current.microphone.source?.streamKey),
      })
      peerManager.broadcastControl({ v: 1, type: 'state', ...state })
      greetedRef.current = true
      clearInterval(timer)
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  return {
    cue,
    dismissCue: useCallback(() => setCue(null), []),
    onAir,
    assignedLabel,
    cameraMutedByDirector,
    handleControlMessage,
  }
}
