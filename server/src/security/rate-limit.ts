import type { RequestMethod } from '../../../shared/protocol'

/**
 * Per-session rate limiting, by category.
 *
 * A single counter over every message is the wrong tool for signaling: a
 * director muting several guests must not be refused because the same client
 * was also pinging, and a grant refresh after a network change must not wait
 * behind state updates. Each category has its own bucket, sized for its real
 * traffic.
 *
 * A refused request is *answered* with `rate-limited`, never dropped: a
 * silently discarded request leaves a client waiting with no explanation.
 */

export type RateCategory = 'room' | 'media' | 'control' | 'keepalive'

export const METHOD_CATEGORY: Record<RequestMethod, RateCategory> = {
  join: 'room',
  leave: 'room',
  getRoomKeys: 'room',
  getMediaGrant: 'media',
  updateState: 'control',
  control: 'control',
  ping: 'keepalive',
}

export type RateLimits = Record<RateCategory, { capacity: number; refillPerSecond: number }>

export const DEFAULT_RATE_LIMITS: RateLimits = {
  room: { capacity: 10, refillPerSecond: 0.5 },
  // Grant refreshes: one per reconnect or per hour. Room for a flaky network.
  media: { capacity: 10, refillPerSecond: 0.2 },
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
