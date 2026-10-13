import type {
  IceServerConfig,
  PeerRole,
  PeerState,
  PeerStats,
  PeerStatus,
  SignalEnvelope,
} from '@/types/peer'
import type {
  AnyChannelMessage,
  ControlChannelState,
  ControlMessage,
  GuestMessage,
} from '@/types/room'
import { detectCapabilities } from '@/lib/capabilities'
import { createPeerId } from '@/utils/id'
import type { GatheringOutcome } from './ice'
import { buildPeerConfiguration, describeConnectivity, waitForIceGathering } from './ice'
import { CONTROL_CHANNEL_LABEL, ControlChannel } from './control-channel'
import { collectStats } from './stats'

/**
 * Peer connection lifecycle.
 *
 * Owns RTCPeerConnection instances and nothing else — no UI, no store, no
 * signaling transport. Signaling payloads go in and come out as
 * {@link SignalEnvelope}s, which the caller moves using whichever
 * `SignalingAdapter` is active.
 *
 * HONEST STATUS REPORTING
 * -----------------------
 * `status` becomes `'connected'` only when `RTCPeerConnection.connectionState`
 * reports `'connected'`. Creating an offer, exchanging codes, or having a
 * guest in the list never produces a connected status. Likewise `failed` is
 * reported as failed, with the ICE diagnosis attached, rather than retried
 * silently into a hopeful-looking state.
 */

export type PeerManagerEvents = {
  onStateChange: (state: PeerState) => void
  /**
   * A locally-discovered ICE candidate, for transports that can trickle.
   *
   * Only emitted when `trickle` is enabled; the manual path waits for
   * gathering to finish instead, because a copied link has nowhere to deliver
   * a candidate that turns up later.
   */
  onLocalCandidate: (peerId: string, candidate: RTCIceCandidateInit) => void
  /** A remote track arrived; the stream is ready to show and to mix. */
  onRemoteStream: (peerId: string, stream: MediaStream) => void
  /**
   * An outgoing track could not be attached to this peer's sender.
   *
   * Reported rather than swallowed because the consequence is invisible from
   * every other signal: the connection stays `connected`, stats keep flowing,
   * and the only symptom is that nobody can see you. Without this the operator
   * has nothing to go on.
   */
  onLocalTrackError: (peerId: string, message: string) => void
  onRemoteStreamEnded: (peerId: string) => void
  onLocalDescriptionReady: (envelope: SignalEnvelope, outcome: GatheringOutcome) => void
  onStats: (peerId: string, stats: PeerStats) => void
  /** The control channel opened, closed, or reported new latency/track state. */
  onControlState: (state: ControlChannelState) => void
  /** A director command arrived — only ever handled by a guest. */
  onControlMessage: (peerId: string, message: ControlMessage) => void
  /** A guest reported its own state — only ever handled by the director. */
  onGuestMessage: (peerId: string, message: GuestMessage) => void
}

type Peer = {
  id: string
  role: PeerRole
  pc: RTCPeerConnection
  state: PeerState
  remoteStream: MediaStream | null
  statsTimer: ReturnType<typeof setInterval> | null
  previousStatsSample: Parameters<typeof collectStats>[1]
  /** Director ↔ guest command path, alongside the media. */
  control: ControlChannel
  /** True once `setRemoteDescription` has succeeded. */
  hasRemoteDescription: boolean
  /** Candidates that arrived before the remote description was applied. */
  pendingCandidates: RTCIceCandidateInit[]
}

const STATS_INTERVAL_MS = 1000

/**
 * How many candidates to hold for a peer that does not exist yet.
 *
 * Generous relative to a real candidate set (a handful on a LAN, a few dozen
 * with several interfaces and a TURN server) but bounded, so a peer id that
 * never materializes cannot grow the buffer indefinitely.
 */
const MAX_EARLY_CANDIDATES = 64

/**
 * Statuses that describe progress *toward* a connection rather than its
 * outcome. They are only ever correct while the connection is still
 * undecided — see {@link PeerConnectionManager.setStatus}.
 */
const PROGRESS_STATUSES: ReadonlySet<PeerStatus> = new Set<PeerStatus>([
  'initializing',
  'waiting-for-answer',
  'connecting',
])

/**
 * True once `RTCPeerConnection` has decided.
 *
 * `disconnected` is deliberately absent: ICE often recovers from it, so it is
 * a transient state the studio reports as *reconnecting*, not a verdict.
 */
function isSettledConnection(state: RTCPeerConnectionState | null): boolean {
  return state === 'connected' || state === 'failed' || state === 'closed'
}

export class PeerConnectionManager {
  private readonly peers = new Map<string, Peer>()
  /** remote peerId -> candidates that arrived before the peer was created. */
  private readonly earlyCandidates = new Map<string, RTCIceCandidateInit[]>()
  private events: Partial<PeerManagerEvents> = {}
  private trickle = false
  private iceServerUrls: string[] = []
  private sessionId = ''
  private localLabel = 'Host'
  /** Tracks offered to every peer — the host's program feed. */
  private localStream: MediaStream | null = null
  /**
   * Short-lived TURN credentials fetched from the relay, if any.
   *
   * Held here rather than fetched in {@link createPeer} because constructing an
   * `RTCPeerConnection` is synchronous and its configuration is fixed at
   * construction — WebRTC offers no way to add an ICE server to a live
   * connection. So the fetch happens on the async path that precedes it.
   */
  private resolveIceServers: (() => Promise<IceServerConfig[]>) | null = null
  private resolvedIceServers: readonly IceServerConfig[] = []

  configure(options: {
    iceServerUrls: string[]
    sessionId: string
    localLabel: string
    /**
     * Emit candidates as they are found rather than waiting for gathering.
     * Requires a live signaling channel; see `SignalingCapabilities`.
     */
    trickle?: boolean
    /**
     * Supplies structured ICE servers — the relay-minted TURN credentials.
     * Expected to cache and to resolve `[]` rather than reject: no relay is a
     * degraded connection, not a failed one.
     */
    resolveIceServers?: () => Promise<IceServerConfig[]>
    events: Partial<PeerManagerEvents>
  }): void {
    this.iceServerUrls = options.iceServerUrls
    this.sessionId = options.sessionId
    this.localLabel = options.localLabel
    this.trickle = options.trickle ?? false
    this.events = options.events
    if (this.resolveIceServers !== (options.resolveIceServers ?? null)) {
      // A different resolver means a different relay; its grant does not
      // transfer, so drop what the previous one supplied.
      this.resolvedIceServers = []
    }
    this.resolveIceServers = options.resolveIceServers ?? null
  }

  /**
   * Refresh the ephemeral ICE servers before a connection is constructed.
   *
   * Awaited at the top of the offer and answer paths, so a credential fetch
   * delays a handshake by its own latency once and then not again — the
   * resolver caches. Never throws: a failure leaves the previous list (or an
   * empty one) in place and the connection proceeds STUN-only, which is a
   * weaker connection rather than no connection.
   */
  private async refreshIceServers(): Promise<void> {
    if (!this.resolveIceServers) return
    try {
      this.resolvedIceServers = await this.resolveIceServers()
    } catch {
      // The resolver is contracted to report its own errors to the operator;
      // re-reporting here would duplicate the toast.
    }
  }

  /**
   * Apply a trickled candidate from the remote side.
   *
   * Candidates race the handshake in two distinct ways, and both have to be
   * buffered or a connection path is silently lost:
   *
   *  1. The peer exists but has no remote description yet. Adding a candidate
   *     then throws `InvalidStateError`, so they queue on the peer.
   *  2. **The peer does not exist yet at all.** The offerer sends its
   *     description and its first candidates back-to-back, so on a fast link
   *     candidates can arrive while the answerer is still inside
   *     `acceptOffer`. Dropping those was a real intermittent failure: on a
   *     LAN there may be only one or two candidates, so losing them leaves the
   *     connection stuck in `connecting` until it fails outright.
   */
  async addRemoteCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) {
      this.bufferEarlyCandidate(peerId, candidate)
      return
    }

    if (!peer.hasRemoteDescription) {
      peer.pendingCandidates.push(candidate)
      return
    }
    await this.applyCandidate(peer, candidate)
  }

  /**
   * Hold a candidate for a peer that has not been created yet.
   *
   * Capped, and dropped oldest-first: a peer id that never materializes (a
   * guest that left mid-handshake, or a hostile sender) must not be able to
   * grow this without bound. Early candidates are the *first* ones gathered,
   * which on most networks are the host candidates — the ones most likely to
   * succeed — so keeping the earliest would be wrong only if the cap were
   * small enough to matter, and it is not.
   */
  private bufferEarlyCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    const queue = this.earlyCandidates.get(peerId) ?? []
    if (queue.length >= MAX_EARLY_CANDIDATES) queue.shift()
    queue.push(candidate)
    this.earlyCandidates.set(peerId, queue)
  }

  private async applyCandidate(peer: Peer, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await peer.pc.addIceCandidate(candidate)
    } catch {
      /*
       * A rejected candidate is survivable — it removes one possible path, not
       * the connection. Failing loudly here would turn a recoverable blip into
       * a reported error during an otherwise fine handshake.
       */
    }
  }

  /** Flush candidates that arrived before the remote description. */
  private async flushCandidates(peer: Peer): Promise<void> {
    const queued = peer.pendingCandidates.splice(0)
    for (const candidate of queued) await this.applyCandidate(peer, candidate)
  }

  isSupported(): boolean {
    return detectCapabilities().webRtc
  }

  /**
   * Set the stream sent to peers. Replacing it swaps tracks on existing
   * senders via `replaceTrack`, which avoids a renegotiation that manual
   * signaling cannot perform without another copy/paste round.
   */
  async setLocalStream(stream: MediaStream | null): Promise<void> {
    this.localStream = stream
    for (const peer of this.peers.values()) {
      await this.syncSenders(peer)
    }
  }

  getPeer(peerId: string): PeerState | null {
    return this.peers.get(peerId)?.state ?? null
  }

  /**
   * Send a command to a peer over the control channel.
   *
   * Returns false when the channel is not open, so the caller can tell the
   * operator the command did not reach the guest instead of optimistically
   * updating the UI.
   */
  sendControl(peerId: string, message: AnyChannelMessage): boolean {
    return this.peers.get(peerId)?.control.send(message) ?? false
  }

  /** Broadcast a message to every connected peer. Returns the delivered count. */
  broadcastControl(message: AnyChannelMessage): number {
    let delivered = 0
    for (const peer of this.peers.values()) {
      if (peer.control.send(message)) delivered += 1
    }
    return delivered
  }

  getControlState(peerId: string): ControlChannelState | null {
    return this.peers.get(peerId)?.control.getState() ?? null
  }

  isControlOpen(peerId: string): boolean {
    return this.peers.get(peerId)?.control.isOpen() ?? false
  }

  listPeers(): PeerState[] {
    return [...this.peers.values()].map((peer) => peer.state)
  }

  getRemoteStream(peerId: string): MediaStream | null {
    return this.peers.get(peerId)?.remoteStream ?? null
  }

  /**
   * Offer to a peer whose id the signaling transport already told us.
   *
   * The room-based path uses this: the relay assigns ids, so the connection is
   * keyed on the *remote* peer's id rather than one we invent. That is what
   * lets answers and candidates be routed back without any correlation step.
   */
  async createOfferTo(
    remotePeerId: string,
  ): Promise<{ peerId: string; envelope: SignalEnvelope } | null> {
    return this.createOfferInternal(remotePeerId)
  }

  /**
   * Create a peer as the host and produce an offer with ICE candidates
   * embedded (vanilla ICE — see `ice.ts` for why).
   */
  async createOffer(): Promise<{ peerId: string; envelope: SignalEnvelope } | null> {
    return this.createOfferInternal(createPeerId())
  }

  private async createOfferInternal(
    peerId: string,
  ): Promise<{ peerId: string; envelope: SignalEnvelope } | null> {
    if (!this.isSupported()) return null
    // Before `createPeer`: ICE servers cannot be added after construction.
    await this.refreshIceServers()
    const peer = this.createPeer(peerId, 'host')
    this.setStatus(peer, 'initializing')

    try {
      await this.syncSenders(peer)

      /*
       * Always declare **sendrecv** m-lines, even with nothing to send.
       *
       * This project never renegotiates — manual signaling could not do it
       * without another copy/paste round, and in a mesh it would mean a new
       * offer to every peer. So whatever m-lines exist at offer time are all
       * there will ever be, and a track that appears later can only be
       * attached by `replaceTrack` into an existing sender.
       *
       * `recvonly` made that impossible: a guest who joined with their camera
       * off, or who started sharing a screen afterwards, had no sender to put
       * the track into and nobody ever saw them.
       */
      ensureSendRecv(peer.pc)

      /*
       * The *offering* side creates the control channel, so its m-line is in
       * the offer and no second negotiation round is needed — which manual
       * signaling could not perform without another copy/paste. The answering
       * side picks it up through `ondatachannel`.
       */
      peer.control.attach(peer.pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }))

      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)

      /*
       * With trickle, the description goes out immediately and candidates
       * follow on the live channel — which is most of why a server-backed
       * connection comes up so much faster than the manual path.
       */
      const outcome = this.trickle
        ? immediateOutcome(peer.pc)
        : await waitForIceGathering(peer.pc)
      const envelope = this.toEnvelope(peer, 'offer', outcome.description.sdp)
      this.setStatus(peer, 'waiting-for-answer')
      this.events.onLocalDescriptionReady?.(envelope, outcome)
      return { peerId: peer.id, envelope }
    } catch (error) {
      this.failPeer(peer, describeError(error, 'The offer could not be created.'))
      return null
    }
  }

  /**
   * Accept a host's offer as the guest and produce an answer, again with
   * candidates embedded.
   */
  async acceptOffer(
    envelope: SignalEnvelope,
  ): Promise<{ peerId: string; envelope: SignalEnvelope } | null> {
    if (!this.isSupported()) return null
    await this.refreshIceServers()
    // Reuse the remote peer's id so both sides agree on the identifier.
    const peer = this.createPeer(envelope.peerId, 'guest')
    this.setStatus(peer, 'initializing')

    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: envelope.sdp })
      peer.hasRemoteDescription = true
      await this.flushCandidates(peer)
      /*
       * Answer sendrecv even when there is nothing to send yet.
       *
       * The transceivers here come from the offer. Left alone, an answerer
       * with no camera running answers `recvonly` and can never send anything
       * for the life of the connection — because there is no renegotiation to
       * change its mind later. Declaring the intent to send keeps the door
       * open for `replaceTrack`.
       */
      ensureSendRecv(peer.pc)
      await this.syncSenders(peer)

      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)

      const outcome = this.trickle
        ? immediateOutcome(peer.pc)
        : await waitForIceGathering(peer.pc)
      const answerEnvelope = this.toEnvelope(peer, 'answer', outcome.description.sdp)
      this.setStatus(peer, 'connecting')
      this.events.onLocalDescriptionReady?.(answerEnvelope, outcome)
      return { peerId: peer.id, envelope: answerEnvelope }
    } catch (error) {
      this.failPeer(
        peer,
        describeError(
          error,
          'The offer could not be applied. It may be truncated, or from an incompatible browser.',
        ),
      )
      return null
    }
  }

  /** Host side: apply the guest's answer and let connectivity checks run. */
  async acceptAnswer(envelope: SignalEnvelope): Promise<boolean> {
    const peer = this.peers.get(envelope.peerId) ?? this.findSoleHostPeer()
    if (!peer) {
      this.events.onStateChange?.({
        ...emptyState(envelope.peerId, 'host'),
        status: 'failed',
        error: 'No pending connection matches that answer code. Create a new offer and retry.',
      })
      return false
    }

    if (peer.pc.signalingState !== 'have-local-offer') {
      this.failPeer(
        peer,
        `This connection is not waiting for an answer (state: ${peer.pc.signalingState}). Create a new offer.`,
      )
      return false
    }

    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: envelope.sdp })
      peer.hasRemoteDescription = true
      await this.flushCandidates(peer)
      this.setStatus(peer, 'connecting')
      return true
    } catch (error) {
      this.failPeer(
        peer,
        describeError(error, 'The answer could not be applied. Copy the whole code and retry.'),
      )
      return false
    }
  }

  /** Close one peer and release everything it owns. */
  closePeer(peerId: string): void {
    this.earlyCandidates.delete(peerId)
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.peers.delete(peerId)
    this.stopStats(peer)

    peer.control.dispose()

    peer.pc.onicecandidate = null
    peer.pc.ondatachannel = null
    peer.pc.ontrack = null
    peer.pc.onconnectionstatechange = null
    peer.pc.oniceconnectionstatechange = null
    peer.pc.onicegatheringstatechange = null
    peer.pc.onsignalingstatechange = null

    try {
      peer.pc.close()
    } catch {
      // Already closed.
    }

    if (peer.remoteStream) {
      // Remote tracks are owned by the connection; stopping them locally just
      // releases our side of the decoder.
      for (const track of peer.remoteStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Already stopped.
        }
      }
      this.events.onRemoteStreamEnded?.(peerId)
    }

    peer.state = { ...peer.state, status: 'closed', connectedAt: null }
    this.events.onStateChange?.(peer.state)
  }

  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.closePeer(id)
    // Buffers for peers that never got created have nothing to close, so they
    // are dropped here rather than leaking until the next page load.
    this.earlyCandidates.clear()
  }

  private createPeer(peerId: string, role: PeerRole): Peer {
    const existing = this.peers.get(peerId)
    if (existing) this.closePeer(peerId)

    const pc = new RTCPeerConnection(
      buildPeerConfiguration(this.iceServerUrls, this.resolvedIceServers),
    )
    const control = new ControlChannel(peerId)
    control.setEvents({
      onStateChange: (state) => this.events.onControlState?.(state),
      onControl: (message) => this.events.onControlMessage?.(peerId, message),
      onGuestMessage: (message) => this.events.onGuestMessage?.(peerId, message),
    })

    const peer: Peer = {
      id: peerId,
      role,
      pc,
      state: emptyState(peerId, role),
      remoteStream: null,
      statsTimer: null,
      previousStatsSample: null,
      control,
      hasRemoteDescription: false,
      pendingCandidates: [],
    }
    // Anything that arrived while this peer was still being built. They are
    // put on the pending queue rather than applied, because the remote
    // description has not landed yet either.
    const early = this.earlyCandidates.get(peerId)
    if (early) {
      peer.pendingCandidates.push(...early)
      this.earlyCandidates.delete(peerId)
    }

    this.peers.set(peerId, peer)
    this.attachListeners(peer)
    return peer
  }

  private attachListeners(peer: Peer): void {
    const { pc } = peer

    // The answering side receives the channel the offerer created.
    pc.ondatachannel = (event: RTCDataChannelEvent) => {
      if (event.channel.label !== CONTROL_CHANNEL_LABEL) return
      peer.control.attach(event.channel)
    }

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!this.trickle) return
      // A null candidate is end-of-gathering; there is nothing to relay.
      if (!event.candidate) return
      this.events.onLocalCandidate?.(peer.id, event.candidate.toJSON())
    }

    pc.ontrack = (event: RTCTrackEvent) => {
      // `event.streams[0]` is the remote stream when the sender grouped its
      // tracks; otherwise synthesize one so the consumer always gets a stream.
      const stream = event.streams[0] ?? new MediaStream([event.track])
      peer.remoteStream = stream
      this.updateState(peer, {
        hasRemoteVideo: stream.getVideoTracks().length > 0,
        hasRemoteAudio: stream.getAudioTracks().length > 0,
      })
      event.track.addEventListener('ended', () => {
        const current = peer.remoteStream
        if (!current) return
        this.updateState(peer, {
          hasRemoteVideo: current.getVideoTracks().some((t) => t.readyState === 'live'),
          hasRemoteAudio: current.getAudioTracks().some((t) => t.readyState === 'live'),
        })
      })
      this.events.onRemoteStream?.(peer.id, stream)
    }

    pc.onconnectionstatechange = () => {
      const connectionState = pc.connectionState
      this.updateState(peer, { connectionState })

      switch (connectionState) {
        case 'connected':
          // The only place a peer is allowed to become 'connected'.
          this.setStatus(peer, 'connected')
          this.updateState(peer, { connectedAt: Date.now(), error: null })
          this.startStats(peer)
          break
        case 'connecting':
          this.setStatus(peer, 'connecting')
          break
        case 'disconnected':
          // 'disconnected' is often transient — ICE may recover on its own, so
          // this is reported as reconnecting rather than failed.
          this.setStatus(peer, 'reconnecting')
          break
        case 'failed':
          this.stopStats(peer)
          this.setStatus(peer, 'failed', describeIceFailure(peer.pc))
          break
        case 'closed':
          this.stopStats(peer)
          this.setStatus(peer, 'closed')
          break
        default:
          break
      }
    }

    pc.oniceconnectionstatechange = () => {
      this.updateState(peer, { iceConnectionState: pc.iceConnectionState })
    }
    pc.onicegatheringstatechange = () => {
      this.updateState(peer, { iceGatheringState: pc.iceGatheringState })
    }
    pc.onsignalingstatechange = () => {
      this.updateState(peer, { signalingState: pc.signalingState })
    }
  }

  /**
   * Make this peer's senders match `localStream`.
   * Uses `replaceTrack` on an existing sender where possible so no new
   * negotiation round is needed.
   */
  /**
   * Make this peer's senders match `localStream`.
   *
   * Transceivers are matched on the kind of their **m-line**, not on the kind
   * of whatever track they currently carry. That distinction is the whole
   * point: a sender with a null track has no `track.kind` to compare against,
   * so keying off it could never fill an empty sender — which is exactly the
   * state of a guest who joined with their camera off, or who is about to
   * start sharing a screen.
   *
   * `replaceTrack` is used throughout, so none of this renegotiates.
   */
  private async syncSenders(peer: Peer): Promise<void> {
    const stream = this.localStream

    for (const kind of ['video', 'audio'] as const) {
      const track = stream?.getTracks().find((t) => t.kind === kind) ?? null
      const transceiver = peer.pc
        .getTransceivers()
        .find((entry) => transceiverKind(entry) === kind)

      if (transceiver) {
        if (transceiver.sender.track !== track) {
          try {
            await transceiver.sender.replaceTrack(track)
          } catch (error) {
            /*
             * Leave the old track in place — better than dropping the sender —
             * but say so.
             *
             * Swallowing this was a genuine trap: `replaceTrack` is how every
             * later track attachment happens in this project (nothing
             * renegotiates), so a rejection here means a camera or screen
             * share that the sender believes is live and no peer can see. The
             * connection stays `connected` and the stats keep updating, so
             * there is no other signal that anything is wrong.
             */
            this.events.onLocalTrackError?.(
              peer.id,
              `Your ${kind} could not be sent to this peer: ${describeError(
                error,
                'replaceTrack was rejected.',
              )}`,
            )
          }
        }
        continue
      }
      if (track && stream) {
        try {
          peer.pc.addTrack(track, stream)
        } catch (error) {
          // Expected once the connection is closed; only worth reporting while
          // it is still open, where it means media genuinely failed to attach.
          if (peer.pc.connectionState !== 'closed') {
            this.events.onLocalTrackError?.(
              peer.id,
              `Your ${kind} could not be added to this peer: ${describeError(
                error,
                'addTrack failed.',
              )}`,
            )
          }
        }
      }
    }
  }

  private startStats(peer: Peer): void {
    this.stopStats(peer)
    peer.statsTimer = setInterval(() => {
      void collectStats(peer.pc, peer.previousStatsSample).then((result) => {
        peer.previousStatsSample = result.sample
        this.events.onStats?.(peer.id, result.stats)
      })
    }, STATS_INTERVAL_MS)
  }

  private stopStats(peer: Peer): void {
    if (peer.statsTimer === null) return
    clearInterval(peer.statsTimer)
    peer.statsTimer = null
  }

  /**
   * Move a peer's reported status.
   *
   * A *progress* status is dropped once the connection has already settled.
   * This is not cosmetic — it fixes a real stuck state:
   *
   *   `acceptAnswer` awaits `setRemoteDescription`, then reports `connecting`.
   *   With trickle ICE on a fast network the candidates are already in flight,
   *   so `connectionState` can reach `connected` *during* that await. The
   *   optimistic `connecting` then lands afterwards and overwrites it — and
   *   because the peer is already connected it fires no further
   *   `connectionstatechange`, so nothing ever corrects it. The connection
   *   works, media flows, and the control room says "Connecting" forever.
   *
   * Settled statuses always win, because they are the ones
   * `RTCPeerConnection` itself justifies.
   */
  private setStatus(peer: Peer, status: PeerStatus, error?: string): void {
    if (PROGRESS_STATUSES.has(status) && isSettledConnection(peer.pc.connectionState)) return
    this.updateState(peer, { status, ...(error !== undefined ? { error } : {}) })
  }

  private failPeer(peer: Peer, message: string): void {
    this.setStatus(peer, 'failed', message)
  }

  private updateState(peer: Peer, patch: Partial<PeerState>): void {
    peer.state = { ...peer.state, ...patch }
    this.events.onStateChange?.(peer.state)
  }

  private toEnvelope(peer: Peer, kind: 'offer' | 'answer', sdp: string): SignalEnvelope {
    return {
      v: 1,
      kind,
      peerId: peer.id,
      sessionId: this.sessionId,
      sdp,
      label: this.localLabel,
      createdAt: Date.now(),
    }
  }

  /**
   * Manual signaling loses the peer id if the user regenerates an offer, so
   * fall back to the single pending host peer when there is exactly one.
   */
  private findSoleHostPeer(): Peer | null {
    const candidates = [...this.peers.values()].filter(
      (peer) => peer.role === 'host' && peer.pc.signalingState === 'have-local-offer',
    )
    return candidates.length === 1 ? (candidates[0] ?? null) : null
  }
}

/**
 * A gathering "outcome" for the trickle path.
 *
 * Shaped like the vanilla-ICE result so callers and the connectivity readout
 * need no special case, but reports `complete: false` and whatever candidates
 * happen to be in the SDP already — which is honest: gathering really is still
 * in progress, and the rest arrive separately.
 */
function immediateOutcome(pc: RTCPeerConnection): GatheringOutcome {
  const description = pc.localDescription
  const sdp = description?.sdp ?? ''
  return {
    description: description as RTCSessionDescription,
    complete: false,
    candidateCount: (sdp.match(/^a=candidate:/gm) ?? []).length,
    elapsedMs: 0,
    hasPublicCandidate: /^a=candidate:.* typ (srflx|relay)/m.test(sdp),
  }
}

/**
 * Explain an ICE failure in terms of what was actually gathered.
 *
 * A flat "symmetric NAT, you need TURN" is right often enough to be useless:
 * it reads the same whether a relay was configured and still failed, or no
 * relay was ever offered, or the two sides never got past host candidates. The
 * local description says which of those happened, so the message says it too —
 * and names the one setting that fixes the common case.
 */
function describeIceFailure(pc: RTCPeerConnection): string {
  const sdp = pc.localDescription?.sdp ?? ''
  const relay = /^a=candidate:.* typ relay/m.test(sdp)
  const publicAddress = /^a=candidate:.* typ (srflx|relay)/m.test(sdp)

  if (relay) {
    return (
      'ICE connectivity checks failed even with a TURN relay among the candidates. The relay ' +
      'itself is the thing to check: confirm the credentials are current, that its TCP/TLS port ' +
      'is reachable from both networks, and that it is not rejecting allocations.'
    )
  }
  if (publicAddress) {
    return (
      'ICE connectivity checks failed. Both sides found their public address but could not reach ' +
      'each other, which is what symmetric NAT or a firewall blocking UDP looks like. Only a TURN ' +
      'relay traverses that — add one under Settings › ICE servers as ' +
      'turn:host:port|username:password, or set VITE_TURN_URLS for every device at once.'
    )
  }
  return (
    'ICE connectivity checks failed, and only local-network candidates were gathered — no public ' +
    'address was discovered at all. This connection can only work between devices on the same ' +
    'network. Check that STUN is reachable under Settings › ICE servers, and add a TURN relay ' +
    'for connections across networks.'
  )
}

/**
 * The media kind of a transceiver's m-line.
 *
 * `sender.track` is null on an empty sender and `receiver.track` is null
 * before the remote description lands, so neither alone is reliable — but at
 * least one is always present once a transceiver exists. `mid` is not usable
 * for this: it identifies the m-line, not what kind it is.
 */
function transceiverKind(transceiver: RTCRtpTransceiver): string | null {
  return transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind ?? null
}

/**
 * Declare both m-lines, and declare them send-capable.
 *
 * Idempotent: existing transceivers are upgraded in place rather than
 * duplicated, so calling it on an answer does not add a second video m-line.
 */
function ensureSendRecv(pc: RTCPeerConnection): void {
  for (const kind of ['video', 'audio'] as const) {
    const existing = pc.getTransceivers().find((entry) => transceiverKind(entry) === kind)
    if (existing) {
      if (existing.direction === 'recvonly' || existing.direction === 'inactive') {
        existing.direction = 'sendrecv'
      }
      continue
    }
    pc.addTransceiver(kind, { direction: 'sendrecv' })
  }
}

function emptyState(peerId: string, role: PeerRole): PeerState {
  return {
    peerId,
    role,
    status: 'initializing',
    connectionState: null,
    iceConnectionState: null,
    iceGatheringState: null,
    signalingState: null,
    error: null,
    hasRemoteVideo: false,
    hasRemoteAudio: false,
    connectedAt: null,
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return `${fallback} (${error.message})`
  return fallback
}

export { describeConnectivity }
export const peerManager = new PeerConnectionManager()
