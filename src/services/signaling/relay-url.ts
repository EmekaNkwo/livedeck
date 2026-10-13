/**
 * Where the signaling relay lives when the operator has not said.
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

/** Path the relay serves TURN credentials on. See `server/src/turn-route.ts`. */
export const ICE_SERVERS_PATH = '/ice-servers'

/**
 * The HTTP endpoint that mints TURN credentials, derived from the relay URL.
 *
 * Derived rather than configured separately because the two are the same
 * process: the relay holds the Cloudflare API token, so wherever `/signal` is
 * reachable, `/ice-servers` is too. Asking an operator to set a second address
 * is a second thing to get wrong, and a mismatch would present as "TURN is
 * configured but no relay candidates appear".
 *
 * `VITE_ICE_SERVERS_URL` overrides it for the one deployment where that is not
 * true — credentials minted by a separate service.
 *
 * Returns '' when no address can be determined, which the caller treats the
 * same as an unconfigured relay: STUN only.
 */
export function iceServersUrl(relayUrl: string): string {
  const override = import.meta.env.VITE_ICE_SERVERS_URL
  if (typeof override === 'string' && override.trim()) return override.trim()

  const resolved = resolveRelayUrl(relayUrl)
  if (!resolved) return ''

  try {
    // `ws:`/`wss:` are not special-cased by URL, so the scheme is swapped
    // before parsing rather than after — `url.protocol = 'http:'` on a
    // WebSocket URL is not reliably applied across browsers.
    const asHttp = resolved.replace(/^ws(s)?:/i, (_match, secure) =>
      secure ? 'https:' : 'http:',
    )
    const url = new URL(asHttp)
    /*
     * Replace the path rather than appending to it.
     *
     * A relay URL commonly carries `/signal` — either typed by an operator or
     * produced by a proxy config — and appending would ask for
     * `/signal/ice-servers`, which the relay does not serve.
     */
    url.pathname = ICE_SERVERS_PATH
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    // An unparseable relay address is already reported by the transport; this
    // just declines to guess at an endpoint.
    return ''
  }
}
