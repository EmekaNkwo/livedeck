import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PeerState, SignalEnvelope } from '@/types/peer'
import { peerManager } from '@/services/webrtc/peer-manager'
import type { GatheringOutcome } from '@/services/webrtc/ice'
import { describeConnectivity } from '@/services/webrtc/ice'
import { createTurnCredentialSource } from '@/services/webrtc/turn-credentials'
import { extractSignalFromText } from '@/services/signaling/invite-link'
import { iceServersUrl } from '@/services/signaling/relay-url'
import { compositor } from '@/services/composition/compositor'
import { useSourceStore } from '@/stores/sourceStore'
import { audioMixer } from '@/services/audio/audio-mixer'
import { streamRegistry } from '@/services/media/stream-registry'
import type { ControlMessage } from '@/types/room'
import { useGuestStore } from '@/stores/guestStore'
import { useStudioStore } from '@/stores/studioStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { RoomPeerInfo } from '@/services/signaling/types'
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

/**
 * What this peer sends.
 *
 * A director sends the composed `program` output — that is what makes this a
 * production feed rather than a webcam call. A guest in the push view sends its
 * own `camera` and microphone. The distinction belongs to the caller, because
 * only the view knows which role it is playing.
 */
export type OutboundFeed = 'program' | 'camera' | 'none'

export type UseWebRTCOptions = {
  /** Defaults to `'program'` (director behaviour). */
  send?: OutboundFeed
  /** Handle a director command. Only a guest view supplies this. */
  onControlMessage?: (message: ControlMessage) => void
  /**
   * Join this room on the signaling transport, when it supports rooms.
   *
   * With the relay, supplying this is all that is needed to connect: peers in
   * the same room discover each other and negotiate automatically. With the
   * manual transport it is ignored, because there is no server to join.
   */
  room?: string
  /** This participant's role in the room. Defaults to `director`. */
  role?: 'director' | 'guest'
  /**
   * True while this peer is sharing a screen.
   *
   * Not cosmetic — it is a dependency of the outgoing-stream effect. A screen
   * share lives in the StreamRegistry without a corresponding *source*, so the
   * source-derived fingerprint below cannot see it, and the outgoing stream
   * would never be rebuilt to carry it. The share then played locally and
   * reached nobody.
   */
  sharingScreen?: boolean
  /** Display name announced to the room. */
  label?: string
}

/**
 * Somebody else in the room, as far as this peer can tell.
 *
 * `stream` is null between being announced by the relay and media actually
 * arriving — a real state worth rendering ("connecting") rather than hiding,
 * because it is also where a connection that never completes comes to rest.
 */
export type RemoteParticipant = {
  peerId: string
  label: string
  role: 'director' | 'guest'
  stream: MediaStream | null
  /**
   * This participant's video track is carrying a screen, not a camera.
   *
   * Reported by them over the control channel, because nothing in WebRTC says
   * what a track is *of* — a shared document and a face arrive as the same
   * kind of video. The receiving layout needs to know to give it more room.
   */
  sharingScreen: boolean
}

export type UseWebRTC = {
  supported: boolean
  peers: PeerState[]
  /**
   * Everyone else in the room, in join order.
   *
   * Includes the director when there is one; `programStream` picks it out.
   */
  participants: RemoteParticipant[]
  /** Tell every peer whether this one is now sharing a screen. */
  announceSharing: (sharing: boolean) => void

  /** Assessment of the last locally-gathered candidate set. */
  connectivity: ConnectivityAssessment | null
  busy: boolean

  signaling: ReturnType<typeof useSignaling>

  /**
   * Host: produce an offer.
   *
   * Returns the envelope so a caller can build an invite link from it
   * immediately. Reading it back off this hook's return value would see the
   * *previous* render's value, since React has not re-rendered yet.
   */
  createOffer: () => Promise<SignalEnvelope | null>
  /** Guest: apply a host's offer and produce an answer code. */
  acceptOfferCode: (raw: string) => Promise<void>
  /** Host: apply a guest's answer code. */
  acceptAnswerCode: (raw: string) => Promise<void>
  /**
   * Apply a guest's answer from a link, a bare token, or raw JSON.
   *
   * People paste all three, so all three are accepted rather than demanding
   * one exact shape.
   */
  acceptAnswerInput: (raw: string) => Promise<void>
  /**
   * Guest: apply an offer that arrived out of band (e.g. from a link).
   *
   * Returns the answer envelope, for the same stale-closure reason as
   * `createOffer`.
   */
  acceptOfferEnvelope: (envelope: SignalEnvelope) => Promise<SignalEnvelope | null>
  closePeer: (peerId: string) => void
  closeAll: () => void
}

export function useWebRTC(options?: UseWebRTCOptions): UseWebRTC {
  const send = options?.send ?? 'program'
  const room = options?.room ?? null
  const role = options?.role ?? 'director'
  const label = options?.label ?? 'Peer'
  const sharingScreen = options?.sharingScreen ?? false

  // Held in a ref so a caller passing an inline handler cannot reconfigure the
  // peer manager on every render.
  const onControlMessageRef = useRef(options?.onControlMessage)
  onControlMessageRef.current = options?.onControlMessage

  const session = useStudioStore((state) => state.session)
  const showToast = useStudioStore((state) => state.showToast)
  const iceServerUrls = useSettingsStore((state) => state.settings.iceServerUrls)
  const signalingServerUrl = useSettingsStore((state) => state.settings.signalingServerUrl)

  const peerStates = useGuestStore((state) => state.peerStates)
  const setPeerState = useGuestStore((state) => state.setPeerState)
  const setPeerStats = useGuestStore((state) => state.setPeerStats)
  const removePeer = useGuestStore((state) => state.removePeer)
  const bindPeer = useGuestStore((state) => state.bindPeer)
  const setControlState = useGuestStore((state) => state.setControlState)

  const { addPeerGuest, attachStream, detachStream, removeGuest } = useGuests()

  const [connectivity, setConnectivity] = useState<ConnectivityAssessment | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * TURN credentials, fetched from the relay that signaling already uses.
   *
   * Rebuilt only when the relay address changes, because the source owns a
   * cache: a new instance per render would re-fetch on every handshake and
   * defeat it. The toast is the only place a credential problem is visible —
   * without it, a rotated Cloudflare token presents as connections that fail
   * on exactly the networks TURN was added for.
   */
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const turnSource = useMemo(
    () =>
      createTurnCredentialSource({
        endpoint: iceServersUrl(signalingServerUrl),
        onError: (message) => showToastRef.current(message, 'error'),
      }),
    [signalingServerUrl],
  )

  /**
   * The room roster, keyed by the relay's peer id.
   *
   * Held in state because labels and roles are rendered, and mirrored into a
   * ref because the signaling callbacks need to read it synchronously — they
   * fire outside React's update cycle and a render-time snapshot would be a
   * message behind.
   */
  const [participantMap, setParticipantMap] = useState<Record<string, RemoteParticipant>>({})
  const rosterRef = useRef(new Map<string, RoomPeerInfo>())

  /** peerId → guestId, so an incoming stream lands on the right guest. */
  const peerToGuest = useRef(new Map<string, string>())

  /**
   * A fingerprint of the live camera/microphone captures.
   *
   * Used as an effect dependency so that a guest starting its camera *after*
   * connecting still has those tracks attached to the existing senders, rather
   * than silently sending nothing.
   */
  const liveStreamKeys = useSourceStore((state) =>
    Object.values(state.sources)
      .map((source) => source.streamKey)
      .filter((key): key is string => Boolean(key))
      .sort()
      .join('|'),
  )

  /**
   * `acceptOffer` is defined further down but is needed by the adapter
   * callback registered here. Routing through a ref keeps the callback
   * identity stable *and* always invokes the current implementation, which a
   * direct closure over a later `const` would not.
   */
  const acceptOfferRef = useRef<
    ((envelope: SignalEnvelope) => Promise<SignalEnvelope | null>) | null
  >(null)

  const handleOfferReceived = useCallback((envelope: SignalEnvelope) => {
    void acceptOfferRef.current?.(envelope)
  }, [])

  const handleAnswerReceived = useCallback((envelope: SignalEnvelope) => {
    void peerManager.acceptAnswer(envelope)
  }, [])

  /**
   * A peer announced by the room. Decide whether to offer to it.
   *
   * WHO OFFERS
   * ----------
   * Exactly one side must, or both create a connection and glare — two
   * half-negotiated peers and no media.
   *
   *  - **Director → guest.** The director has the initiative, because what it
   *    sends is categorically different (the composed program) and it is the
   *    one peer guaranteed to be in the room once.
   *  - **Guest → guest.** Neither has standing, so the tie is broken on peer
   *    id. Both sides run the same comparison and reach opposite conclusions,
   *    so precisely one offers — no handshake, no retry, no race. Relay ids
   *    are UUIDs, so a collision is not a case to handle.
   *  - **Guest → director.** Never; the director will offer.
   *
   * This is a full mesh between guests, which is what lets a room work with no
   * director in it at all. It is also why the guest count has a ceiling: every
   * guest encodes its camera once per peer. See README › Known limitations.
   */
  const handlePeerAvailable = useCallback(
    (peer: RoomPeerInfo) => {
      rosterRef.current.set(peer.peerId, peer)
      setParticipantMap((current) => ({
        ...current,
        [peer.peerId]: {
          peerId: peer.peerId,
          label: peer.label,
          role: peer.role,
          // Preserve anything that arrived before the announcement.
          stream: current[peer.peerId]?.stream ?? null,
          sharingScreen: current[peer.peerId]?.sharingScreen ?? false,
        },
      }))

      if (role === 'director') {
        // Two directors in one room is a misconfiguration, not a topology.
        if (peer.role === 'director') return
        void offerToRef.current?.(peer.peerId, peer.label)
        return
      }

      if (peer.role === 'director') return

      const me = localPeerIdRef.current()
      if (!me) return
      if (me > peer.peerId) void offerToRef.current?.(peer.peerId, peer.label)
    },
    [role],
  )

  /**
   * A peer the room says has left.
   *
   * Distinct from closing a connection: the participant is *gone*, so their
   * row goes too. Closing the peer alone left the row behind, and because the
   * relay assigns a fresh peer id on every join, the same person rejoining —
   * or simply reloading their tab — appended "Ana 2", then "Ana 3", each with
   * its own guest video source. The control room filled up with duplicates of
   * one guest.
   */
  const handlePeerGone = useCallback((peerId: string) => {
    rosterRef.current.delete(peerId)
    setParticipantMap((current) => {
      if (!current[peerId]) return current
      const next = { ...current }
      delete next[peerId]
      return next
    })
    void dropPeerRef.current?.(peerId)
  }, [])

  const handleRemoteCandidate = useCallback(
    (peerId: string, candidate: RTCIceCandidateInit) => {
      void peerManager.addRemoteCandidate(peerId, candidate)
    },
    [],
  )

  const signaling = useSignaling({
    onOffer: handleOfferReceived,
    onAnswer: handleAnswerReceived,
    onRemoteCandidate: handleRemoteCandidate,
    onPeerAvailable: handlePeerAvailable,
    onPeerGone: handlePeerGone,
  })

  /** Deferred implementations, for the stable callbacks above. */
  const offerToRef = useRef<((peerId: string, label: string) => Promise<void>) | null>(null)
  const dropPeerRef = useRef<((peerId: string) => void) | null>(null)

  /**
   * `useSignaling` returns a fresh object each render. Depending on it
   * directly below would reconfigure the peer manager on every render, so the
   * one method the manager needs is reached through a ref instead.
   */
  const publishRef = useRef(signaling.publish)
  publishRef.current = signaling.publish

  const sendCandidateRef = useRef(signaling.sendCandidate)
  sendCandidateRef.current = signaling.sendCandidate

  const localPeerIdRef = useRef(signaling.localPeerId)
  localPeerIdRef.current = signaling.localPeerId

  const trickle = signaling.capabilities.supportsTrickleIce

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
      trickle,
      resolveIceServers: () => turnSource.resolve(),
      events: {
        onLocalCandidate: (peerId, candidate) =>
          sendCandidateRef.current(peerId, candidate),
        onStateChange: (state) => {
          setPeerState(state)
          if (state.status === 'failed' && state.error) {
            showToast(state.error, 'error')
          }
        },
        onStats: (peerId, stats) => setPeerStats(peerId, stats),
        onControlState: (controlState) => setControlState(controlState),
        onControlMessage: (_peerId, message) => onControlMessageRef.current?.(message),
        onGuestMessage: (peerId, message) => {
          // The only guest-originated message that changes what the receiver
          // renders. The rest describe track state the control room shows.
          if (message.type !== 'sharing') return
          setParticipantMap((current) => {
            const existing = current[peerId]
            if (!existing) return current
            return { ...current, [peerId]: { ...existing, sharingScreen: message.sharing } }
          })
        },
        onRemoteStream: (peerId, stream) => {
          const known = rosterRef.current.get(peerId)

          /*
           * A participant is somebody the *room* told us about.
           *
           * The roster is the only source of identity — an SDP envelope does
           * not carry the sender's name or role — so a stream from a peer the
           * room never announced cannot be rendered as a person. That is not a
           * hypothetical: the manual transport has no roster at all, and since
           * every connection now declares send-capable m-lines up front, the
           * director's *empty* ones fire track events too. Without this the
           * control room appeared in the call as a phantom guest with no
           * video, which is exactly what a director should never be.
           */
          if (!known) return

          setParticipantMap((current) => ({
            ...current,
            [peerId]: {
              peerId,
              // The roster is the only source of a peer's name and role: an
              // SDP envelope does not carry the *sender's* identity, so a
              // stream on its own cannot say who it belongs to.
              label: known?.label ?? current[peerId]?.label ?? 'Guest',
              role: known?.role ?? current[peerId]?.role ?? 'guest',
              stream,
              sharingScreen: current[peerId]?.sharingScreen ?? false,
            },
          }))

          /*
           * Only a director turns an inbound stream into a *source*.
           *
           * A guest has no scenes, no mixer strip and no compositor to put one
           * in; doing it anyway would build a production model nothing renders
           * and add mixer channels whose audio is already playing through the
           * participant's own video element.
           */
          if (role !== 'director') return
          const guestId = peerToGuest.current.get(peerId)
          if (!guestId) return
          attachStream(guestId, stream)
        },
        onRemoteStreamEnded: (peerId) => {
          setParticipantMap((current) => {
            const existing = current[peerId]
            if (!existing) return current
            return { ...current, [peerId]: { ...existing, stream: null } }
          })
          if (role !== 'director') return
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
    setControlState,
    setPeerState,
    setPeerStats,
    showToast,
    trickle,
    turnSource,
    role,
  ])

  /**
   * Point the outgoing feed at whatever this role should send.
   *
   * `program` captures the composed canvas plus the mixed audio, so a guest
   * sees exactly what is being recorded. `camera` forwards the local camera and
   * microphone straight through, which is what a push view does.
   */
  useEffect(() => {
    if (send === 'none') {
      void peerManager.setLocalStream(null)
      return
    }

    if (send === 'camera') {
      /*
       * Build a stream from whatever captures are live. The tracks belong to
       * the StreamRegistry, so they are referenced here but never stopped —
       * the registry's refcount owns their lifetime.
       *
       * A shared screen *replaces* the camera rather than joining it. One
       * outgoing video track means no renegotiation with every peer in the
       * mesh when sharing starts, and no doubling of a guest's upload for the
       * duration. The visible trade is that a sharing guest's camera is not
       * going out, including into the director's program.
       */
      const outgoing = new MediaStream()
      const screenKey = streamRegistry
        .keys()
        .find((key) => key.startsWith('screen:'))
      const videoKey =
        screenKey ?? streamRegistry.keys().find((key) => key.startsWith('camera:'))

      const videoStream = videoKey ? streamRegistry.getStream(videoKey) : null
      for (const track of videoStream?.getVideoTracks() ?? []) outgoing.addTrack(track)

      for (const key of streamRegistry.keys()) {
        if (!key.startsWith('mic:')) continue
        const stream = streamRegistry.getStream(key)
        for (const track of stream?.getAudioTracks() ?? []) outgoing.addTrack(track)
      }

      void peerManager.setLocalStream(outgoing.getTracks().length > 0 ? outgoing : null)
      return () => {
        void peerManager.setLocalStream(null)
      }
    }

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
    // `liveStreamKeys` re-runs this when a capture starts or stops, so a guest
    // that enables its camera after connecting still gets it sent.
  }, [send, liveStreamKeys, sharingScreen])

  /**
   * Join the signaling room.
   *
   * Only meaningful for a transport with room support; `joinRoom` is a no-op
   * otherwise, so this needs no branch.
   */
  const leaveRoomRef = useRef(signaling.leaveRoom)
  leaveRoomRef.current = signaling.leaveRoom

  useEffect(() => {
    if (!room) return
    if (!signaling.capabilities.supportsRooms) return
    void signaling.joinRoom({ room, role, label })

    // Leaving on cleanup is what makes a guest's "Leave" visible upstream:
    // the room prop goes away, this effect tears down, and the relay tells the
    // director the peer is gone. Without it the guest vanished from their own
    // screen and lingered on the director's.
    return () => {
      void leaveRoomRef.current()
    }
    // `signaling` is rebuilt per render; the room identity is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, role, label, signaling.capabilities.supportsRooms])

  /**
   * Offer to a specific peer discovered through the room.
   *
   * Distinct from `createOffer`, which has no addressee and produces a code or
   * link for a human to carry.
   */
  const offerToPeer = useCallback(
    async (remotePeerId: string, remoteLabel: string) => {
      // A guest row belongs to the control room's production model. A guest
      // offering to another guest is a meeting participant, not a source.
      if (role === 'director') {
        const guest = addPeerGuest(remoteLabel)
        peerToGuest.current.set(remotePeerId, guest.id)
        bindPeer(guest.id, remotePeerId)
      }

      const result = await peerManager.createOfferTo(remotePeerId)
      if (!result) {
        showToast(`Could not create an offer for ${remoteLabel}.`, 'error')
        return
      }
    },
    [addPeerGuest, bindPeer, role, showToast],
  )

  const createOffer = useCallback(async (): Promise<SignalEnvelope | null> => {
    setBusy(true)
    try {
      // A guest row is created up front so the operator can see the pending
      // connection — its status stays honest ("awaiting signaling") until the
      // peer actually connects.
      const guest = addPeerGuest()
      const result = await peerManager.createOffer()
      if (!result) {
        showToast('An offer could not be created in this browser.', 'error')
        return null
      }
      peerToGuest.current.set(result.peerId, guest.id)
      bindPeer(guest.id, result.peerId)
      return result.envelope
    } finally {
      setBusy(false)
    }
  }, [addPeerGuest, bindPeer, showToast])

  const acceptOffer = useCallback(
    async (envelope: SignalEnvelope): Promise<SignalEnvelope | null> => {
      setBusy(true)
      try {
        const result = await peerManager.acceptOffer(envelope)
        if (!result) {
          showToast('That offer could not be applied.', 'error')
          return null
        }
        // Same asymmetry as `offerToPeer`: only a control room keeps a guest
        // row, because only a control room has a production to put it in.
        if (role === 'director') {
          const guest = addPeerGuest(envelope.label || 'Host')
          peerToGuest.current.set(result.peerId, guest.id)
          bindPeer(guest.id, result.peerId)
        }
        return result.envelope
      } finally {
        setBusy(false)
      }
    },
    [addPeerGuest, bindPeer, role, showToast],
  )

  // Publish the current implementations for the stable callbacks above.
  acceptOfferRef.current = acceptOffer
  offerToRef.current = offerToPeer

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

  const acceptAnswerInput = useCallback(
    async (raw: string) => {
      const result = await extractSignalFromText(raw, 'answer')
      if (result.status !== 'ok') {
        /*
         * Reported inline next to the paste box, not as a toast. The error is
         * about the contents of a specific field, so it belongs beside that
         * field — and showing it twice would just be noise.
         */
        signaling.setInputError(
          result.status === 'invalid' ? result.error : 'Paste the link or code before continuing.',
        )
        return
      }
      setBusy(true)
      try {
        const applied = await peerManager.acceptAnswer(result.signal.envelope)
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

  /**
   * Tell every peer whether this one is sharing a screen.
   *
   * Broadcast rather than sent per peer, and re-sent when the peer set
   * changes, because a participant who joins mid-share would otherwise lay out
   * a shared document as though it were a face until the sharer happened to
   * toggle.
   */
  const announceSharing = useCallback((sharing: boolean) => {
    peerManager.broadcastControl({ v: 1, type: 'sharing', sharing })
  }, [])

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

  /**
   * Retire a participant that left the room: connection *and* row.
   *
   * Falls back to closing just the peer when no guest is bound to it, so a
   * half-negotiated peer still gets cleaned up.
   */
  const dropPeer = useCallback(
    (peerId: string) => {
      const guestId = peerToGuest.current.get(peerId)
      peerToGuest.current.delete(peerId)
      if (!guestId) {
        closePeer(peerId)
        return
      }
      // `removeGuest` closes the peer, releases the guest's sources and its
      // mixer channel, and drops the row — the same path the operator's own
      // "Remove guest" takes, so there is one definition of gone.
      removeGuest(guestId)
    },
    [closePeer, removeGuest],
  )

  // Publish the implementation for the room's peer-left callback above.
  dropPeerRef.current = dropPeer

  const closeAll = useCallback(() => {
    for (const peerId of [...peerToGuest.current.keys()]) closePeer(peerId)
    peerManager.closeAll()
  }, [closePeer])

  // Close every peer when the studio unmounts.
  useEffect(
    () => () => {
      peerManager.closeAll()
      peerToGuest.current.clear()
    },
    [],
  )

  const participants = useMemo(() => Object.values(participantMap), [participantMap])

  return {
    supported: peerManager.isSupported(),
    peers: Object.values(peerStates),
    announceSharing,
    participants,
    connectivity,
    busy,
    signaling,
    createOffer,
    acceptOfferCode,
    acceptAnswerCode,
    acceptAnswerInput,
    acceptOfferEnvelope: acceptOffer,
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
