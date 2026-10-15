import type { MediasoupConfig } from '../mediasoup/config'
import { Room, RoomError } from '../mediasoup/room'
import type { WorkerPool } from '../mediasoup/worker-pool'

/**
 * Creates rooms on demand and drops them when the last participant leaves.
 *
 * A room is created by whoever names it first. There is no "create room"
 * step for operators because the product has no accounts: the director's
 * authority comes from the room key, not from having arrived first. See
 * `signaling/authorization.ts`.
 */

export type RoomLimits = {
  maxPeersPerRoom: number
  maxRooms: number
}

export const DEFAULT_ROOM_LIMITS: RoomLimits = {
  // Twelve participants is the product's stated ceiling. Viewers count too:
  // each one is a full set of consumers on the router.
  maxPeersPerRoom: 12,
  maxRooms: 200,
}

export type RoomManager = {
  getOrCreate: (name: string) => Promise<Room>
  get: (name: string) => Room | null
  /** Drop a room if it is empty. Call after every leave. */
  reapIfEmpty: (name: string) => void
  stats: () => { rooms: number; peers: number }
  closeAll: () => void
}

export function createRoomManager(options: {
  pool: WorkerPool
  config: MediasoupConfig
  limits?: Partial<RoomLimits>
  log: (event: string, detail?: Record<string, unknown>) => void
}): RoomManager {
  const limits = { ...DEFAULT_ROOM_LIMITS, ...options.limits }
  const rooms = new Map<string, Room>()
  // Two joins racing on a new room must share one router.
  const creating = new Map<string, Promise<Room>>()

  const getOrCreate = async (name: string): Promise<Room> => {
    const existing = rooms.get(name)
    if (existing && !existing.isClosed) return existing
    const pending = creating.get(name)
    if (pending) return pending

    if (rooms.size >= limits.maxRooms) {
      throw new RoomError('server-full', 'The server is at capacity. Try again shortly.')
    }
    const promise = Room.create(options.pool, {
      name,
      config: options.config,
      maxPeers: limits.maxPeersPerRoom,
      log: options.log,
    })
      .then((room) => {
        rooms.set(name, room)
        options.log('room-created', { room: name })
        return room
      })
      .finally(() => creating.delete(name))
    creating.set(name, promise)
    return promise
  }

  return {
    getOrCreate,
    get: (name) => {
      const room = rooms.get(name)
      return room && !room.isClosed ? room : null
    },
    reapIfEmpty: (name) => {
      const room = rooms.get(name)
      if (!room || !room.isEmpty) return
      rooms.delete(name)
      room.close('room-closed')
    },
    stats: () => ({
      rooms: rooms.size,
      peers: [...rooms.values()].reduce((sum, room) => sum + room.peers.size, 0),
    }),
    closeAll: () => {
      for (const room of rooms.values()) room.close('server-shutdown')
      rooms.clear()
    },
  }
}
