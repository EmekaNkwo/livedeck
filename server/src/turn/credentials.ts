import { createHmac, randomBytes } from 'node:crypto'
import type { IceServer } from '../../../shared/protocol'

/**
 * TURN credentials, issued per session.
 *
 * Every participant that joins gets its own short-lived username/credential
 * pair, handed over inside the join response and nowhere else. There is no
 * HTTP endpoint for credentials: an unauthenticated URL that answers with a
 * relay credential is a free relay for whoever finds it, billed to the
 * operator. The previous design served one credential valid for a day to
 * anyone who asked.
 *
 * Two providers:
 *
 *   cloudflare   Cloudflare Realtime TURN. Minted through its API with the
 *                token kept in this process.
 *   static       Any coturn-compatible server using `use-auth-secret`: the
 *                credential is an HMAC of an expiring username, computed here
 *                with the shared secret. No API call.
 *
 * Neither is required. Without one the studio is STUN-only and connections
 * from behind symmetric NAT fail, which the client reports honestly.
 */

export type TurnGrant = {
  iceServers: IceServer[]
  /** Epoch ms after which the credential stops working. */
  expiresAt: number
}

export type TurnProvider = {
  kind: 'cloudflare' | 'static'
  /** A fresh credential for one session. */
  issue: () => Promise<TurnGrant>
}

export const DEFAULT_TTL_SECONDS = 3600
const MIN_TTL_SECONDS = 600
const MAX_TTL_SECONDS = 7200
const REQUEST_TIMEOUT_MS = 8000
const CLOUDFLARE_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'

export type TurnConfig =
  | { kind: 'cloudflare'; keyId: string; apiToken: string; ttlSeconds: number }
  | { kind: 'static'; urls: string[]; secret: string; ttlSeconds: number }

function readTtl(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_TTL_SECONDS)
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(parsed)))
}

/** Read TURN configuration; null means STUN-only, which is a supported state. */
export function readTurnConfig(env: Record<string, string | undefined>): TurnConfig | null {
  const ttlSeconds = readTtl(env.TURN_TTL_SECONDS ?? env.CLOUDFLARE_TURN_TTL_SECONDS)
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim()
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim()
  if (keyId && apiToken) return { kind: 'cloudflare', keyId, apiToken, ttlSeconds }

  const urls = (env.TURN_URLS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^turns?:/i.test(entry))
  const secret = env.TURN_STATIC_AUTH_SECRET?.trim()
  if (urls.length > 0 && secret) return { kind: 'static', urls, secret, ttlSeconds }
  return null
}

/** Normalize Cloudflare's response into ICE servers. Exported for tests. */
export function parseIceServers(body: unknown): IceServer[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('TURN response was not a JSON object.')
  }
  const raw = (body as { iceServers?: unknown }).iceServers
  const entries = Array.isArray(raw) ? raw : [raw]
  const servers: IceServer[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const { urls, username, credential } = entry as {
      urls?: unknown
      username?: unknown
      credential?: unknown
    }
    const list = (Array.isArray(urls) ? urls : [urls]).filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    )
    if (list.length === 0) continue
    const server: IceServer = { urls: list }
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

export function hasRelay(servers: readonly IceServer[]): boolean {
  return servers.some((server) =>
    server.urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:')),
  )
}

export type TurnProviderDeps = {
  fetchImpl?: typeof fetch
  now?: () => number
}

export function createTurnProvider(config: TurnConfig, deps: TurnProviderDeps = {}): TurnProvider {
  const now = deps.now ?? Date.now
  if (config.kind === 'static') {
    return {
      kind: 'static',
      issue: async () => {
        const expiresAtSeconds = Math.floor(now() / 1000) + config.ttlSeconds
        // coturn's REST API: username is `<expiry>:<anything>`, credential is
        // base64(HMAC-SHA1(secret, username)).
        const username = `${expiresAtSeconds}:${randomBytes(8).toString('hex')}`
        const credential = createHmac('sha1', config.secret).update(username).digest('base64')
        return {
          iceServers: [{ urls: config.urls, username, credential }],
          expiresAt: expiresAtSeconds * 1000,
        }
      },
    }
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  return {
    kind: 'cloudflare',
    issue: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetchImpl(
          `${CLOUDFLARE_API_BASE}/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`,
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
          const detail = await response.text().catch(() => '')
          const hint =
            response.status === 401 || response.status === 403
              ? 'Check that CLOUDFLARE_TURN_API_TOKEN is the token issued with this TURN key. '
              : response.status === 404
                ? 'Check that CLOUDFLARE_TURN_KEY_ID is the "Turn Token ID" from the dashboard. '
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
    },
  }
}

/** Public STUN, always included so host-only networks still gather srflx. */
export const DEFAULT_STUN_SERVERS: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
]
