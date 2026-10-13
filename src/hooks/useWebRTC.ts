import { useCallback, useEffect, useRef, useState } from 'react'
import type { PeerState, SignalEnvelope } from '@/types/peer'
import { peerManager } from '@/services/webrtc/peer-manager'
import type { GatheringOutcome } from '@/services/webrtc/ice'
import { describeConnectivity } from '@/services/webrtc/ice'
import { compositor } from '@/services/composition/compositor'
import { audioMixer } from '@/services/audio/audio-mixer'
import { useGuestStore } from '@/stores/guestStore'
import { useStudioStore } from '@/stores/studioStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSimulationStore } from '@/stores/simulationStore'
import { useGuests } from './useGuests'
import { useSignaling } from './useSignaling'

/**
 * Peer Connection Mode.
 *
 * Orchestrates the manual-signaling handshake:
 *
 *     host creates offer → copies code → guest pastes it → guest creates
 *     answer → copies code → host pastes it → ICE checks → connected
 *
 * The host sends its *program output* to guests — the composed canvas plus the
 * mixed audio — which is what makes this a production feed rather than a raw
 * webcam call.
 *
 * Status is never optimistic: `connected` comes from
 * `RTCPeerConnection.connectionState`, and a failure says what failed and why.
 */

export type ConnectivityAssessment = {
  level: 'good' | 'limited' | 'poor'
  message: string
  candidateCount: number
  gatheringComplete: boolean
}

export type UseWebRTC = {
  supported: boolean
  peers: PeerState[]
  /** Assessment of the last locally-gathered candidate set. */
  connectivity: ConnectivityAssessment | null
  busy: boolean

  signaling: ReturnType<typeof useSignaling>

  /** Host: produce an offer code to send to a guest. */
  createOffer: () => Promise<void>
  /** Guest: apply a host's offer and produce an answer code. */
  acceptOfferCode: (raw: string) => Promise<void>
  /** Host: apply a guest's answer code. */
  acceptAnswerCode: (raw: string) => Promise<void>
  closePeer: (peerId: string) => void
  closeAll: () => void
}

export function useWebRTC(): UseWebRTC {
  const session = useStudioStore((state) => state.session)
  const showToast = useStudioStore((state) => state.showToast)
  const iceServerUrls = useSettingsStore((state) => state.settings.iceServerUrls)

  const peerStates = useGuestStore((state) => state.peerStates)
  const setPeerState = useGuestStore((state) => state.setPeerState)
  const setPeerStats = useGuestStore((state) => state.setPeerStats)
  const removePeer = useGuestStore((state) => state.removePeer)
  const bindPeer = useGuestStore((state) => state.bindPeer)

  const { addPeerGuest, attachStream, detachStream } = useGuests()
  const poorConnection = useSimulationStore((state) => state.flags.poorConnection)

  const [connectivity, setConnectivity] = useState<ConnectivityAssessment | null>(null)
  const [busy, setBusy] = useState(false)

  /** peerId → guestId, so an incoming stream lands on the right guest. */
  const peerToGuest = useRef(new Map<string, string>())

  /**
   * `acceptOffer` is defined further down but is needed by the adapter
   * callback registered here. Routing through a ref keeps the callback
   * identity stable *and* always invokes the current implementation, which a
   * direct closure over a later `const` would not.
   */
  const acceptOfferRef = useRef<((envelope: SignalEnvelope) => Promise<void>) | null>(null)

  const handleOfferReceived = useCallback((envelope: SignalEnvelope) => {
    void acceptOfferRef.current?.(envelope)
  }, [])

  const handleAnswerReceived = useCallback((envelope: SignalEnvelope) => {
    void peerManager.acceptAnswer(envelope)
  }, [])

  const signaling = useSignaling({
    onOffer: handleOfferReceived,
    onAnswer: handleAnswerReceived,
  })

  /**
   * `useSignaling` returns a fresh object each render. Depending on it
   * directly below would reconfigure the peer manager on every render, so the
   * one method the manager needs is reached through a ref instead.
   */
  const publishRef = useRef(signaling.publish)
  publishRef.current = signaling.publish

  /**
   * Configure the manager.
   *
   * Re-runs when the ICE configuration or session identity changes. Existing
   * peers keep the configuration they were created with — WebRTC does not
   * allow changing ICE servers on a live connection.
   */
  useEffect(() => {
    peerManager.configure({
      iceServerUrls,
      sessionId: session?.id ?? '',
      localLabel: session?.name ?? 'Host',
      events: {
        onStateChange: (state) => {
          setPeerState(state)
          if (state.status === 'failed' && state.error) {
            showToast(state.error, 'error')
          }
        },
        onStats: (peerId, stats) => setPeerStats(peerId, stats),
        onRemoteStream: (peerId, stream) => {
          const guestId = peerToGuest.current.get(peerId)
          if (!guestId) return
          attachStream(guestId, stream)
        },
        onRemoteStreamEnded: (peerId) => {
          const guestId = peerToGuest.current.get(peerId)
          if (guestId) detachStream(guestId)
        },
        onLocalDescriptionReady: (envelope, outcome) => {
          void publishRef.current(envelope)
          setConnectivity(toAssessment(outcome))
        },
      },
    })
  }, [
    attachStream,
    detachStream,
    iceServerUrls,
    session?.id,
    session?.name,
    setPeerState,
    setPeerStats,
    showToast,
  ])

  /**
   * Keep the outgoing feed pointed at the program output.
   *
   * Guests receive the composed canvas and the mixed audio, so what they see
   * is exactly what is being recorded.
   */
  useEffect(() => {
    const canvas = compositor.getCanvas()
    if (!canvas) return
    let stream: MediaStream | null = null
    try {
      stream = canvas.captureStream(30)
      const audioTracks = audioMixer.getProgramStream()?.getAudioTracks() ?? []
      for (const track of audioTracks) stream.addTrack(track)
      void peerManager.setLocalStream(stream)
    } catch {
      // Capture unsupported: peers will still connect, receive-only.
      return
    }
    return () => {
      void peerManager.setLocalStream(null)
      // These tracks were created here for the peer senders, so stopping them
      // is this effect's responsibility.
      for (const track of stream?.getVideoTracks() ?? []) track.stop()
    }
  }, [])

  const createOffer = useCallback(async () => {
    setBusy(true)
    try {
      // A guest row is created up front so the operator can see the pending
      // connection — its status stays honest ("awaiting signaling") until the
      // peer actually connects.
      const guest = addPeerGuest()
      const result = await peerManager.createOffer()
      if (!result) {
        showToast('An offer could not be created in this browser.', 'error')
        return
      }
      peerToGuest.current.set(result.peerId, guest.id)
      bindPeer(guest.id, result.peerId)
    } finally {
      setBusy(false)
    }
  }, [addPeerGuest, bindPeer, showToast])

  const acceptOffer = useCallback(
    async (envelope: SignalEnvelope) => {
      setBusy(true)
      try {
        const guest = addPeerGuest(envelope.label || 'Host')
        const result = await peerManager.acceptOffer(envelope)
        if (!result) {
          showToast('That offer could not be applied.', 'error')
          return
        }
        peerToGuest.current.set(result.peerId, guest.id)
        bindPeer(guest.id, result.peerId)
      } finally {
        setBusy(false)
      }
    },
    [addPeerGuest, bindPeer, showToast],
  )

  // Publish the current implementation for the adapter callback above.
  acceptOfferRef.current = acceptOffer

  const acceptOfferCode = useCallback(
    async (raw: string) => {
      const envelope = signaling.validate(raw, 'offer')
      if (!envelope) return
      await acceptOffer(envelope)
    },
    [acceptOffer, signaling],
  )

  const acceptAnswerCode = useCallback(
    async (raw: string) => {
      const envelope = signaling.validate(raw, 'answer')
      if (!envelope) return
      setBusy(true)
      try {
        const applied = await peerManager.acceptAnswer(envelope)
        if (applied) {
          signaling.clearPublished()
          showToast('Answer applied. Running connectivity checks…', 'info')
        }
      } finally {
        setBusy(false)
      }
    },
    [showToast, signaling],
  )

  const closePeer = useCallback(
    (peerId: string) => {
      peerManager.closePeer(peerId)
      const guestId = peerToGuest.current.get(peerId)
      if (guestId) detachStream(guestId)
      peerToGuest.current.delete(peerId)
      removePeer(peerId)
    },
    [detachStream, removePeer],
  )

  const closeAll = useCallback(() => {
    for (const peerId of [...peerToGuest.current.keys()]) closePeer(peerId)
    peerManager.closeAll()
  }, [closePeer])

  /**
   * Demo panel: "poor connection". The simulated degradation is annotated as
   * such in the diagnostics panel and never merged into real `getStats()`
   * numbers.
   */
  useEffect(() => {
    if (!poorConnection) return
    showToast(
      'Poor-connection simulation is on. Diagnostics will label the affected readings as simulated.',
      'info',
    )
  }, [poorConnection, showToast])

  // Close every peer when the studio unmounts.
  useEffect(
    () => () => {
      peerManager.closeAll()
      peerToGuest.current.clear()
    },
    [],
  )

  return {
    supported: peerManager.isSupported(),
    peers: Object.values(peerStates),
    connectivity,
    busy,
    signaling,
    createOffer,
    acceptOfferCode,
    acceptAnswerCode,
    closePeer,
    closeAll,
  }
}

function toAssessment(outcome: GatheringOutcome): ConnectivityAssessment {
  const described = describeConnectivity(outcome)
  return {
    level: described.level,
    message: described.message,
    candidateCount: outcome.candidateCount,
    gatheringComplete: outcome.complete,
  }
}
