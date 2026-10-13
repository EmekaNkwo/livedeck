import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../../shared/signaling-protocol'
import { RoomRegistry, type PeerHandle } from './rooms'

/**
 * The room registry.
 *
 * This holds the whole of the relay's logic, and the failures that actually
 * bite in production are all here rather than in the networking: a peer
 * dropping mid-handshake, a reconnect duplicating itself, one room trying to
 * message another, a client flooding the socket.
 */

type FakePeer = PeerHandle & { received: ServerMessage[]; closed: boolean }

function peer(id: string, role: 'director' | 'guest' = 'guest', label = id): FakePeer {
  const received: ServerMessage[] = []
  const handle: FakePeer = {
    peerId: id,
    role,
    label,
    received,
    closed: false,
    send: (message) => received.push(message),
    close: () => {
      handle.closed = true
    },
  }
  return handle
}

const typesOf = (target: FakePeer) => target.received.map((message) => message.type)

let registry: RoomRegistry

beforeEach(() => {
  registry = new RoomRegistry()
})

describe('join', () => {
  it('reports who is already present, excluding the joiner', () => {
    const a = peer('a', 'director')
    const b = peer('b')

    expect(registry.join('room1', a)).toEqual({ ok: true, peers: [] })

    const second = registry.join('room1', b)
    expect(second.ok).toBe(true)
    if (second.ok) {
      // So the joiner can start offering immediately.
      expect(second.peers.map((entry) => entry.peerId)).toEqual(['a'])
    }
  })

  it('notifies the existing members, not the joiner', () => {
    const a = peer('a', 'director')
    const b = peer('b')
    registry.join('room1', a)
    registry.join('room1', b)

    expect(typesOf(a)).toEqual(['peer-joined'])
    // The joiner learns about others via its own join result instead.
    expect(typesOf(b)).toEqual([])
  })

  it('carries role and label so a director knows who to offer to', () => {
    registry.join('room1', peer('a', 'director', 'Control'))
    const b = peer('b', 'guest', 'Ana')
    const result = registry.join('room1', b)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.peers[0]).toEqual({ peerId: 'a', role: 'director', label: 'Control' })
    }
  })

  it('moves a re-joining peer rather than duplicating it', () => {
    // This is what a reconnect after a dropped socket looks like.
    const a = peer('a')
    registry.join('room1', a)
    registry.join('room2', a)

    expect(registry.roomOf('a')).toBe('room2')
    expect(registry.peersIn('room1')).toHaveLength(0)
    expect(registry.peersIn('room2')).toHaveLength(1)
  })

  it('keeps rooms isolated', () => {
    const a = peer('a')
    const b = peer('b')
    registry.join('room1', a)
    registry.join('room2', b)

    expect(typesOf(a)).toEqual([])
    expect(registry.peersIn('room1').map((entry) => entry.peerId)).toEqual(['a'])
    expect(registry.peersIn('room2').map((entry) => entry.peerId)).toEqual(['b'])
  })

  it('refuses a room that is at its participant limit', () => {
    const limited = new RoomRegistry({ maxPeersPerRoom: 2 })
    expect(limited.join('room1', peer('a')).ok).toBe(true)
    expect(limited.join('room1', peer('b')).ok).toBe(true)

    const third = limited.join('room1', peer('c'))
    expect(third.ok).toBe(false)
    if (!third.ok) {
      expect(third.code).toBe('room-full')
      // The message names the actual limit, so it is actionable.
      expect(third.message).toContain('2')
    }
  })

  it('refuses a new room once the server is at capacity', () => {
    const limited = new RoomRegistry({ maxRooms: 1 })
    expect(limited.join('room1', peer('a')).ok).toBe(true)

    const overflow = limited.join('room2', peer('b'))
    expect(overflow.ok).toBe(false)

    // An existing room still accepts peers — capacity is on rooms, not peers.
    expect(limited.join('room1', peer('c')).ok).toBe(true)
  })
})

describe('leave', () => {
  it('tells the remaining members', () => {
    const a = peer('a')
    const b = peer('b')
    registry.join('room1', a)
    registry.join('room1', b)
    a.received.length = 0

    registry.leave('b')

    expect(a.received).toEqual([{ v: 1, type: 'peer-left', peerId: 'b' }])
    expect(registry.roomOf('b')).toBeNull()
  })

  it('drops an empty room so a long-running server does not accumulate them', () => {
    registry.join('room1', peer('a'))
    expect(registry.stats().rooms).toBe(1)

    registry.leave('a')
    expect(registry.stats()).toEqual({ rooms: 0, peers: 0 })
  })

  it('is safe for an unknown peer', () => {
    expect(() => registry.leave('ghost')).not.toThrow()
  })

  it('is idempotent', () => {
    const a = peer('a')
    const b = peer('b')
    registry.join('room1', a)
    registry.join('room1', b)

    registry.leave('b')
    const after = a.received.length
    registry.leave('b')

    // No duplicate peer-left, which would make the director remove a guest
    // it had already removed.
    expect(a.received.length).toBe(after)
  })
})

describe('relay', () => {
  it('delivers to the named peer only', () => {
    const a = peer('a')
    const b = peer('b')
    const c = peer('c')
    registry.join('room1', a)
    registry.join('room1', b)
    registry.join('room1', c)
    for (const target of [a, b, c]) target.received.length = 0

    const message: ServerMessage = { v: 1, type: 'offer', from: 'a', sdp: 'v=0' }
    expect(registry.relay('a', 'b', message)).toBe('ok')

    expect(b.received).toEqual([message])
    expect(c.received).toEqual([])
  })

  it('cannot reach a peer in another room', () => {
    // Isolation is structural: the target is looked up inside the sender's own
    // room, so naming an outsider simply fails.
    registry.join('room1', peer('a'))
    const outsider = peer('b')
    registry.join('room2', outsider)

    expect(registry.relay('a', 'b', { v: 1, type: 'offer', from: 'a', sdp: 'v=0' })).toBe(
      'unknown-peer',
    )
    expect(outsider.received).toEqual([])
  })

  it('reports an unjoined sender distinctly from an unknown target', () => {
    registry.join('room1', peer('a'))

    expect(registry.relay('nobody', 'a', { v: 1, type: 'pong', at: 0 })).toBe('not-joined')
    expect(registry.relay('a', 'nobody', { v: 1, type: 'pong', at: 0 })).toBe('unknown-peer')
  })

  it('reports a target that left mid-handshake', () => {
    const a = peer('a')
    const b = peer('b')
    registry.join('room1', a)
    registry.join('room1', b)
    registry.leave('b')

    expect(registry.relay('a', 'b', { v: 1, type: 'offer', from: 'a', sdp: 'v=0' })).toBe(
      'unknown-peer',
    )
  })
})

describe('rate limiting', () => {
  it('allows traffic up to the budget and then refuses', () => {
    const clock = vi.fn(() => 1000)
    const limited = new RoomRegistry({ maxMessagesPerWindow: 3, rateWindowMs: 1000 }, clock)

    expect(limited.allowMessage('a')).toBe(true)
    expect(limited.allowMessage('a')).toBe(true)
    expect(limited.allowMessage('a')).toBe(true)
    expect(limited.allowMessage('a')).toBe(false)
  })

  it('resets once the window rolls over', () => {
    let now = 1000
    const limited = new RoomRegistry({ maxMessagesPerWindow: 1, rateWindowMs: 1000 }, () => now)

    expect(limited.allowMessage('a')).toBe(true)
    expect(limited.allowMessage('a')).toBe(false)

    now += 1001
    expect(limited.allowMessage('a')).toBe(true)
  })

  it('budgets each peer separately', () => {
    // One noisy client must not throttle everyone else in the room.
    const limited = new RoomRegistry({ maxMessagesPerWindow: 1 }, () => 1000)
    expect(limited.allowMessage('a')).toBe(true)
    expect(limited.allowMessage('a')).toBe(false)
    expect(limited.allowMessage('b')).toBe(true)
  })

  it('forgets a peer’s budget when it leaves', () => {
    const limited = new RoomRegistry({ maxMessagesPerWindow: 1 }, () => 1000)
    const a = peer('a')
    limited.join('room1', a)

    expect(limited.allowMessage('a')).toBe(true)
    expect(limited.allowMessage('a')).toBe(false)

    limited.leave('a')
    // A reconnecting peer starts with a fresh budget rather than inheriting a
    // spent one, which would lock it out of re-joining.
    expect(limited.allowMessage('a')).toBe(true)
  })
})

describe('stats and shutdown', () => {
  it('counts rooms and peers', () => {
    registry.join('room1', peer('a'))
    registry.join('room1', peer('b'))
    registry.join('room2', peer('c'))

    expect(registry.stats()).toEqual({ rooms: 2, peers: 3 })
  })

  it('closes every connection and empties itself', () => {
    const a = peer('a')
    const b = peer('b')
    registry.join('room1', a)
    registry.join('room2', b)

    registry.closeAll()

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
    expect(registry.stats()).toEqual({ rooms: 0, peers: 0 })
  })
})
