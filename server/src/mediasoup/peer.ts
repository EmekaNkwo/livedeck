import type { types } from 'mediasoup'
import type {
  MediaSource,
  NotificationData,
  NotificationEvent,
  Participant,
  ProducerInfo,
  Role,
} from '../../../shared/protocol'

/**
 * One participant's server-side media state.
 *
 * Owns the transports, producers and consumers mediasoup created for it, and
 * the one function that reaches its browser. Everything about identity is
 * decided here by the server at join time and never changed by the client.
 */

export type PeerSend = <E extends NotificationEvent>(event: E, data: NotificationData<E>) => void

export type ProducerEntry = {
  producer: types.Producer
  source: MediaSource
}

export type ConsumerEntry = {
  consumer: types.Consumer
  producerId: string
  producerPeerId: string
  source: MediaSource
}

export class Peer {
  readonly id: string
  readonly role: Role
  label: string
  micMuted = false
  cameraMuted = false
  sharing = false
  onAir = false
  readonly joinedAt: number
  /** Changes on resume so the previous socket cannot keep acting. */
  resumeToken: string

  readonly transports = new Map<string, types.WebRtcTransport>()
  readonly producers = new Map<string, ProducerEntry>()
  readonly consumers = new Map<string, ConsumerEntry>()

  /** Null while the socket is gone and the resume grace period is running. */
  private sender: PeerSend | null
  private graceTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(options: {
    id: string
    role: Role
    label: string
    resumeToken: string
    send: PeerSend
    now?: number
  }) {
    this.id = options.id
    this.role = options.role
    this.label = options.label
    this.resumeToken = options.resumeToken
    this.sender = options.send
    this.joinedAt = options.now ?? Date.now()
  }

  get isClosed(): boolean {
    return this.closed
  }

  get isConnected(): boolean {
    return this.sender !== null
  }

  /** True when `send` is the function of the socket currently bound. */
  isAttachedTo(send: PeerSend): boolean {
    return this.sender === send
  }

  send: PeerSend = (event, data) => {
    this.sender?.(event, data)
  }

  /** Socket dropped: keep media alive and wait for a resume. */
  detach(onExpire: () => void, graceMs: number): void {
    this.sender = null
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(onExpire, graceMs)
    this.graceTimer.unref?.()
  }

  /** A new socket presented a valid resume token. */
  attach(send: PeerSend, resumeToken: string): void {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
    this.sender = send
    this.resumeToken = resumeToken
  }

  toParticipant(): Participant {
    return {
      id: this.id,
      role: this.role,
      label: this.label,
      micMuted: this.micMuted,
      cameraMuted: this.cameraMuted,
      sharing: this.sharing,
      onAir: this.onAir,
      joinedAt: this.joinedAt,
    }
  }

  producerInfos(): ProducerInfo[] {
    return [...this.producers.values()].map(({ producer, source }) => ({
      id: producer.id,
      participantId: this.id,
      kind: producer.kind,
      source,
      paused: producer.paused,
    }))
  }

  /** Release every mediasoup object. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
    this.sender = null
    // Closing a transport closes its producers and consumers.
    for (const transport of this.transports.values()) transport.close()
    this.transports.clear()
    this.producers.clear()
    this.consumers.clear()
  }
}
