import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeOrigin } from './signaling'
import { hasRelay, type TurnProvider } from './turn'

/**
 * `GET /ice-servers` — hand the browser short-lived TURN credentials.
 *
 * WHY A PLAIN GET AND NOT A NEXT ROUTE
 * ------------------------------------
 * Same reason the relay itself is not a route handler: the credential cache in
 * `turn.ts` is per-process state, and a serverless handler would mint a fresh
 * grant per request. This is prepended to the HTTP server beside `/healthz`.
 *
 * It is a `GET` with no custom request headers *on purpose* — that makes it a
 * CORS "simple request", so the studio on :5173 reaches the relay on :3001
 * without a preflight round trip during development.
 *
 * NOT-CONFIGURED IS A 200
 * -----------------------
 * A relay with no TURN key answers `{ configured: false, iceServers: [] }`
 * rather than a 4xx. Running without TURN is the project's default and the
 * studio must not log it as a failure — it already explains the STUN-only
 * limitation at the point where a connection actually fails. A non-2xx here
 * would make the common case look broken.
 */

export type TurnRouteOptions = {
  path?: string
  /** Allowed browser origins. Empty means reflect any — local dev only. */
  allowedOrigins?: string[]
  /** Null when no TURN key is configured. */
  provider: TurnProvider | null
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export type TurnRoute = {
  /** True when the request was this route's and a response has been written. */
  handle: (request: IncomingMessage, response: ServerResponse) => boolean
}

export function createTurnRoute(options: TurnRouteOptions): TurnRoute {
  const path = options.path ?? '/ice-servers'
  const allowedOrigins = (options.allowedOrigins ?? []).map(normalizeOrigin).filter(Boolean)
  const log =
    options.log ??
    ((event: string, detail?: Record<string, unknown>) => {
      console.log(`[turn] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
    })

  /*
   * Echo the caller's origin when it is allowed, rather than sending `*`.
   *
   * `*` would work — these credentials are per-request and short-lived, not
   * ambient authority — but echoing keeps the allow-list meaningful and means
   * the browser's own error message names the origin that was refused.
   */
  const corsOrigin = (request: IncomingMessage): string | null => {
    const origin = request.headers.origin
    if (!origin) return null
    if (allowedOrigins.length === 0) return origin
    return allowedOrigins.includes(normalizeOrigin(origin)) ? origin : null
  }

  const send = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    const origin = corsOrigin(request)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Credentials are per-request and expire; a shared cache holding them
      // would hand one browser another's grant past its usefulness.
      'cache-control': 'no-store',
      vary: 'origin',
    }
    if (origin) headers['access-control-allow-origin'] = origin
    response.writeHead(status, headers)
    response.end(JSON.stringify(body))
  }

  return {
    handle(request, response) {
      // Ignore any query string; this route takes no parameters.
      const url = (request.url ?? '').split('?')[0]
      if (url !== path) return false

      if (request.method === 'OPTIONS') {
        // Not needed for the studio's own simple GET, but a client that adds a
        // header would preflight, and a 404 there is a confusing failure.
        const origin = corsOrigin(request)
        const headers: Record<string, string> = {
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '86400',
          vary: 'origin',
        }
        if (origin) headers['access-control-allow-origin'] = origin
        response.writeHead(204, headers)
        response.end()
        return true
      }

      if (request.method !== 'GET') {
        send(request, response, 405, { error: 'Use GET.' })
        return true
      }

      if (!options.provider) {
        send(request, response, 200, { configured: false, iceServers: [] })
        return true
      }

      void options.provider
        .get()
        .then((grant) => {
          /*
           * Warn when a grant carries no relay.
           *
           * A valid response that is STUN-only leaves the studio in exactly the
           * state TURN was added to fix, and nothing downstream can tell the
           * difference between that and no TURN key at all.
           */
          if (!hasRelay(grant.iceServers)) {
            log('grant-without-relay', { servers: grant.iceServers.length })
          }
          send(request, response, 200, {
            configured: true,
            iceServers: grant.iceServers,
            expiresAt: grant.expiresAt,
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unknown error'
          log('mint-failed', { message })
          /*
           * 502, and say why.
           *
           * The studio shows this message to the operator. A generic 500 would
           * send them to the browser console for a problem whose cause — a
           * rotated token, a Cloudflare outage — is only visible here.
           */
          send(request, response, 502, {
            configured: true,
            iceServers: [],
            error: `TURN credentials could not be issued: ${message}`,
          })
        })

      return true
    },
  }
}
