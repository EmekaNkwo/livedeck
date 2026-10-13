/**
 * Cloudflare Realtime TURN credentials, minted server-side.
 *
 * WHY THIS LIVES ON THE SERVER
 * ----------------------------
 * Cloudflare's TURN API is authenticated with a long-lived API token that can
 * mint credentials for your account indefinitely. Putting it in a `VITE_*`
 * variable would compile it into the browser bundle, where it is readable by
 * anyone who opens devtools — someone else's relay bandwidth, billed to you.
 *
 * So the token stays in this process and the browser never sees it. What the
 * browser gets instead is a *short-lived* username/credential pair that expires
 * on its own, which is the whole point of the ephemeral-credential design.
 *
 * This is the one piece of LiveDeck that genuinely requires a server to be
 * useful. The studio still runs without it — it just falls back to STUN-only
 * and reports `failed` honestly on networks that need a relay, exactly as
 * `src/services/webrtc/ice.ts` describes.
 */

/** Shape handed to the browser; mirrors `IceServerConfig` in `src/types/peer.ts`. */
export type IceServerPayload = {
  urls: string[]
  username?: string
  credential?: string
}

export type TurnConfig = {
  /** Cloudflare "Turn Token ID". Not a secret, but no reason to publish it. */
  keyId: string
  /** The API token. Secret — never leaves this process. */
  apiToken: string
  /** Credential lifetime requested from Cloudflare, in seconds. */
  ttlSeconds: number
}

export type TurnProvider = {
  /** Cached credentials, minting fresh ones when the cache is cold or stale. */
  get: () => Promise<TurnGrant>
}

export type TurnGrant = {
  iceServers: IceServerPayload[]
  /** Epoch ms after which these credentials should not be handed out. */
  expiresAt: number
}

/**
 * Default credential lifetime: 24 hours, which is Cloudflare's own example.
 *
 * Erring long is deliberate. A credential only has to be valid when the peer
 * allocates its relay, but a broadcast can run for hours and a re-allocation
 * mid-call (an ICE restart, a guest reconnecting) must not find an expired
 * secret. The grant is still ephemeral — it expires without any revocation
 * step — and {@link createTurnProvider} re-mints well before it lapses.
 */
export const DEFAULT_TTL_SECONDS = 86_400

/**
 * Re-mint this far before expiry rather than at it.
 *
 * A credential handed out at the last second would be useless by the time the
 * browser allocated with it, and the failure would look like a TURN outage.
 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000

/** Cloudflare refuses a request that hangs; don't hold the client longer. */
const REQUEST_TIMEOUT_MS = 8000

const API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/**
 * Read the TURN configuration from the environment, or return null.
 *
 * Null is a supported state, not an error: a relay with no TURN key is the
 * default deployment, and the endpoint reports that plainly rather than
 * pretending to be misconfigured.
 */
export function readTurnConfig(env: Record<string, string | undefined>): TurnConfig | null {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim()
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim()
  if (!keyId || !apiToken) return null

  const rawTtl = Number(env.CLOUDFLARE_TURN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS)
  /*
   * A bad TTL falls back rather than throwing.
   *
   * The floor matters: Cloudflare accepts a tiny TTL, and a 30-second
   * credential produces connections that come up and then drop with no error
   * anyone would connect to the TTL. The ceiling is Cloudflare's own maximum
   * for the endpoint.
   */
  const ttlSeconds =
    Number.isFinite(rawTtl) && rawTtl >= 600 && rawTtl <= 172_800
      ? Math.floor(rawTtl)
      : DEFAULT_TTL_SECONDS

  return { keyId, apiToken, ttlSeconds }
}

/**
 * Normalize Cloudflare's response into a list of ICE servers.
 *
 * The endpoint returns a single `iceServers` **object** carrying every URL
 * under one credential pair, but the field is documented loosely enough that an
 * array is plausible too, and a response shape change would otherwise surface
 * as a blank TURN list with no explanation. Both are accepted; anything else
 * throws with the body quoted, because a silently empty list here is precisely
 * the failure this whole feature exists to prevent.
 */
export function parseIceServers(body: unknown): IceServerPayload[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('TURN response was not a JSON object.')
  }
  const raw = (body as { iceServers?: unknown }).iceServers
  const entries = Array.isArray(raw) ? raw : [raw]

  const servers: IceServerPayload[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const { urls, username, credential } = entry as {
      urls?: unknown
      username?: unknown
      credential?: unknown
    }
    // `urls` is a string[] in practice, but the WebRTC spec allows a bare
    // string and Cloudflare is free to use it.
    const list = (Array.isArray(urls) ? urls : [urls]).filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    )
    if (list.length === 0) continue

    const server: IceServerPayload = { urls: list }
    if (typeof username === 'string' && username) server.username = username
    if (typeof credential === 'string' && credential) server.credential = credential
    servers.push(server)
  }

  if (servers.length === 0) {
    throw new Error(
      `TURN response contained no usable ICE servers: ${JSON.stringify(body).slice(0, 300)}`,
    )
  }
  return servers
}

/** True when the grant contains at least one `turn:`/`turns:` URL. */
export function hasRelay(servers: readonly IceServerPayload[]): boolean {
  return servers.some((server) =>
    server.urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:')),
  )
}

export type TurnProviderDeps = {
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * A caching front for the credential API.
 *
 * Caching is not an optimization here. Every guest joining a room asks for
 * credentials, and a 12-guest room reloading would otherwise be 12 calls to
 * Cloudflare for credentials that are interchangeable — plus the same again on
 * every refresh. One grant is shared until it nears expiry.
 *
 * In-flight requests are deduplicated for the same reason: a burst of joins on
 * a cold cache must not become a burst of API calls.
 */
export function createTurnProvider(
  config: TurnConfig,
  deps: TurnProviderDeps = {},
): TurnProvider {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now

  let cached: TurnGrant | null = null
  let inFlight: Promise<TurnGrant> | null = null

  const isUsable = (grant: TurnGrant | null): grant is TurnGrant =>
    grant !== null && grant.expiresAt - REFRESH_MARGIN_MS > now()

  const mint = async (): Promise<TurnGrant> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetchImpl(
        `${API_BASE}/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ttl: config.ttlSeconds }),
          signal: controller.signal,
        },
      )

      if (!response.ok) {
        /*
         * Read the body for the message, but never log the token.
         *
         * The two statuses worth naming a variable for are the two setup
         * mistakes that otherwise both present as "no relay candidates":
         *
         *  - 401/403: the API token is wrong, rotated, or lacks TURN scope.
         *  - 404 `cannot find specified key`: the *key id* is wrong. Verified
         *    against the live API — Cloudflare does not use 403 for this, so
         *    without the branch a typo'd key id reads as a server fault.
         */
        const detail = await response.text().catch(() => '')
        const hint =
          response.status === 401 || response.status === 403
            ? 'Check that CLOUDFLARE_TURN_API_TOKEN is the token issued with this TURN key and has not been rotated. '
            : response.status === 404
              ? 'Check that CLOUDFLARE_TURN_KEY_ID is the "Turn Token ID" from the Cloudflare dashboard — this status means the key does not exist. '
              : ''
        throw new Error(
          `Cloudflare TURN API returned ${response.status}. ${hint}${detail.slice(0, 300)}`,
        )
      }

      const iceServers = parseIceServers(await response.json())
      return { iceServers, expiresAt: now() + config.ttlSeconds * 1000 }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async get(): Promise<TurnGrant> {
      if (isUsable(cached)) return cached
      if (inFlight) return inFlight

      inFlight = mint()
      try {
        const grant = await inFlight
        cached = grant
        return grant
      } catch (error) {
        /*
         * A failed mint does not poison the cache.
         *
         * If a previous grant is still technically valid — inside the refresh
         * margin but not yet expired — it is better than nothing while
         * Cloudflare is briefly unreachable, so serve it and let the next
         * request retry.
         */
        if (cached && cached.expiresAt > now()) return cached
        throw error
      } finally {
        inFlight = null
      }
    },
  }
}
