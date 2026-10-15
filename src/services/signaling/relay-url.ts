/**
 * Where the media server lives when the operator has not said.
 *
 * Room-based joining is the default workflow — a guest opens a room link and
 * appears, with nothing to copy back — and that requires a relay. So a blank
 * server address has to resolve to something plausible rather than leaving the
 * studio configured for a transport it cannot reach.
 *
 * Resolution order:
 *
 *  1. `VITE_SIGNALING_URL`, for a deployed studio whose relay is elsewhere.
 *  2. During development (the page URL carries an explicit port, e.g. Vite on
 *     5173) the relay is assumed to be beside it on {@link DEV_RELAY_PORT},
 *     which is where `server/` listens by default.
 *  3. Otherwise the page's own origin, on the assumption that a studio served
 *     without a port sits behind a proxy that also fronts `/signal`.
 *
 * None of this is a promise that the relay is *up*. The transport reports its
 * own state, and the Guests panel says so plainly when it cannot connect.
 */

/** The port `server/` binds by default. Matches `PORT` in `server/.env`. */
export const DEV_RELAY_PORT = '3001'

export function defaultRelayUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL
  if (typeof configured === 'string' && configured.trim()) return configured.trim()

  if (typeof window === 'undefined') return ''
  const { protocol, hostname, port } = window.location
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:'

  // A port in the page URL means a dev server, which is not the relay — the
  // relay is a second process beside it. No port means a proxied deployment,
  // where the same origin is the best guess available.
  return port ? `${scheme}//${hostname}:${DEV_RELAY_PORT}` : `${scheme}//${hostname}`
}

/** The address to actually dial: whatever is configured, else the default. */
export function resolveRelayUrl(configured: string): string {
  return configured.trim() || defaultRelayUrl()
}
