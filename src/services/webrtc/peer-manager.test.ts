import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerState } from '@/types/peer'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { PeerConnectionManager } from './peer-manager'
import { createFakeStream } from '@/test/setup'

/**
 * Peer lifecycle and — most importantly — honest status reporting.
 *
 * SCOPE: this drives a scripted RTCPeerConnection double. It proves that the
 * manager only reports `connected` when `connectionState` says so, that
 * failures carry an explanation, and that peers are cleaned up. It proves
 * nothing about real-world NAT traversal, which cannot be established from a
 * mock — see README › Testing strategy.
 */

const SDP_OFFER = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=candidate:1 1 udp 1 1.2.3.4 1 typ srflx'].join(
  '\r\n',
)

/**
 * A data channel stub.
 *
 * The manager creates a control channel inside `createOffer`, so one has to
 * exist for the offer path to run at all. It opens on the next tick, which is
 * close enough to the real asynchronous open for these state-machine tests.
 */
class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly sent: string[] = []

  readonly label: string

  constructor(label: string) {
    this.label = label
    queueMicrotask(() => {
      this.readyState = 'open'
      this.onopen?.()
    })
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('channel not open')
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 'closed'
    this.onclose?.()
  }
}

type FakePeer = {
  appliedCandidates: RTCIceCandidateInit[]
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  iceGatheringState: RTCIceGatheringState
  signalingState: RTCSignalingState
  localDescription: RTCSessionDescription | null
  onconnectionstatechange: (() => void) | null
  ontrack: ((event: RTCTrackEvent) => void) | null
  transition: (state: RTCPeerConnectionState) => void
  emitTrack: (stream: MediaStream) => void
}

let peers: FakePeer[] = []
/** Set by a test to make createOffer reject. */
let offerRejects = false
/** Set by a test to make setRemoteDescription reject. */
let remoteDescriptionRejects = false
/**
 * Set by a test to have the connection reach `connected` *during*
 * `setRemoteDescription`, which is what a fast trickle-ICE link really does.
 */
let connectDuringRemoteDescription = false

function installPeerConnection() {
  peers = []
  offerRejects = false
  remoteDescriptionRejects = false
  connectDuringRemoteDescription = false

  class FakeRTCPeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = 'new'
    iceConnectionState: RTCIceConnectionState = 'new'
    // 'complete' so waitForIceGathering resolves immediately.
    iceGatheringState: RTCIceGatheringState = 'complete'
    signalingState: RTCSignalingState = 'stable'
    localDescription: RTCSessionDescription | null = null
    onconnectionstatechange: (() => void) | null = null
    oniceconnectionstatechange: (() => void) | null = null
    onicegatheringstatechange: (() => void) | null = null
    onsignalingstatechange: (() => void) | null = null
    onicecandidate: (() => void) | null = null
    ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
    ontrack: ((event: RTCTrackEvent) => void) | null = null
    channels: FakeDataChannel[] = []

    private senders: RTCRtpSender[] = []
    private transceivers: RTCRtpTransceiver[] = []

    constructor() {
      super()
      peers.push(this as unknown as FakePeer)
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      if (offerRejects) throw new Error('createOffer failed')
      return { type: 'offer', sdp: SDP_OFFER }
    }
    async createAnswer(): Promise<RTCSessionDescriptionInit> {
      return { type: 'answer', sdp: SDP_OFFER }
    }
    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = description as RTCSessionDescription
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
      this.onsignalingstatechange?.()
    }
    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      if (remoteDescriptionRejects) throw new Error('invalid SDP')
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
      this.onsignalingstatechange?.()
      if (connectDuringRemoteDescription) {
        // The candidates were already in flight, so ICE completes before the
        // caller resumes after this await.
        this.transition('connected')
      }
    }
    /** Test helper: candidates this connection was actually given. */
    readonly appliedCandidates: RTCIceCandidateInit[] = []
    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
      this.appliedCandidates.push(candidate)
    }

    createDataChannel(label: string): RTCDataChannel {
      const channel = new FakeDataChannel(label)
      this.channels.push(channel)
      return channel as unknown as RTCDataChannel
    }

    addTrack(track: MediaStreamTrack): RTCRtpSender {
      const sender = { track, replaceTrack: async () => {} } as unknown as RTCRtpSender
      this.senders.push(sender)
      return sender
    }
    getSenders(): RTCRtpSender[] {
      return this.senders
    }
    addTransceiver(kind: string): RTCRtpTransceiver {
      const transceiver = { direction: 'recvonly', kind } as unknown as RTCRtpTransceiver
      this.transceivers.push(transceiver)
      return transceiver
    }
    getTransceivers(): RTCRtpTransceiver[] {
      return this.transceivers
    }
    async getStats(): Promise<RTCStatsReport> {
      return new Map() as unknown as RTCStatsReport
    }
    close(): void {
      this.connectionState = 'closed'
    }

    /** Test helper: drive a connection-state change. */
    transition(state: RTCPeerConnectionState): void {
      this.connectionState = state
      this.onconnectionstatechange?.()
    }
    /** Test helper: deliver a remote stream. */
    emitTrack(stream: MediaStream): void {
      const track = stream.getTracks()[0]!
      this.ontrack?.({ streams: [stream], track } as unknown as RTCTrackEvent)
    }
  }

  vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection)
  resetCapabilitiesCache()
}

let manager: PeerConnectionManager
let states: PeerState[]

beforeEach(() => {
  installPeerConnection()
  manager = new PeerConnectionManager()
  states = []
  manager.configure({
    iceServerUrls: ['stun:stun.example:3478'],
    sessionId: 'abc123',
    localLabel: 'Host',
    events: { onStateChange: (state) => states.push(state) },
  })
})

afterEach(() => {
  manager.closeAll()
  vi.unstubAllGlobals()
  resetCapabilitiesCache()
})

const lastState = () => states[states.length - 1]!

describe('createOffer', () => {
  it('produces an offer envelope with candidates embedded', async () => {
    const result = await manager.createOffer()
    expect(result).not.toBeNull()
    expect(result!.envelope.kind).toBe('offer')
    expect(result!.envelope.sdp).toContain('a=candidate:')
    expect(result!.envelope.sessionId).toBe('abc123')
    expect(result!.envelope.label).toBe('Host')
  })

  it('moves to waiting-for-answer, not connected', async () => {
    await manager.createOffer()
    // Creating an offer must never imply a connection.
    expect(lastState().status).toBe('waiting-for-answer')
  })

  it('declares receive-capable transceivers when there is no local stream', async () => {
    await manager.createOffer()
    // Without these, a guest's media would have nowhere to land.
    expect(peers[0]).toBeDefined()
    expect((peers[0] as unknown as RTCPeerConnection).getTransceivers()).toHaveLength(2)
  })

  it('adds the local stream’s tracks as senders when one is set', async () => {
    await manager.setLocalStream(createFakeStream(['video', 'audio']))
    await manager.createOffer()
    expect((peers[0] as unknown as RTCPeerConnection).getSenders().length).toBeGreaterThan(0)
  })

  it('fails with an explanation when createOffer rejects', async () => {
    offerRejects = true
    const result = await manager.createOffer()
    expect(result).toBeNull()
    expect(lastState().status).toBe('failed')
    expect(lastState().error).toMatch(/offer could not be created/i)
  })

  it('reports unsupported when RTCPeerConnection is absent', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined)
    resetCapabilitiesCache()
    expect(manager.isSupported()).toBe(false)
    expect(await manager.createOffer()).toBeNull()
  })
})

describe('acceptOffer', () => {
  const offerEnvelope = {
    v: 1 as const,
    kind: 'offer' as const,
    peerId: 'peer_remote',
    sessionId: 'abc123',
    sdp: SDP_OFFER,
    label: 'Remote host',
    createdAt: Date.now(),
  }

  it('produces an answer and reuses the remote peer id', async () => {
    const result = await manager.acceptOffer(offerEnvelope)
    expect(result).not.toBeNull()
    expect(result!.peerId).toBe('peer_remote')
    expect(result!.envelope.kind).toBe('answer')
  })

  it('moves to connecting, not connected', async () => {
    await manager.acceptOffer(offerEnvelope)
    expect(lastState().status).toBe('connecting')
  })

  it('fails with a usable message on an invalid offer', async () => {
    remoteDescriptionRejects = true
    const result = await manager.acceptOffer(offerEnvelope)
    expect(result).toBeNull()
    expect(lastState().status).toBe('failed')
    expect(lastState().error).toMatch(/truncated|incompatible/i)
  })
})

describe('trickled candidates', () => {
  const offerEnvelope = {
    v: 1 as const,
    kind: 'offer' as const,
    peerId: 'peer_remote',
    sessionId: 'abc123',
    sdp: SDP_OFFER,
    label: 'Remote host',
    createdAt: Date.now(),
  }

  const candidate = (ip: string): RTCIceCandidateInit => ({
    candidate: `candidate:1 1 udp 1 ${ip} 1 typ host`,
    sdpMid: '0',
    sdpMLineIndex: 0,
  })

  /**
   * The regression this exists for.
   *
   * The offerer sends its description and its first candidates back-to-back,
   * so with a live signaling channel the candidates can land while the
   * answerer is still inside `acceptOffer` and its peer does not exist yet.
   * Dropping them cost real connections: on a LAN there may be only one or two
   * candidates, so losing them leaves the peer stuck in `connecting`.
   */
  it('buffers candidates that arrive before the peer exists, then applies them', async () => {
    await manager.addRemoteCandidate('peer_remote', candidate('10.0.0.1'))
    await manager.addRemoteCandidate('peer_remote', candidate('10.0.0.2'))

    await manager.acceptOffer(offerEnvelope)

    expect(peers[0]!.appliedCandidates.map((entry) => entry.candidate)).toEqual([
      candidate('10.0.0.1').candidate,
      candidate('10.0.0.2').candidate,
    ])
  })

  it('applies a candidate that arrives after the remote description', async () => {
    await manager.acceptOffer(offerEnvelope)
    await manager.addRemoteCandidate('peer_remote', candidate('10.0.0.3'))

    expect(peers[0]!.appliedCandidates).toHaveLength(1)
  })

  it('discards buffered candidates for a peer that never connects', async () => {
    await manager.addRemoteCandidate('peer_ghost', candidate('10.0.0.9'))
    manager.closeAll()

    // Accepting an offer from that id afterwards must not resurrect stale
    // candidates belonging to an abandoned handshake.
    await manager.acceptOffer({ ...offerEnvelope, peerId: 'peer_ghost' })
    expect(peers[0]!.appliedCandidates).toHaveLength(0)
  })

  it('ignores a candidate for an unknown peer without throwing', async () => {
    await expect(
      manager.addRemoteCandidate('peer_nobody', candidate('10.0.0.4')),
    ).resolves.toBeUndefined()
  })
})

describe('acceptAnswer', () => {
  it('applies an answer to the pending offer', async () => {
    const offer = await manager.createOffer()
    const applied = await manager.acceptAnswer({
      v: 1,
      kind: 'answer',
      peerId: offer!.peerId,
      sessionId: 'abc123',
      sdp: SDP_OFFER,
      label: 'Guest',
      createdAt: Date.now(),
    })
    expect(applied).toBe(true)
    expect(lastState().status).toBe('connecting')
  })

  it('matches the sole pending host peer when the id does not line up', async () => {
    // Manual signaling loses the peer id if the host regenerates an offer.
    await manager.createOffer()
    const applied = await manager.acceptAnswer({
      v: 1,
      kind: 'answer',
      peerId: 'peer_mismatched',
      sessionId: 'abc123',
      sdp: SDP_OFFER,
      label: 'Guest',
      createdAt: Date.now(),
    })
    expect(applied).toBe(true)
  })

  it('reports a failure when no offer is pending', async () => {
    const applied = await manager.acceptAnswer({
      v: 1,
      kind: 'answer',
      peerId: 'peer_unknown',
      sessionId: 'abc123',
      sdp: SDP_OFFER,
      label: 'Guest',
      createdAt: Date.now(),
    })
    expect(applied).toBe(false)
    expect(lastState().status).toBe('failed')
    expect(lastState().error).toMatch(/no pending connection/i)
  })
})

describe('a connection that completes mid-handshake', () => {
  /**
   * The regression this exists for.
   *
   * `acceptAnswer` reports `connecting` after awaiting
   * `setRemoteDescription`. With trickle ICE the connection can reach
   * `connected` during that await — and since a connected peer fires no
   * further `connectionstatechange`, an optimistic `connecting` written
   * afterwards is never corrected. The control room showed "Connecting"
   * forever for a connection that was working.
   */
  it('does not let a late progress status overwrite connected', async () => {
    const offer = await manager.createOffer()
    connectDuringRemoteDescription = true

    const applied = await manager.acceptAnswer({
      v: 1 as const,
      kind: 'answer' as const,
      peerId: offer!.peerId,
      sessionId: 'abc123',
      sdp: SDP_OFFER,
      label: 'Guest',
      createdAt: Date.now(),
    })

    expect(applied).toBe(true)
    expect(lastState().status).toBe('connected')
    expect(lastState().connectionState).toBe('connected')
  })

  it('still reports connecting when the connection has not settled', async () => {
    const offer = await manager.createOffer()

    await manager.acceptAnswer({
      v: 1 as const,
      kind: 'answer' as const,
      peerId: offer!.peerId,
      sessionId: 'abc123',
      sdp: SDP_OFFER,
      label: 'Guest',
      createdAt: Date.now(),
    })

    expect(lastState().status).toBe('connecting')
  })

  it('a failed connection is not walked back to connecting either', async () => {
    const offer = await manager.createOffer()
    peers[0]!.transition('failed')

    await manager.acceptAnswer({
      v: 1 as const,
      kind: 'answer' as const,
      peerId: offer!.peerId,
      sessionId: 'abc123',
      sdp: SDP_OFFER,
      label: 'Guest',
      createdAt: Date.now(),
    })

    expect(lastState().status).toBe('failed')
  })
})

describe('connection state reporting', () => {
  it('only reports connected when connectionState says connected', async () => {
    await manager.createOffer()
    expect(lastState().status).not.toBe('connected')

    peers[0]!.transition('connecting')
    expect(lastState().status).toBe('connecting')

    peers[0]!.transition('connected')
    expect(lastState().status).toBe('connected')
    expect(lastState().connectedAt).toBeTypeOf('number')
  })

  it('treats a transient disconnect as reconnecting, not failed', async () => {
    await manager.createOffer()
    peers[0]!.transition('connected')
    peers[0]!.transition('disconnected')
    // ICE may recover on its own, so this is not a terminal failure.
    expect(lastState().status).toBe('reconnecting')
  })

  it('explains a failure in terms of NAT and firewalls', async () => {
    await manager.createOffer()
    peers[0]!.transition('failed')

    expect(lastState().status).toBe('failed')
    expect(lastState().error).toMatch(/connectivity checks failed/i)
    expect(lastState().error).toMatch(/TURN/i)
  })

  it('reports closed', async () => {
    await manager.createOffer()
    peers[0]!.transition('closed')
    expect(lastState().status).toBe('closed')
  })
})

describe('remote media', () => {
  it('reports the incoming stream and its track kinds', async () => {
    const onRemoteStream = vi.fn()
    manager.configure({
      iceServerUrls: [],
      sessionId: 'abc123',
      localLabel: 'Host',
      events: { onStateChange: (state) => states.push(state), onRemoteStream },
    })

    const offer = await manager.createOffer()
    const stream = createFakeStream(['video', 'audio'])
    peers[0]!.emitTrack(stream)

    expect(onRemoteStream).toHaveBeenCalledWith(offer!.peerId, stream)
    expect(lastState().hasRemoteVideo).toBe(true)
    expect(lastState().hasRemoteAudio).toBe(true)
    expect(manager.getRemoteStream(offer!.peerId)).toBe(stream)
  })

  it('reports audio-only remote media accurately', async () => {
    await manager.createOffer()
    peers[0]!.emitTrack(createFakeStream(['audio']))
    expect(lastState().hasRemoteVideo).toBe(false)
    expect(lastState().hasRemoteAudio).toBe(true)
  })
})

describe('teardown', () => {
  it('closes a peer and reports it as closed', async () => {
    const offer = await manager.createOffer()
    manager.closePeer(offer!.peerId)

    expect(manager.getPeer(offer!.peerId)).toBeNull()
    expect(lastState().status).toBe('closed')
  })

  it('stops remote tracks when closing', async () => {
    const offer = await manager.createOffer()
    const stream = createFakeStream(['video'])
    peers[0]!.emitTrack(stream)

    manager.closePeer(offer!.peerId)
    expect(stream.getVideoTracks()[0]?.readyState).toBe('ended')
  })

  it('notifies that the remote stream ended', async () => {
    const onRemoteStreamEnded = vi.fn()
    manager.configure({
      iceServerUrls: [],
      sessionId: 'abc',
      localLabel: 'Host',
      events: { onStateChange: (state) => states.push(state), onRemoteStreamEnded },
    })
    const offer = await manager.createOffer()
    peers[0]!.emitTrack(createFakeStream(['video']))
    manager.closePeer(offer!.peerId)
    expect(onRemoteStreamEnded).toHaveBeenCalledWith(offer!.peerId)
  })

  it('closes every peer', async () => {
    await manager.createOffer()
    await manager.createOffer()
    expect(manager.listPeers()).toHaveLength(2)

    manager.closeAll()
    expect(manager.listPeers()).toHaveLength(0)
  })

  it('tolerates closing an unknown peer', () => {
    expect(() => manager.closePeer('peer_ghost')).not.toThrow()
  })
})
