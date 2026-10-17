import type { ErrorCode, NotificationData, NotificationEvent, Participant } from '../../../shared/protocol'
import type { Peer } from './peer'

/**
 * A studio room: its participants, who claimed it, and how to reach them.
 *
 * Handlers in `signaling/` validate each request and the caller's authority,
 * then call in here; this file never reads a socket and never decides who is
 * allowed to do what. Errors carry a protocol error code.
 */

export class RoomError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'RoomError'
    this.code = code
  }
}

export type RoomOptions = {
  name: string
  maxPeers: number
  log: (event: string, detail?: Record<string, unknown>) => void
}

export class Room {
  readonly name: string
  readonly peers = new Map<string, Peer>()
  private readonly maxPeers: number
  private readonly log: RoomOptions['log']
  private closed = false
  /**
   * Whether a studio has claimed this room. Set once, for the room's life:
   * the room is reaped when its last participant leaves, which resets it.
   */
  private claimedByStudio = false

  constructor(options: RoomOptions) {
    this.name = options.name
    this.maxPeers = options.maxPeers
    this.log = options.log
  }

  get isClosed(): boolean {
    return this.closed
  }

  get isEmpty(): boolean {
    return this.peers.size === 0
  }

  /**
   * Hand the director role to the first studio that asks. True once only.
   *
   * Guests who open the link first do not block it: what matters is that
   * nobody has claimed the room yet, not that it is empty.
   */
  claim(): boolean {
    if (this.claimedByStudio) return false
    this.claimedByStudio = true
    return true
  }

  addPeer(peer: Peer): void {
    if (this.peers.size >= this.maxPeers) {
      throw new RoomError('room-full', `This room already has ${this.maxPeers} participants, which is the limit.`)
    }
    this.peers.set(peer.id, peer)
    this.broadcast('participantJoined', { participant: peer.toParticipant() }, peer.id)
    this.log('peer-joined', { room: this.name, peerId: peer.id, role: peer.role })
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.close()
    this.peers.delete(peerId)
    this.broadcast('participantLeft', { participantId: peerId })
    this.log('peer-left', { room: this.name, peerId })
  }

  getPeer(peerId: string): Peer {
    const peer = this.peers.get(peerId)
    if (!peer || peer.isClosed) {
      throw new RoomError('unknown-participant', 'That participant is no longer in the room.')
    }
    return peer
  }

  participants(): Participant[] {
    return [...this.peers.values()].map((peer) => peer.toParticipant())
  }

  broadcast<E extends NotificationEvent>(event: E, data: NotificationData<E>, exceptPeerId?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.id === exceptPeerId) continue
      peer.send(event, data)
    }
  }

  /** Announce a change to one participant's public state. */
  announcePeer(peer: Peer): void {
    this.broadcast('participantUpdated', { participant: peer.toParticipant() })
  }

  close(reason: NotificationData<'closed'>['code']): void {
    if (this.closed) return
    this.closed = true
    for (const peer of this.peers.values()) {
      peer.send('closed', { code: reason, message: 'The room was closed.' })
      peer.close()
    }
    this.peers.clear()
    this.log('room-closed', { room: this.name, reason })
  }
}
