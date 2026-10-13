import type {
  AnyChannelMessage,
  ControlChannelState,
  ControlMessage,
  GuestMessage,
} from '@/types/room'
import { parseChannelMessage } from '@/types/room'

/**
 * The director ↔ guest control channel.
 *
 * WHY THIS EXISTS
 * ---------------
 * Without it, "mute this guest" can only mean "drop them from my own mix" —
 * the remote participant is never told, keeps talking, and keeps sending audio.
 * VDO.Ninja's director genuinely mutes the guest's microphone, and that
 * requires a second path alongside the media: a `RTCDataChannel`.
 *
 * So director actions here split cleanly into two kinds, and the UI labels
 * which is which:
 *  - **remote** — sent over this channel, changes the guest's own tracks,
 *  - **local**  — excludes them from this machine's program mix only.
 *
 * ORDERING AND RELIABILITY
 * ------------------------
 * The channel is created ordered and reliable (the default). Control messages
 * are rare and small, and an out-of-order "unmute" arriving before a "mute"
 * would leave a guest muted with the director's UI saying otherwise.
 */

export const CONTROL_CHANNEL_LABEL = 'livedeck-control'

/** Heartbeat interval. Slow — this only needs to detect a dead channel. */
const PING_INTERVAL_MS = 5000

export type ControlChannelEvents = {
  /** The channel opened or closed, or a latency/state report arrived. */
  onStateChange: (state: ControlChannelState) => void
  /** A message from the *director*, handled by a guest. */
  onControl: (message: ControlMessage) => void
  /** A message from a *guest*, handled by the director. */
  onGuestMessage: (message: GuestMessage) => void
}

/**
 * Wraps one `RTCDataChannel` with the control protocol.
 *
 * Owns its own heartbeat timer and tears it down with the channel, so a closed
 * peer never leaves an interval running.
 */
export class ControlChannel {
  private channel: RTCDataChannel | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private events: Partial<ControlChannelEvents> = {}

  private state: ControlChannelState
  private readonly peerId: string

  constructor(peerId: string) {
    this.peerId = peerId
    this.state = {
      peerId,
      open: false,
      latencyMs: null,
      reportedMicMuted: null,
      reportedCameraMuted: null,
      lastMessageAt: null,
    }
  }

  setEvents(events: Partial<ControlChannelEvents>): void {
    this.events = events
  }

  getState(): ControlChannelState {
    return this.state
  }

  isOpen(): boolean {
    return this.channel?.readyState === 'open'
  }

  /** Attach a channel, whether we created it or it arrived via `ondatachannel`. */
  attach(channel: RTCDataChannel): void {
    this.detach()
    this.channel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      this.patch({ open: true })
      this.startHeartbeat()
    }

    channel.onclose = () => {
      this.stopHeartbeat()
      this.patch({ open: false, latencyMs: null })
    }

    channel.onerror = () => {
      // An errored channel is unusable; report it closed rather than leaving
      // the UI showing a live control path.
      this.stopHeartbeat()
      this.patch({ open: false })
    }

    channel.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      const message = parseChannelMessage(event.data)
      // Unparseable or hostile payloads are dropped silently — a peer must not
      // be able to break the control path by sending garbage.
      if (!message) return
      this.handle(message)
    }

    // A channel handed to us may already be open (common for the answering
    // side), in which case `onopen` will never fire.
    if (channel.readyState === 'open') {
      this.patch({ open: true })
      this.startHeartbeat()
    }
  }

  private handle(message: AnyChannelMessage): void {
    this.patch({ lastMessageAt: Date.now() })

    switch (message.type) {
      case 'ping':
        // Reply immediately with the sender's timestamp so they can measure
        // round-trip without needing synchronized clocks.
        this.send({ v: 1, type: 'pong', at: message.at })
        return
      case 'pong':
        this.patch({ latencyMs: Math.max(0, Math.round(performance.now() - message.at)) })
        return
      case 'state':
        this.patch({
          reportedMicMuted: message.micMuted,
          reportedCameraMuted: message.cameraMuted,
        })
        this.events.onGuestMessage?.(message)
        return
      case 'hello':
        this.events.onGuestMessage?.(message)
        return
      default:
        this.events.onControl?.(message)
    }
  }

  /** Send a message. Returns false when the channel is not open. */
  send(message: AnyChannelMessage): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false
    try {
      this.channel.send(JSON.stringify(message))
      return true
    } catch {
      // Buffer full or channel closing between the check and the send.
      return false
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      this.send({ v: 1, type: 'ping', at: performance.now() })
    }, PING_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer === null) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private patch(partial: Partial<ControlChannelState>): void {
    this.state = { ...this.state, ...partial }
    this.events.onStateChange?.(this.state)
  }

  detach(): void {
    this.stopHeartbeat()
    const channel = this.channel
    this.channel = null
    if (!channel) return
    channel.onopen = null
    channel.onclose = null
    channel.onerror = null
    channel.onmessage = null
    try {
      channel.close()
    } catch {
      // Already closed.
    }
  }

  dispose(): void {
    this.detach()
    this.events = {}
    this.patch({ open: false, latencyMs: null })
  }

  get id(): string {
    return this.peerId
  }
}
