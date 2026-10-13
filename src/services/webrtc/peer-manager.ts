import type { PeerRole, PeerState, PeerStats, PeerStatus, SignalEnvelope } from '@/types/peer'
import { detectCapabilities } from '@/lib/capabilities'
import { createPeerId } from '@/utils/id'
import type { GatheringOutcome } from './ice'
import { buildPeerConfiguration, describeConnectivity, waitForIceGathering } from './ice'
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
  /** A remote track arrived; the stream is ready to show and to mix. */
  onRemoteStream: (peerId: string, stream: MediaStream) => void
  onRemoteStreamEnded: (peerId: string) => void
  onLocalDescriptionReady: (envelope: SignalEnvelope, outcome: GatheringOutcome) => void
  onStats: (peerId: string, stats: PeerStats) => void
}

type Peer = {
  id: string
  role: PeerRole
  pc: RTCPeerConnection
  state: PeerState
  remoteStream: MediaStream | null
  statsTimer: ReturnType<typeof setInterval> | null
  previousStatsSample: Parameters<typeof collectStats>[1]
}

const STATS_INTERVAL_MS = 1000

export class PeerConnectionManager {
  private readonly peers = new Map<string, Peer>()
  private events: Partial<PeerManagerEvents> = {}
  private iceServerUrls: string[] = []
  private sessionId = ''
  private localLabel = 'Host'
  /** Tracks offered to every peer — the host's program feed. */
  private localStream: MediaStream | null = null

  configure(options: {
    iceServerUrls: string[]
    sessionId: string
    localLabel: string
    events: Partial<PeerManagerEvents>
  }): void {
    this.iceServerUrls = options.iceServerUrls
    this.sessionId = options.sessionId
    this.localLabel = options.localLabel
    this.events = options.events
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

  listPeers(): PeerState[] {
    return [...this.peers.values()].map((peer) => peer.state)
  }

  getRemoteStream(peerId: string): MediaStream | null {
    return this.peers.get(peerId)?.remoteStream ?? null
  }

  /**
   * Create a peer as the host and produce an offer with ICE candidates
   * embedded (vanilla ICE — see `ice.ts` for why).
   */
  async createOffer(): Promise<{ peerId: string; envelope: SignalEnvelope } | null> {
    if (!this.isSupported()) return null
    const peer = this.createPeer(createPeerId(), 'host')
    this.setStatus(peer, 'initializing')

    try {
      await this.syncSenders(peer)

      // Even with no local tracks we must declare receive-capable m-lines, or
      // the guest's media has nowhere to land in the answer.
      if (peer.pc.getTransceivers().length === 0) {
        peer.pc.addTransceiver('video', { direction: 'recvonly' })
        peer.pc.addTransceiver('audio', { direction: 'recvonly' })
      }

      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)

      const outcome = await waitForIceGathering(peer.pc)
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
    // Reuse the remote peer's id so both sides agree on the identifier.
    const peer = this.createPeer(envelope.peerId, 'guest')
    this.setStatus(peer, 'initializing')

    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: envelope.sdp })
      await this.syncSenders(peer)

      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)

      const outcome = await waitForIceGathering(peer.pc)
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
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.peers.delete(peerId)
    this.stopStats(peer)

    peer.pc.onicecandidate = null
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
  }

  /**
   * Inject a disconnect, for the demo panel's "guest disconnect" simulation.
   * This drives the *real* close path so the UI transition is genuine; the
   * caller is responsible for labelling it as simulated.
   */
  simulateDisconnect(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.setStatus(peer, 'failed', 'Connection lost (simulated from the demo panel).')
    this.closePeer(peerId)
  }

  private createPeer(peerId: string, role: PeerRole): Peer {
    const existing = this.peers.get(peerId)
    if (existing) this.closePeer(peerId)

    const pc = new RTCPeerConnection(buildPeerConfiguration(this.iceServerUrls))
    const peer: Peer = {
      id: peerId,
      role,
      pc,
      state: emptyState(peerId, role),
      remoteStream: null,
      statsTimer: null,
      previousStatsSample: null,
    }
    this.peers.set(peerId, peer)
    this.attachListeners(peer)
    return peer
  }

  private attachListeners(peer: Peer): void {
    const { pc } = peer

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
          this.setStatus(
            peer,
            'failed',
            'ICE connectivity checks failed. Both peers gathered candidates but could not reach ' +
              'each other. This usually means symmetric NAT or a firewall blocking UDP, which ' +
              'requires a TURN relay to traverse.',
          )
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
  private async syncSenders(peer: Peer): Promise<void> {
    const stream = this.localStream
    const senders = peer.pc.getSenders()

    for (const kind of ['video', 'audio'] as const) {
      const track = stream?.getTracks().find((t) => t.kind === kind) ?? null
      const sender = senders.find((s) => s.track?.kind === kind) ?? null

      if (sender) {
        if (sender.track !== track) {
          try {
            await sender.replaceTrack(track)
          } catch {
            // replaceTrack can reject if the codecs are incompatible. Leaving
            // the old track in place is better than dropping the sender.
          }
        }
        continue
      }
      if (track && stream) {
        try {
          peer.pc.addTrack(track, stream)
        } catch {
          // addTrack throws after the connection is closed; ignore.
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

  private setStatus(peer: Peer, status: PeerStatus, error?: string): void {
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
