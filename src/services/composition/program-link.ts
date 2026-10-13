/**
 * Mirror the program output into another window of the same browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/scene/:room` is the OBS integration point: a window containing nothing but
 * the composed program, which you point a window-capture source at. It used to
 * run its own compositor over the room's *saved* scenes — and that cannot work
 * for live media, because a `MediaStream` belongs to the browsing context that
 * created it. Streams are deliberately never persisted (see README ›
 * Persistence), so the scene window loaded the source *definitions* with
 * `streamKey: null` and drew nothing. Cameras, screen shares and guests were
 * all simply absent: a black window where the program should be.
 *
 * HOW
 * ---
 * Two same-origin windows cannot pass a `MediaStream` to each other, but they
 * can both talk to a `BroadcastChannel`, and a `BroadcastChannel` can carry
 * SDP. So the director publishes its program over a **loopback
 * RTCPeerConnection** and the scene window subscribes. The handshake is
 * local-only: no signaling server, no STUN, no network — host candidates
 * between two contexts on the same machine always match.
 *
 * The scene window therefore shows the *actual* program pixels, including live
 * camera, screen share and guests, rather than a second-hand reconstruction.
 * It is a true mirror.
 *
 * WHAT IT IS NOT
 * --------------
 * Still not an independent process: the pixels originate in the director's
 * compositor, so closing the control room stops the mirror. The subscriber
 * reports that rather than freezing on a stale frame.
 */

export type ProgramLinkMessage =
  /** A subscriber announcing itself and asking to be offered a connection. */
  | { type: 'hello'; from: string }
  /** A publisher announcing itself, so waiting subscribers re-ask. */
  | { type: 'publisher-online' }
  | { type: 'offer'; to: string; sdp: string }
  | { type: 'answer'; from: string; sdp: string }
  | { type: 'candidate'; from: string; to: string; candidate: RTCIceCandidateInit }
  /** The publisher is going away. */
  | { type: 'bye' }

export function programChannelName(room: string): string {
  return `livedeck:program:${room}`
}

/**
 * No ICE servers at all.
 *
 * Both ends are in the same browser on the same machine, so host candidates
 * are guaranteed to pair. Configuring STUN would add a round trip to a public
 * server for a connection that never leaves the loopback interface — and would
 * make the scene window depend on the network, which is exactly wrong for the
 * one view that has to keep working during a production.
 */
const LOOPBACK_CONFIG: RTCConfiguration = { iceServers: [] }

/** True when this browser can run the mirror at all. */
export function supportsProgramLink(): boolean {
  return (
    typeof BroadcastChannel === 'function' &&
    typeof RTCPeerConnection === 'function'
  )
}

/* ------------------------------------------------------------------ publish */

/**
 * Publish a stream to every scene window open on this room.
 *
 * One peer connection per subscriber, created on demand. The stream itself is
 * supplied by the caller and never owned here: the compositor's capture
 * belongs to whoever created it, and stopping its tracks from this side would
 * blank the director's own recording.
 */
export class ProgramLinkPublisher {
  private channel: BroadcastChannel | null = null
  private stream: MediaStream | null = null
  private readonly peers = new Map<string, RTCPeerConnection>()
  private readonly room: string

  constructor(room: string) {
    this.room = room
  }

  start(): void {
    if (this.channel || !supportsProgramLink()) return
    const channel = new BroadcastChannel(programChannelName(this.room))
    this.channel = channel
    channel.onmessage = (event: MessageEvent) => {
      void this.handle(event.data as ProgramLinkMessage)
    }
    // Scene windows opened *before* the director are waiting; this prompts
    // them to ask again rather than sit there until someone reloads.
    this.post({ type: 'publisher-online' })
  }

  /**
   * Swap the published stream.
   *
   * Existing subscribers are updated with `replaceTrack`, so a scene window
   * does not have to renegotiate — which matters because the program stream is
   * rebuilt whenever the output resolution changes.
   */
  setStream(stream: MediaStream | null): void {
    this.stream = stream
    for (const pc of this.peers.values()) this.syncSenders(pc)
  }

  stop(): void {
    this.post({ type: 'bye' })
    for (const pc of this.peers.values()) this.closePeer(pc)
    this.peers.clear()

    const channel = this.channel
    this.channel = null
    if (channel) {
      channel.onmessage = null
      channel.close()
    }
    this.stream = null
  }

  private async handle(message: ProgramLinkMessage): Promise<void> {
    switch (message.type) {
      case 'hello':
        await this.offerTo(message.from)
        return
      case 'answer': {
        const pc = this.peers.get(message.from)
        if (!pc) return
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        } catch {
          // A subscriber that reloaded mid-handshake; it will say hello again.
          this.closePeer(pc)
          this.peers.delete(message.from)
        }
        return
      }
      case 'candidate': {
        const pc = this.peers.get(message.from)
        if (!pc) return
        try {
          await pc.addIceCandidate(message.candidate)
        } catch {
          // One lost path, not a lost connection.
        }
        return
      }
      default:
        return
    }
  }

  private async offerTo(subscriberId: string): Promise<void> {
    // A repeated hello means the subscriber restarted, so discard the old
    // connection rather than leaving it running with nothing attached.
    const previous = this.peers.get(subscriberId)
    if (previous) {
      this.closePeer(previous)
      this.peers.delete(subscriberId)
    }

    const pc = new RTCPeerConnection(LOOPBACK_CONFIG)
    this.peers.set(subscriberId, pc)

    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.post({
        type: 'candidate',
        from: 'publisher',
        to: subscriberId,
        candidate: event.candidate.toJSON(),
      })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return
      this.closePeer(pc)
      this.peers.delete(subscriberId)
    }

    this.syncSenders(pc)
    // Declare a video m-line even with nothing to send yet, so the connection
    // is usable the moment a stream arrives.
    if (pc.getTransceivers().length === 0) {
      pc.addTransceiver('video', { direction: 'sendonly' })
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.post({ type: 'offer', to: subscriberId, sdp: offer.sdp ?? '' })
    } catch {
      this.closePeer(pc)
      this.peers.delete(subscriberId)
    }
  }

  private syncSenders(pc: RTCPeerConnection): void {
    const senders = pc.getSenders()
    for (const kind of ['video', 'audio'] as const) {
      const track = this.stream?.getTracks().find((entry) => entry.kind === kind) ?? null
      const sender = senders.find((entry) => entry.track?.kind === kind) ?? null
      if (sender) {
        if (sender.track !== track) void sender.replaceTrack(track).catch(() => {})
        continue
      }
      if (track && this.stream) {
        try {
          pc.addTrack(track, this.stream)
        } catch {
          // The connection closed underneath us.
        }
      }
    }
  }

  private closePeer(pc: RTCPeerConnection): void {
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    try {
      pc.close()
    } catch {
      // Already closed.
    }
  }

  private post(message: ProgramLinkMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // The channel closed between the check and the send.
    }
  }
}

/* ---------------------------------------------------------------- subscribe */

export type ProgramLinkState = 'unsupported' | 'waiting' | 'connecting' | 'live' | 'ended'

export type ProgramLinkSubscriberEvents = {
  onStream: (stream: MediaStream | null) => void
  onState: (state: ProgramLinkState) => void
}

/**
 * Receive the program output published by a director window.
 *
 * Says hello on a timer until something answers, because the scene window is
 * frequently opened *first* — you set up the capture, then start the
 * production — and a one-shot request would leave it black forever.
 */
export class ProgramLinkSubscriber {
  private channel: BroadcastChannel | null = null
  private pc: RTCPeerConnection | null = null
  private helloTimer: ReturnType<typeof setInterval> | null = null
  private readonly id = `scene-${Math.random().toString(36).slice(2, 10)}`
  private state: ProgramLinkState = 'waiting'

  private readonly room: string
  private readonly events: ProgramLinkSubscriberEvents

  constructor(room: string, events: ProgramLinkSubscriberEvents) {
    this.room = room
    this.events = events
  }

  start(): void {
    if (this.channel) return
    if (!supportsProgramLink()) {
      this.setState('unsupported')
      return
    }

    const channel = new BroadcastChannel(programChannelName(this.room))
    this.channel = channel
    channel.onmessage = (event: MessageEvent) => {
      void this.handle(event.data as ProgramLinkMessage)
    }

    this.setState('waiting')
    this.post({ type: 'hello', from: this.id })
    this.helloTimer = setInterval(() => {
      // Only while nothing is attached; a live mirror must not be disturbed.
      if (this.state === 'live' || this.state === 'connecting') return
      this.post({ type: 'hello', from: this.id })
    }, 1500)
  }

  stop(): void {
    if (this.helloTimer !== null) {
      clearInterval(this.helloTimer)
      this.helloTimer = null
    }
    this.teardownPeer()

    const channel = this.channel
    this.channel = null
    if (channel) {
      channel.onmessage = null
      channel.close()
    }
  }

  private async handle(message: ProgramLinkMessage): Promise<void> {
    switch (message.type) {
      case 'publisher-online':
        if (this.state === 'waiting' || this.state === 'ended') {
          this.post({ type: 'hello', from: this.id })
        }
        return

      case 'offer':
        if (message.to !== this.id) return
        await this.accept(message.sdp)
        return

      case 'candidate': {
        if (message.to !== this.id || !this.pc) return
        try {
          await this.pc.addIceCandidate(message.candidate)
        } catch {
          // One lost path, not a lost connection.
        }
        return
      }

      case 'bye':
        // The director window closed. Report it rather than holding the last
        // frame, which would look like a working feed that had frozen.
        this.teardownPeer()
        this.events.onStream(null)
        this.setState('ended')
        return

      default:
        return
    }
  }

  private async accept(sdp: string): Promise<void> {
    this.teardownPeer()
    this.setState('connecting')

    const pc = new RTCPeerConnection(LOOPBACK_CONFIG)
    this.pc = pc

    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.post({
        type: 'candidate',
        from: this.id,
        to: 'publisher',
        candidate: event.candidate.toJSON(),
      })
    }
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.events.onStream(stream)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.setState('live')
      if (pc.connectionState === 'failed') {
        this.events.onStream(null)
        this.setState('waiting')
      }
    }

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.post({ type: 'answer', from: this.id, sdp: answer.sdp ?? '' })
    } catch {
      this.teardownPeer()
      this.setState('waiting')
    }
  }

  private teardownPeer(): void {
    const pc = this.pc
    this.pc = null
    if (!pc) return
    pc.onicecandidate = null
    pc.ontrack = null
    pc.onconnectionstatechange = null
    try {
      pc.close()
    } catch {
      // Already closed.
    }
  }

  private setState(state: ProgramLinkState): void {
    if (this.state === state) return
    this.state = state
    this.events.onState(state)
  }

  private post(message: ProgramLinkMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // The channel closed between the check and the send.
    }
  }
}
