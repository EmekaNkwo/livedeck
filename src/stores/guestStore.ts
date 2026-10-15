import { create } from 'zustand'
import type { Guest, PeerState, PeerStats } from '@/types/peer'
import type { ControlChannelState } from '@/types/room'
import { createGuestId, uniqueName } from '@/utils/id'

/**
 * Guests.
 *
 * Deliberately three separate maps:
 *  - `guests`     : identity metadata. Serializable, persisted.
 *  - `peerStates` : live transport state, owned by PeerConnectionManager.
 *  - `peerStats`  : sampled statistics, or nothing when unavailable.
 *
 * A guest existing in `guests` says nothing about whether a peer connection
 * succeeded. The UI reads `peerStates` for that, so it can never imply a
 * connection that does not exist.
 *
 */

type GuestState = {
  guests: Record<string, Guest>
  order: string[]
  peerStates: Record<string, PeerState>
  peerStats: Record<string, PeerStats>
  /**
   * Director ↔ guest command channel state, keyed by peer id.
   *
   * Separate from `peerStates` because a media connection can be up while the
   * control path is not, and the UI must not offer remote controls it cannot
   * actually deliver.
   */
  controlStates: Record<string, ControlChannelState>
  /** Keys for this room, once the director has them. Never persisted. */
  roomKeys: { directorKey: string; producerKey: string } | null

  addGuest: (options: { name?: string; peerId?: string | null }) => Guest
  removeGuest: (guestId: string) => void
  renameGuest: (guestId: string, name: string) => void
  setMutedInMix: (guestId: string, muted: boolean) => void
  setVideoHidden: (guestId: string, hidden: boolean) => void
  bindPeer: (guestId: string, peerId: string | null) => void

  setPeerState: (state: PeerState) => void
  setPeerStats: (peerId: string, stats: PeerStats) => void
  setControlState: (state: ControlChannelState) => void
  removePeer: (peerId: string) => void
  setRoomKeys: (keys: { directorKey: string; producerKey: string } | null) => void

  hydrate: (guests: Guest[], order: string[]) => void
  clear: () => void
  clearLive: () => void
}

export const useGuestStore = create<GuestState>()((set, get) => ({
  guests: {},
  order: [],
  peerStates: {},
  peerStats: {},
  controlStates: {},
  roomKeys: null,

  addGuest: ({ name, peerId }) => {
    const id = createGuestId()
    const existingNames = Object.values(get().guests).map((guest) => guest.name)
    const defaultName = `Guest ${Object.keys(get().guests).length + 1}`
    const guest: Guest = {
      id,
      name: uniqueName(name?.trim() || defaultName, existingNames),
      videoHidden: false,
      mutedInMix: false,
      peerId: peerId ?? null,
      createdAt: Date.now(),
    }
    set((state) => ({
      guests: { ...state.guests, [id]: guest },
      order: [...state.order, id],
    }))
    return guest
  },

  removeGuest: (guestId) =>
    set((state) => {
      const guest = state.guests[guestId]
      if (!guest) return state
      const guests = { ...state.guests }
      delete guests[guestId]

      const peerStates = { ...state.peerStates }
      const peerStats = { ...state.peerStats }
      const controlStates = { ...state.controlStates }
      if (guest.peerId) {
        delete peerStates[guest.peerId]
        delete peerStats[guest.peerId]
        delete controlStates[guest.peerId]
      }
      return {
        guests,
        order: state.order.filter((id) => id !== guestId),
        peerStates,
        peerStats,
        controlStates,
      }
    }),

  renameGuest: (guestId, name) =>
    set((state) => {
      const guest = state.guests[guestId]
      if (!guest) return state
      const trimmed = name.trim()
      if (!trimmed) return state
      const others = Object.values(state.guests)
        .filter((candidate) => candidate.id !== guestId)
        .map((candidate) => candidate.name)
      return { guests: { ...state.guests, [guestId]: { ...guest, name: uniqueName(trimmed, others) } } }
    }),

  setMutedInMix: (guestId, mutedInMix) =>
    set((state) => {
      const guest = state.guests[guestId]
      if (!guest) return state
      return { guests: { ...state.guests, [guestId]: { ...guest, mutedInMix } } }
    }),

  setVideoHidden: (guestId, videoHidden) =>
    set((state) => {
      const guest = state.guests[guestId]
      if (!guest) return state
      return { guests: { ...state.guests, [guestId]: { ...guest, videoHidden } } }
    }),

  bindPeer: (guestId, peerId) =>
    set((state) => {
      const guest = state.guests[guestId]
      if (!guest) return state
      return { guests: { ...state.guests, [guestId]: { ...guest, peerId } } }
    }),

  setPeerState: (peerState) =>
    set((state) => ({ peerStates: { ...state.peerStates, [peerState.peerId]: peerState } })),

  setPeerStats: (peerId, stats) =>
    set((state) => ({ peerStats: { ...state.peerStats, [peerId]: stats } })),

  setControlState: (controlState) =>
    set((state) => ({
      controlStates: { ...state.controlStates, [controlState.peerId]: controlState },
    })),

  removePeer: (peerId) =>
    set((state) => {
      const peerStates = { ...state.peerStates }
      const peerStats = { ...state.peerStats }
      const controlStates = { ...state.controlStates }
      delete peerStates[peerId]
      delete peerStats[peerId]
      delete controlStates[peerId]
      return { peerStates, peerStats, controlStates }
    }),

  setRoomKeys: (roomKeys) => set({ roomKeys }),

  hydrate: (guests, order) =>
    set(() => {
      const map: Record<string, Guest> = {}
      for (const guest of guests) {
        // A persisted guest has no live peer: connections never survive a
        // reload, so the binding is cleared rather than left dangling.
        map[guest.id] = { ...guest, peerId: null }
      }
      const known = order.filter((id) => map[id])
      const missing = guests.map((guest) => guest.id).filter((id) => !known.includes(id))
      return {
        guests: map,
        order: [...known, ...missing],
        peerStates: {},
        peerStats: {},
        controlStates: {},
      }
    }),

  clear: () =>
    set({ guests: {}, order: [], peerStates: {}, peerStats: {}, controlStates: {}, roomKeys: null }),

  clearLive: () => set({ peerStates: {}, peerStats: {}, controlStates: {}, roomKeys: null }),
}))

/* ---------------------------------------------------------------- selectors */

export const selectGuestList = (state: GuestState): Guest[] =>
  state.order.map((id) => state.guests[id]).filter((g): g is Guest => Boolean(g))

export function selectPeerForGuest(state: GuestState, guest: Guest): PeerState | null {
  if (!guest.peerId) return null
  return state.peerStates[guest.peerId] ?? null
}

export function selectStatsForGuest(state: GuestState, guest: Guest): PeerStats | null {
  if (!guest.peerId) return null
  return state.peerStats[guest.peerId] ?? null
}

/** Count of guests whose peer connection is genuinely connected. */
export function countConnectedPeers(state: GuestState): number {
  return Object.values(state.peerStates).filter((peer) => peer.status === 'connected').length
}
