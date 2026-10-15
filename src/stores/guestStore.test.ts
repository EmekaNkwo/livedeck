import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Guest, PeerState, PeerStats } from '@/types/peer'
import type { ControlChannelState } from '@/types/room'
import {
  countConnectedPeers,
  selectGuestList,
  selectPeerForGuest,
  selectStatsForGuest,
  useGuestStore,
} from './guestStore'

const store = () => useGuestStore.getState()

function peerState(peerId: string, status: PeerState['status'] = 'connected'): PeerState {
  return {
    peerId,
    role: 'guest',
    status,
    error: null,
    hasRemoteVideo: true,
    hasRemoteAudio: true,
    connectedAt: 1,
    transport: 'connected',
  }
}

function peerStats(sampledAt = 1): PeerStats {
  return {
    roundTripTimeMs: 20,
    videoBitrateKbps: 1500,
    audioBitrateKbps: 64,
    framesPerSecond: 30,
    framesDropped: 0,
    packetsLost: 0,
    jitterMs: 2,
    candidatePair: 'udp',
    sampledAt,
  }
}

function controlState(peerId: string): ControlChannelState {
  return {
    peerId,
    open: true,
    latencyMs: 12,
    reportedMicMuted: false,
    reportedCameraMuted: false,
    sharing: false,
    onAir: true,
    lastMessageAt: 5,
  }
}

function guest(id: string, name: string, peerId: string | null = null): Guest {
  return { id, name, videoHidden: false, mutedInMix: false, peerId, createdAt: 1 }
}

beforeEach(() => {
  store().clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('addGuest', () => {
  it('creates a guest with defaults, a prefixed id and an order entry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const created = store().addGuest({ name: '  Ada  ' })
    expect(created).toMatchObject({
      name: 'Ada',
      videoHidden: false,
      mutedInMix: false,
      peerId: null,
      createdAt: 1_700_000_000_000,
    })
    expect(created.id).toMatch(/^gst_[a-z0-9]{8}$/)
    expect(store().guests[created.id]).toEqual(created)
    expect(store().order).toEqual([created.id])
  })

  it('numbers unnamed guests and treats blank names as unnamed', () => {
    const first = store().addGuest({})
    const second = store().addGuest({ name: '   ' })
    expect(first.name).toBe('Guest 1')
    expect(second.name).toBe('Guest 2')
  })

  it('de-duplicates names and binds a peer when given', () => {
    store().addGuest({ name: 'Ada' })
    const dup = store().addGuest({ name: 'Ada', peerId: 'peer_1' })
    expect(dup.name).toBe('Ada 2')
    expect(dup.peerId).toBe('peer_1')
  })
})

describe('removeGuest', () => {
  it('drops the guest and all live state for its bound peer', () => {
    const kept = store().addGuest({ name: 'Kept', peerId: 'p2' })
    const doomed = store().addGuest({ name: 'Doomed', peerId: 'p1' })
    for (const id of ['p1', 'p2']) {
      store().setPeerState(peerState(id))
      store().setPeerStats(id, peerStats())
      store().setControlState(controlState(id))
    }

    store().removeGuest(doomed.id)

    expect(store().guests[doomed.id]).toBeUndefined()
    expect(store().order).toEqual([kept.id])
    expect(Object.keys(store().peerStates)).toEqual(['p2'])
    expect(Object.keys(store().peerStats)).toEqual(['p2'])
    expect(Object.keys(store().controlStates)).toEqual(['p2'])
  })

  it('leaves peer maps alone when the guest has no peer', () => {
    const unbound = store().addGuest({ name: 'Unbound' })
    store().setPeerState(peerState('p1'))
    store().removeGuest(unbound.id)
    expect(store().order).toEqual([])
    expect(store().peerStates.p1).toBeDefined()
  })

  it('is a no-op for an unknown guest', () => {
    store().addGuest({ name: 'A' })
    const before = store()
    store().removeGuest('gst_missing')
    expect(store()).toBe(before)
  })
})

describe('guest edits', () => {
  it('renames with trimming and uniqueness against other guests only', () => {
    const a = store().addGuest({ name: 'A' })
    store().addGuest({ name: 'B' })
    store().renameGuest(a.id, '  B ')
    expect(store().guests[a.id]?.name).toBe('B 2')
    // Renaming to its own current name must not suffix it.
    store().renameGuest(a.id, 'B 2')
    expect(store().guests[a.id]?.name).toBe('B 2')
  })

  it('ignores blank renames and unknown guests', () => {
    const a = store().addGuest({ name: 'A' })
    const before = store()
    store().renameGuest(a.id, '   ')
    store().renameGuest('nope', 'X')
    expect(store()).toBe(before)
  })

  it('toggles mix mute, video hidden and peer binding', () => {
    const a = store().addGuest({ name: 'A' })
    store().setMutedInMix(a.id, true)
    store().setVideoHidden(a.id, true)
    store().bindPeer(a.id, 'peer_9')
    expect(store().guests[a.id]).toMatchObject({
      mutedInMix: true,
      videoHidden: true,
      peerId: 'peer_9',
    })
    store().bindPeer(a.id, null)
    expect(store().guests[a.id]?.peerId).toBeNull()
  })

  it('ignores edits to unknown guests', () => {
    const before = store()
    store().setMutedInMix('nope', true)
    store().setVideoHidden('nope', true)
    store().bindPeer('nope', 'p')
    expect(store()).toBe(before)
  })
})

describe('peer state', () => {
  it('stores and replaces state, stats and control state per peer', () => {
    store().setPeerState(peerState('p1', 'connecting'))
    store().setPeerState(peerState('p1', 'connected'))
    store().setPeerStats('p1', peerStats(1))
    store().setPeerStats('p1', peerStats(2))
    store().setControlState(controlState('p1'))
    expect(store().peerStates.p1?.status).toBe('connected')
    expect(store().peerStats.p1?.sampledAt).toBe(2)
    expect(store().controlStates.p1?.open).toBe(true)
  })

  it('removePeer forgets every live map for that peer only', () => {
    for (const id of ['p1', 'p2']) {
      store().setPeerState(peerState(id))
      store().setPeerStats(id, peerStats())
      store().setControlState(controlState(id))
    }
    store().removePeer('p1')
    expect(Object.keys(store().peerStates)).toEqual(['p2'])
    expect(Object.keys(store().peerStats)).toEqual(['p2'])
    expect(Object.keys(store().controlStates)).toEqual(['p2'])
  })

  it('stores and clears room keys', () => {
    store().setRoomKeys({ directorKey: 'd', producerKey: 'p' })
    expect(store().roomKeys).toEqual({ directorKey: 'd', producerKey: 'p' })
    store().setRoomKeys(null)
    expect(store().roomKeys).toBeNull()
  })
})

describe('hydrate', () => {
  it('clears peer bindings and live state, keeping the stored order', () => {
    store().setPeerState(peerState('stale'))
    store().hydrate([guest('g1', 'One', 'p1'), guest('g2', 'Two', 'p2')], ['g2', 'g1'])
    expect(store().order).toEqual(['g2', 'g1'])
    expect(store().guests.g1?.peerId).toBeNull()
    expect(store().guests.g2?.peerId).toBeNull()
    expect(store().peerStates).toEqual({})
    expect(store().peerStats).toEqual({})
    expect(store().controlStates).toEqual({})
  })

  it('lists each guest once even when the saved order repeats an id', () => {
    store().hydrate([guest('g1', 'One')], ['g1', 'g1'])
    expect(store().order).toEqual(['g1'])
  })

  it('drops order ids without a guest and appends guests missing from the order', () => {
    store().hydrate([guest('g1', 'One'), guest('g2', 'Two'), guest('g3', 'Three')], ['ghost', 'g3'])
    expect(store().order).toEqual(['g3', 'g1', 'g2'])
  })
})

describe('clear and clearLive', () => {
  it('clearLive keeps guests but forgets everything live', () => {
    const a = store().addGuest({ name: 'A', peerId: 'p1' })
    store().setPeerState(peerState('p1'))
    store().setPeerStats('p1', peerStats())
    store().setControlState(controlState('p1'))
    store().setRoomKeys({ directorKey: 'd', producerKey: 'p' })
    store().clearLive()
    expect(store().guests[a.id]).toBeDefined()
    expect(store().peerStates).toEqual({})
    expect(store().peerStats).toEqual({})
    expect(store().controlStates).toEqual({})
    expect(store().roomKeys).toBeNull()
  })

  it('clear forgets guests too', () => {
    store().addGuest({ name: 'A' })
    store().setRoomKeys({ directorKey: 'd', producerKey: 'p' })
    store().clear()
    expect(store().guests).toEqual({})
    expect(store().order).toEqual([])
    expect(store().roomKeys).toBeNull()
  })
})

describe('selectors', () => {
  it('selectGuestList follows order and skips dangling ids', () => {
    const a = store().addGuest({ name: 'A' })
    const b = store().addGuest({ name: 'B' })
    useGuestStore.setState({ order: [b.id, 'dangling', a.id] })
    expect(selectGuestList(store()).map((g) => g.name)).toEqual(['B', 'A'])
  })

  it('selectPeerForGuest and selectStatsForGuest resolve through the binding', () => {
    const bound = store().addGuest({ name: 'Bound', peerId: 'p1' })
    const unbound = store().addGuest({ name: 'Unbound' })
    const awaiting = store().addGuest({ name: 'Awaiting', peerId: 'p2' })
    store().setPeerState(peerState('p1'))
    store().setPeerStats('p1', peerStats(7))

    expect(selectPeerForGuest(store(), bound)?.peerId).toBe('p1')
    expect(selectStatsForGuest(store(), bound)?.sampledAt).toBe(7)
    expect(selectPeerForGuest(store(), unbound)).toBeNull()
    expect(selectStatsForGuest(store(), unbound)).toBeNull()
    // Bound, but no live state reported yet.
    expect(selectPeerForGuest(store(), awaiting)).toBeNull()
    expect(selectStatsForGuest(store(), awaiting)).toBeNull()
  })

  it('countConnectedPeers counts only connected peers', () => {
    store().setPeerState(peerState('a', 'connected'))
    store().setPeerState(peerState('b', 'reconnecting'))
    store().setPeerState(peerState('c', 'connected'))
    store().setPeerState(peerState('d', 'failed'))
    expect(countConnectedPeers(store())).toBe(2)
  })
})
