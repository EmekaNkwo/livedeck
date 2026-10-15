import type { RequestMethod } from '../../../shared/protocol'

/**
 * Per-session rate limiting, by category.
 *
 * A single counter over every message is the wrong tool for signaling: a
 * participant joining a full room legitimately fires a burst of transport and
 * consumer requests, and an ICE restart during a network change must never be
 * refused because the same client was also sending state updates. Each
 * category has its own bucket, sized for its real traffic.
 *
 * A refused request is *answered* with `rate-limited`, never dropped: a
 * silently discarded media request leaves a connection hanging with no
 * explanation on either side.
 */

export type RateCategory = 'room' | 'media' | 'ice' | 'control' | 'keepalive'

export const METHOD_CATEGORY: Record<RequestMethod, RateCategory> = {
  join: 'room',
  leave: 'room',
  getRoomKeys: 'room',
  getRouterRtpCapabilities: 'keepalive',
  createWebRtcTransport: 'media',
  connectWebRtcTransport: 'media',
  produce: 'media',
  consume: 'media',
  resumeConsumer: 'media',
  pauseConsumer: 'media',
  closeConsumer: 'media',
  pauseProducer: 'media',
  resumeProducer: 'media',
  closeProducer: 'media',
  restartIce: 'ice',
  updateState: 'control',
  control: 'control',
  ping: 'keepalive',
}

export type RateLimits = Record<RateCategory, { capacity: number; refillPerSecond: number }>

export const DEFAULT_RATE_LIMITS: RateLimits = {
  room: { capacity: 10, refillPerSecond: 0.5 },
  // A twelve-peer room on join: two transports, two connects, up to three
  // producers and ~30 consumers plus their resumes. Well inside this.
  media: { capacity: 150, refillPerSecond: 15 },
  ice: { capacity: 20, refillPerSecond: 1 },
  control: { capacity: 40, refillPerSecond: 4 },
  keepalive: { capacity: 30, refillPerSecond: 1 },
}

type Bucket = { tokens: number; updatedAt: number }

export type RateLimiter = {
  /** Spend one token from the category's bucket. False when empty. */
  allow: (category: RateCategory) => boolean
}

export function createRateLimiter(
  limits: RateLimits = DEFAULT_RATE_LIMITS,
  now: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<RateCategory, Bucket>()
  return {
    allow: (category) => {
      const limit = limits[category]
      const timestamp = now()
      const bucket = buckets.get(category) ?? { tokens: limit.capacity, updatedAt: timestamp }
      const elapsedSeconds = Math.max(0, timestamp - bucket.updatedAt) / 1000
      const tokens = Math.min(limit.capacity, bucket.tokens + elapsedSeconds * limit.refillPerSecond)
      if (tokens < 1) {
        buckets.set(category, { tokens, updatedAt: timestamp })
        return false
      }
      buckets.set(category, { tokens: tokens - 1, updatedAt: timestamp })
      return true
    },
  }
}
