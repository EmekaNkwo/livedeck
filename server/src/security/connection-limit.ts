import type { IncomingMessage } from 'node:http'

/**
 * Caps on open sockets, per client address and in total.
 *
 * Without these one client can hold every file descriptor the process has.
 * The per-address cap is generous because a household behind one NAT may
 * legitimately have several participants.
 */

export type ConnectionLimits = {
  maxPerAddress: number
  maxTotal: number
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  maxPerAddress: 24,
  maxTotal: 2000,
}

export type ConnectionLimiter = {
  /** Reserve a slot for the address. False when a cap is reached. */
  acquire: (address: string) => boolean
  release: (address: string) => void
  count: () => number
}

export function createConnectionLimiter(
  limits: ConnectionLimits = DEFAULT_CONNECTION_LIMITS,
): ConnectionLimiter {
  const perAddress = new Map<string, number>()
  let total = 0
  return {
    acquire: (address) => {
      const current = perAddress.get(address) ?? 0
      if (total >= limits.maxTotal || current >= limits.maxPerAddress) return false
      perAddress.set(address, current + 1)
      total += 1
      return true
    },
    release: (address) => {
      const current = perAddress.get(address) ?? 0
      if (current <= 1) perAddress.delete(address)
      else perAddress.set(address, current - 1)
      total = Math.max(0, total - 1)
    },
    count: () => total,
  }
}

/**
 * The client's address, honouring `X-Forwarded-For` only when told to.
 *
 * Behind a proxy every socket arrives from the proxy's address, so the cap
 * would count the proxy. Trusting the header without a proxy lets a client
 * forge any address it likes, which defeats the cap the other way.
 */
export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = request.headers['x-forwarded-for']
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim()
    if (first) return first
  }
  return request.socket.remoteAddress ?? 'unknown'
}
