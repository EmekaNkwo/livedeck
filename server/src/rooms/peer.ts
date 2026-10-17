import type { NotificationData, NotificationEvent, Participant, Role } from '../../../shared/protocol'

/**
 * One participant, as the server knows them.
 *
 * Identity is decided here by the server at join time and never changed by
 * the client. Media lives in Jitsi; this is the half that decides who the
 * participant is, what they may do, and how to reach their browser.
 */

export type PeerSend = <E extends NotificationEvent>(event: E, data: NotificationData<E>) => void

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

  /** Null while the socket is gone and the resume grace period is running. */
  private sender: PeerSend | null
  private graceTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(options: { id: string; role: Role; label: string; resumeToken: string; send: PeerSend; now?: number }) {
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

  /** Socket dropped: keep the participant and wait for a resume. */
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

  /** Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
    this.sender = null
  }
}
