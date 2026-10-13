import type { IceServerConfig } from '@/types/peer'

/**
 * Fetch short-lived TURN credentials from the signaling relay.
 *
 * The relay holds the Cloudflare API token and mints credentials with it (see
 * `server/src/turn.ts`); this is the browser half — it asks, caches, and hands
 * the result to the peer manager as pre-resolved `IceServerConfig`s.
 *
 * WHY NOT THE `turn:host:port|user:pass` SETTINGS FORMAT
 * -----------------------------------------------------
 * `ice.ts` accepts TURN servers as strings with credentials appended after a
 * `|`, which is right for a value an operator types into Settings. Credentials
 * minted by Cloudflare go around that format deliberately: the username is a
 * long opaque token and the credential is base64, either of which may contain
 * a `:` — and the settings parser splits the credential pair on the first one.
 * Routing a generated secret through a lossy string encoding would truncate it
 * and produce a 401 from the relay that looks like a wrong token.
 *
 * FAILURE IS NOT FATAL
 * --------------------
 * Every failure path resolves to an empty list rather than throwing. Losing
 * TURN degrades the studio to STUN-only — which still connects on most home
 * and office networks — whereas throwing would abort the whole handshake and
 * take down connections that never needed a relay. The error is reported
 * through `onError` so the operator sees it, instead of being swallowed.
 */

export type TurnCredentialSource = {
  /** Cached servers, fetching when the cache is cold or near expiry. */
  resolve: () => Promise<IceServerConfig[]>
  /** Drop the cache — used when the relay address changes. */
  reset: () => void
}

export type TurnCredentialSourceOptions = {
  /** Absolute URL of the relay's `/ice-servers`. Empty disables the source. */
  endpoint: string
  /** Called with a human-readable message when credentials cannot be had. */
  onError?: (message: string) => void
  fetchImpl?: typeof fetch
  now?: () => number
}

/** Past this, re-fetch rather than reuse. Mirrors the server's own margin. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * Cache lifetime when the relay reports no expiry.
 *
 * A grant without `expiresAt` is still ephemeral — we just cannot see when it
 * lapses — so it is held briefly rather than for the session.
 */
const FALLBACK_TTL_MS = 10 * 60 * 1000

/** A hung request must not stall the handshake behind it. */
const REQUEST_TIMEOUT_MS = 6000

type Cache = {
  servers: IceServerConfig[]
  expiresAt: number
}

type IceServersResponse = {
  configured?: unknown
  iceServers?: unknown
  expiresAt?: unknown
  error?: unknown
}

export function createTurnCredentialSource(
  options: TurnCredentialSourceOptions,
): TurnCredentialSource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const now = options.now ?? Date.now

  let cache: Cache | null = null
  let inFlight: Promise<IceServerConfig[]> | null = null
  /*
   * Report a given failure once per source.
   *
   * Credentials are resolved on every offer and every answer, so a relay that
   * is down would otherwise raise an identical toast per guest per attempt and
   * bury the rest of the UI.
   */
  let lastReported = ''

  const report = (message: string): void => {
    if (message === lastReported) return
    lastReported = message
    options.onError?.(message)
  }

  const fetchServers = async (): Promise<IceServerConfig[]> => {
    if (!fetchImpl) return []

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(options.endpoint, {
        method: 'GET',
        // No custom headers: this stays a CORS "simple request", so the studio
        // on :5173 reaches the relay on :3001 without a preflight.
        signal: controller.signal,
        cache: 'no-store',
      })

      const body = (await response.json().catch(() => null)) as IceServersResponse | null

      if (!response.ok) {
        const detail =
          body && typeof body.error === 'string'
            ? body.error
            : `The relay answered ${response.status}.`
        report(`TURN relay unavailable, so connections fall back to STUN only. ${detail}`)
        return []
      }

      // A relay with no TURN key is the project's default, not a fault — stay
      // quiet and let `describeIceFailure` explain it if a connection fails.
      if (body?.configured === false) return []

      const servers = parseIceServers(body?.iceServers)
      if (servers.length === 0) {
        report(
          'The relay reported TURN as configured but returned no usable ICE servers. ' +
            'Check the relay log for a Cloudflare API error.',
        )
        return []
      }

      const expiresAt =
        typeof body?.expiresAt === 'number' && Number.isFinite(body.expiresAt)
          ? body.expiresAt
          : now() + FALLBACK_TTL_MS
      cache = { servers, expiresAt }
      // A later success clears the latch, so a recurring outage is reported
      // again rather than being silenced for the rest of the session.
      lastReported = ''
      return servers
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? `The relay did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
          : error instanceof Error
            ? error.message
            : 'Unknown error.'
      report(
        `TURN credentials could not be fetched, so connections fall back to STUN only. ${message}`,
      )
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async resolve(): Promise<IceServerConfig[]> {
      if (!options.endpoint) return []
      if (cache && cache.expiresAt - REFRESH_MARGIN_MS > now()) return cache.servers
      // Several guests joining at once share one request.
      if (inFlight) return inFlight

      inFlight = fetchServers().finally(() => {
        inFlight = null
      })
      return inFlight
    },
    reset(): void {
      cache = null
      lastReported = ''
    },
  }
}

/**
 * Narrow an untrusted `iceServers` payload.
 *
 * The relay is our own code, but it is a separate process that can be an older
 * deployment, so the payload is validated at the boundary rather than trusted.
 * A malformed entry is dropped instead of failing the batch: a usable relay URL
 * alongside one broken entry is still worth connecting with.
 */
export function parseIceServers(raw: unknown): IceServerConfig[] {
  if (!Array.isArray(raw)) return []

  const servers: IceServerConfig[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { urls, username, credential } = entry as {
      urls?: unknown
      username?: unknown
      credential?: unknown
    }
    const list = (Array.isArray(urls) ? urls : [urls]).filter(
      (url): url is string =>
        typeof url === 'string' &&
        /^(stun|stuns|turn|turns):/i.test(url),
    )
    if (list.length === 0) continue

    const server: IceServerConfig = { urls: list }
    if (typeof username === 'string' && username) server.username = username
    if (typeof credential === 'string' && credential) server.credential = credential
    servers.push(server)
  }
  return servers
}
