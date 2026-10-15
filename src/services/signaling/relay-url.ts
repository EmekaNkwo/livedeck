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
 *  2. A development build (Vite's dev server) assumes the relay is beside it
 *     on {@link DEV_RELAY_PORT}, which is where `server/` listens by default.
 *  3. A production build uses the page's own origin, port included: a
 *     deployed studio sits behind a proxy that also fronts `/signal`, and
 *     that proxy may listen on any port.
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
  const { protocol, hostname, host } = window.location
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:'

  // The dev server is not the relay; the relay is a second process beside
  // it. A built studio is served by the proxy that also carries `/signal`.
  return isDevBuild() ? `${scheme}//${hostname}:${DEV_RELAY_PORT}` : `${scheme}//${host}`
}

function isDevBuild(): boolean {
  return import.meta.env.DEV === true
}

/** The address to actually dial: whatever is configured, else the default. */
export function resolveRelayUrl(configured: string): string {
  return configured.trim() || defaultRelayUrl()
}
