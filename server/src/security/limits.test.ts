import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { clientAddress, createConnectionLimiter } from './connection-limit'
import { METHOD_CATEGORY, createRateLimiter } from './rate-limit'
import { DEFAULT_ROOM_LIMITS, readRoomLimits } from '../rooms/room-manager'
import { REQUEST_METHODS } from '../../../shared/protocol'

describe('rate limiter', () => {
  it('maps every protocol method to a category', () => {
    for (const method of REQUEST_METHODS) expect(METHOD_CATEGORY[method]).toBeDefined()
  })

  it('keeps categories independent', () => {
    let now = 0
    const limiter = createRateLimiter(
      { ...{ room: { capacity: 2, refillPerSecond: 1 } }, media: { capacity: 2, refillPerSecond: 1 }, ice: { capacity: 1, refillPerSecond: 1 }, control: { capacity: 1, refillPerSecond: 1 }, keepalive: { capacity: 1, refillPerSecond: 1 } },
      () => now,
    )
    expect(limiter.allow('room')).toBe(true)
    expect(limiter.allow('room')).toBe(true)
    expect(limiter.allow('room')).toBe(false)
    // Exhausting room ops does not touch ICE.
    expect(limiter.allow('ice')).toBe(true)
    now = 2000
    expect(limiter.allow('room')).toBe(true)
  })

  it('refills continuously, not per window', () => {
    let now = 0
    const limiter = createRateLimiter(
      { room: { capacity: 1, refillPerSecond: 2 }, media: { capacity: 1, refillPerSecond: 1 }, ice: { capacity: 1, refillPerSecond: 1 }, control: { capacity: 1, refillPerSecond: 1 }, keepalive: { capacity: 1, refillPerSecond: 1 } },
      () => now,
    )
    expect(limiter.allow('room')).toBe(true)
    expect(limiter.allow('room')).toBe(false)
    now = 500
    expect(limiter.allow('room')).toBe(true)
  })
})

describe('connection limiter', () => {
  it('caps per address and in total', () => {
    const limiter = createConnectionLimiter({ maxPerAddress: 2, maxTotal: 3 })
    expect(limiter.acquire('a')).toBe(true)
    expect(limiter.acquire('a')).toBe(true)
    expect(limiter.acquire('a')).toBe(false)
    expect(limiter.acquire('b')).toBe(true)
    expect(limiter.acquire('c')).toBe(false)
    limiter.release('a')
    expect(limiter.acquire('c')).toBe(true)
    expect(limiter.count()).toBe(3)
  })

  it('reads the forwarded address only when told to trust the proxy', () => {
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as IncomingMessage
    expect(clientAddress(request, false)).toBe('10.0.0.1')
    expect(clientAddress(request, true)).toBe('203.0.113.9')
  })
})

describe('room limits', () => {
  it('defaults to room for twelve guests plus crew, and reads overrides', () => {
    expect(DEFAULT_ROOM_LIMITS.maxPeersPerRoom).toBeGreaterThanOrEqual(13)
    expect(readRoomLimits({})).toEqual(DEFAULT_ROOM_LIMITS)
    expect(readRoomLimits({ ROOM_MAX_PEERS: '20', MAX_ROOMS: '50' })).toEqual({ maxPeersPerRoom: 20, maxRooms: 50 })
    expect(readRoomLimits({ ROOM_MAX_PEERS: 'lots', MAX_ROOMS: '-1' })).toEqual(DEFAULT_ROOM_LIMITS)
    expect(readRoomLimits({ ROOM_MAX_PEERS: '999' }).maxPeersPerRoom).toBe(64)
  })
})
