import type { RoomPeer, ServerMessage } from '../../shared/signaling-protocol'

/**
 * The room registry — the entire business logic of the signaling server.
 *
 * Deliberately transport-agnostic: it knows nothing about WebSockets, only
 * about peers that can be `send`-ed a message. That keeps it unit-testable
 * without opening a socket, which matters because the failure modes that bite
 * in production (a peer leaving mid-handshake, two directors in one room, a
 * flood of candidates) are all logic, not networking.
 *
 * WHAT THIS SERVER DOES AND DOES NOT DO
 * -------------------------------------
 * It relays signaling messages between peers who name the same room. It never
 * sees or touches media — that flows peer-to-peer. It stores nothing: the
 * registry is in memory, so a restart drops every room and connected clients
 * reconnect and re-join.
 *
 * A room name is **not** a credential. Anyone who knows the name can join and
 * will be offered a connection. That is the same trust model as the rest of the
 * project, and the client UI says so; if you need private rooms you need real
 * authentication in front of this.
 */

export type PeerHandle = {
  peerId: string
  role: 'director' | 'guest'
  label: string
  /** Deliver a message. Implementations should swallow transport errors. */
  send: (message: ServerMessage) => void
  /** Terminate this peer's connection. */
  close: () => void
}

export type RoomLimits = {
  /** Participants per room. Guards against one room exhausting the process. */
  maxPeersPerRoom: number
  /** Total rooms held in memory. */
  maxRooms: number
  /** Messages per peer per window, before `rate-limited` is returned. */
  maxMessagesPerWindow: number
  rateWindowMs: number
}

export const DEFAULT_LIMITS: RoomLimits = {
  // A production with more than this many live peers is not what this is for;
  // mesh WebRTC stops being viable well before it anyway.
  maxPeersPerRoom: 12,
  maxRooms: 500,
  maxMessagesPerWindow: 120,
  rateWindowMs: 10_000,
}

type RateState = { count: number; windowStartedAt: number }

export type JoinResult =
  | { ok: true; peers: RoomPeer[] }
  | { ok: false; code: 'room-full'; message: string }

export class RoomRegistry {
  private readonly rooms = new Map<string, Map<string, PeerHandle>>()
  /** peerId → room, so a disconnect can be resolved without scanning. */
  private readonly peerRooms = new Map<string, string>()
  private readonly rates = new Map<string, RateState>()

  private readonly limits: RoomLimits
  private readonly now: () => number

  constructor(limits: Partial<RoomLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.now = now
  }

  /**
   * Add a peer to a room.
   *
   * Returns the peers already present so the joiner can start offering
   * immediately, and notifies everyone else. The joiner is *not* included in
   * its own peer list.
   */
  join(room: string, peer: PeerHandle): JoinResult {
    // Re-joining moves the peer rather than duplicating it, which is what
    // happens when a client reconnects after a dropped socket.
    const previous = this.peerRooms.get(peer.peerId)
    if (previous) this.leave(peer.peerId)

    let members = this.rooms.get(room)

    if (!members) {
      if (this.rooms.size >= this.limits.maxRooms) {
        return {
          ok: false,
          code: 'room-full',
          message: 'The signaling server is at capacity. Try again shortly.',
        }
      }
      members = new Map()
      this.rooms.set(room, members)
    }

    if (members.size >= this.limits.maxPeersPerRoom) {
      return {
        ok: false,
        code: 'room-full',
        message: `This room already has ${this.limits.maxPeersPerRoom} participants, which is the limit.`,
      }
    }

    const existing: RoomPeer[] = [...members.values()].map(toRoomPeer)

    members.set(peer.peerId, peer)
    this.peerRooms.set(peer.peerId, room)

    for (const member of members.values()) {
      if (member.peerId === peer.peerId) continue
      member.send({ v: 1, type: 'peer-joined', peer: toRoomPeer(peer) })
    }

    return { ok: true, peers: existing }
  }

  /** Remove a peer and tell the room. Safe to call for an unknown peer. */
  leave(peerId: string): void {
    const room = this.peerRooms.get(peerId)
    if (!room) return

    this.peerRooms.delete(peerId)
    this.rates.delete(peerId)

    const members = this.rooms.get(room)
    if (!members) return

    members.delete(peerId)

    // Drop empty rooms so a long-running server does not accumulate them.
    if (members.size === 0) {
      this.rooms.delete(room)
      return
    }

    for (const member of members.values()) {
      member.send({ v: 1, type: 'peer-left', peerId })
    }
  }

  /**
   * Relay a message to one peer in the sender's room.
   *
   * Cross-room delivery is impossible by construction: the recipient is looked
   * up inside the sender's own room, so naming a peer elsewhere simply fails.
   */
  relay(fromPeerId: string, toPeerId: string, message: ServerMessage): 'ok' | 'not-joined' | 'unknown-peer' {
    const room = this.peerRooms.get(fromPeerId)
    if (!room) return 'not-joined'

    const members = this.rooms.get(room)
    const target = members?.get(toPeerId)
    if (!target) return 'unknown-peer'

    target.send(message)
    return 'ok'
  }

  /**
   * Record a message against a peer's rate budget.
   * Returns false when the peer has exceeded it for the current window.
   */
  allowMessage(peerId: string): boolean {
    const timestamp = this.now()
    const state = this.rates.get(peerId)

    if (!state || timestamp - state.windowStartedAt >= this.limits.rateWindowMs) {
      this.rates.set(peerId, { count: 1, windowStartedAt: timestamp })
      return true
    }

    state.count += 1
    return state.count <= this.limits.maxMessagesPerWindow
  }

  roomOf(peerId: string): string | null {
    return this.peerRooms.get(peerId) ?? null
  }

  peersIn(room: string): RoomPeer[] {
    return [...(this.rooms.get(room)?.values() ?? [])].map(toRoomPeer)
  }

  /** Counts for the health endpoint. */
  stats(): { rooms: number; peers: number } {
    return { rooms: this.rooms.size, peers: this.peerRooms.size }
  }

  /** Close every connection. Used on shutdown. */
  closeAll(): void {
    for (const members of this.rooms.values()) {
      for (const member of members.values()) member.close()
    }
    this.rooms.clear()
    this.peerRooms.clear()
    this.rates.clear()
  }
}

function toRoomPeer(peer: PeerHandle): RoomPeer {
  return { peerId: peer.peerId, role: peer.role, label: peer.label }
}
