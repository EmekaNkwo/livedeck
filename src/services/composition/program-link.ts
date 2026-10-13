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
 * TARGETS
 * -------
 * The same channel serves `/solo/:room/:sourceId`, which needs *one source*
 * rather than the composition. A subscriber says which it wants, so one
 * publisher feeds a scene window and any number of solo windows at once, each
 * with its own peer connection and its own stream.
 *
 * WHAT IT IS NOT
 * --------------
 * Still not an independent process: the pixels originate in the director's
 * compositor, so closing the control room stops the mirror. The subscriber
 * reports that rather than freezing on a stale frame.
 */

/**
 * What a subscriber wants.
 *
 * `'program'` is the composed output; anything else is a source id, which is
 * how a solo link asks for a single uncomposed feed.
 */
export type ProgramTarget = string

export const PROGRAM_TARGET = 'program'

export type ProgramLinkMessage =
  /** A subscriber announcing itself and asking to be offered a connection. */
  | { type: 'hello'; from: string; target: ProgramTarget }
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
 * Resolve what a subscriber asked for into a stream to send.
 *
 * Returning null is normal and not an error — a solo window can legitimately
 * open before its source has a live capture. The connection is established
 * anyway and the track is attached by {@link ProgramLinkPublisher.refresh}
 * when it appears.
 */
export type ProgramStreamResolver = (target: ProgramTarget) => MediaStream | null

/**
 * Publish to every mirror window open on this room.
 *
 * One peer connection per subscriber, created on demand, each remembering the
 * target it asked for. Streams are *resolved*, never owned: the compositor's
 * capture and a source's tracks belong to whoever created them, and stopping
 * them from here would blank the director's own output.
 */
export class ProgramLinkPublisher {
  private channel: BroadcastChannel | null = null
  private readonly peers = new Map<string, { pc: RTCPeerConnection; target: ProgramTarget }>()
  private readonly room: string
  private resolve: ProgramStreamResolver

  constructor(room: string, resolve: ProgramStreamResolver) {
    this.room = room
    this.resolve = resolve
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
   * Re-resolve every subscriber's stream.
   *
   * Called when the program capture is rebuilt (an output resolution change) or
   * when a source starts or stops. Existing subscribers are updated with
   * `replaceTrack`, so no mirror window has to renegotiate — a solo window
   * whose source was not yet live simply starts receiving frames.
   */
  refresh(resolve?: ProgramStreamResolver): void {
    if (resolve) this.resolve = resolve
    for (const entry of this.peers.values()) this.syncSenders(entry.pc, entry.target)
  }

  stop(): void {
    this.post({ type: 'bye' })
    for (const entry of this.peers.values()) this.closePeer(entry.pc)
    this.peers.clear()

    const channel = this.channel
    this.channel = null
    if (channel) {
      channel.onmessage = null
      channel.close()
    }
    // Resolve to nothing from here on, so a message that races the teardown
    // cannot hand out a stream this publisher no longer serves.
    this.resolve = () => null
  }

  private async handle(message: ProgramLinkMessage): Promise<void> {
    switch (message.type) {
      case 'hello':
        await this.offerTo(message.from, message.target ?? PROGRAM_TARGET)
        return
      case 'answer': {
        const entry = this.peers.get(message.from)
        if (!entry) return
        try {
          await entry.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        } catch {
          // A subscriber that reloaded mid-handshake; it will say hello again.
          this.closePeer(entry.pc)
          this.peers.delete(message.from)
        }
        return
      }
      case 'candidate': {
        const entry = this.peers.get(message.from)
        if (!entry) return
        try {
          await entry.pc.addIceCandidate(message.candidate)
        } catch {
          // One lost path, not a lost connection.
        }
        return
      }
      default:
        return
    }
  }

  private async offerTo(subscriberId: string, target: ProgramTarget): Promise<void> {
    // A repeated hello means the subscriber restarted, so discard the old
    // connection rather than leaving it running with nothing attached.
    const previous = this.peers.get(subscriberId)
    if (previous) {
      this.closePeer(previous.pc)
      this.peers.delete(subscriberId)
    }

    const pc = new RTCPeerConnection(LOOPBACK_CONFIG)
    this.peers.set(subscriberId, { pc, target })

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

    this.syncSenders(pc, target)
    /*
     * Declare send-only m-lines even with nothing to send yet.
     *
     * This is what lets a solo window open *before* its source is live: the
     * connection completes now, and `refresh` attaches the track later with
     * `replaceTrack` instead of needing a second negotiation round.
     */
    if (pc.getTransceivers().length === 0) {
      pc.addTransceiver('video', { direction: 'sendonly' })
      pc.addTransceiver('audio', { direction: 'sendonly' })
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

  private syncSenders(pc: RTCPeerConnection, target: ProgramTarget): void {
    const stream = this.resolve(target)
    /*
     * Transceivers are indexed by position, matched to the order they were
     * declared in (video, then audio).
     *
     * Keying off `sender.track?.kind` could never fill an *empty* sender,
     * because a null track has no kind to compare against — and an empty
     * sender is exactly the state a solo window starts in when its source is
     * not live yet.
     */
    const transceivers = pc.getTransceivers()
    const kinds = ['video', 'audio'] as const

    for (let index = 0; index < kinds.length; index += 1) {
      const kind = kinds[index]!
      const track = stream?.getTracks().find((entry) => entry.kind === kind) ?? null
      const transceiver = transceivers[index] ?? null

      if (transceiver) {
        if (transceiver.sender.track !== track) {
          void transceiver.sender.replaceTrack(track).catch(() => {})
        }
        continue
      }
      if (track && stream) {
        try {
          pc.addTrack(track, stream)
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
  private readonly target: ProgramTarget

  constructor(
    room: string,
    events: ProgramLinkSubscriberEvents,
    target: ProgramTarget = PROGRAM_TARGET,
  ) {
    this.room = room
    this.events = events
    this.target = target
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
    this.post({ type: 'hello', from: this.id, target: this.target })
    this.helloTimer = setInterval(() => {
      // Only while nothing is attached; a live mirror must not be disturbed.
      if (this.state === 'live' || this.state === 'connecting') return
      this.post({ type: 'hello', from: this.id, target: this.target })
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
          this.post({ type: 'hello', from: this.id, target: this.target })
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
      const track = event.track

      /**
       * Only surface a stream that is actually carrying media.
       *
       * `ontrack` fires for every m-line in the remote description, including
       * a send-only one the publisher declared with **no track attached** —
       * which it does deliberately, so a solo window can connect before its
       * source is live. The resulting receiver track is `live` but `muted`,
       * and handing it to a `<video>` renders a permanently black frame that
       * is indistinguishable from a working feed showing nothing.
       *
       * So the mute state is the signal, in both directions: a source being
       * started unmutes the track, and stopping it mutes the track again,
       * which is reported as "no feed" rather than freezing on the last frame.
       */
      const publish = () => {
        this.events.onStream(track.muted ? null : stream)
      }

      track.addEventListener('unmute', publish)
      track.addEventListener('mute', publish)
      track.addEventListener('ended', () => this.events.onStream(null))
      publish()
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
