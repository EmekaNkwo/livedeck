import { createServer } from 'node:http'
import next from 'next'
import { attachSignaling, normalizeOrigin } from './signaling'

/**
 * The signaling host: Next.js plus a WebSocket relay in one Node process.
 *
 * Next is run programmatically so the same HTTP server can own the `upgrade`
 * event. A Next route handler cannot do this — handlers are per-request, and on
 * a serverless platform the process does not outlive the response, whereas a
 * relay is a long-lived process holding in-memory room state.
 *
 * Deploy target: a container or VM (Fly, Render, Railway, a VPS). **Not**
 * Vercel's serverless runtime, which cannot hold a WebSocket open.
 */

const port = Number(process.env.PORT ?? 3001)

/*
 * Bind address.
 *
 * Deliberately *not* `HOSTNAME`: on Windows that variable already holds the
 * machine name, so reading it bound the server to `HAYMAYKUS` instead of every
 * interface — and `http://localhost:3001`, the address the README and the
 * studio's settings hint both tell you to use, did not reach it. `HOST` is the
 * conventional name for this and is not pre-set by the shell.
 */
const hostname = process.env.HOST ?? '0.0.0.0'

/**
 * Production is opted into by a flag as well as `NODE_ENV`.
 *
 * `NODE_ENV=production node …` in an npm script only works on POSIX shells — it
 * is a syntax error on Windows `cmd`, which would make `npm start` silently run
 * the dev server there. The flag works everywhere, and `NODE_ENV` is still
 * honoured for hosts that set it themselves.
 */
const dev = process.env.NODE_ENV !== 'production' && !process.argv.includes('--prod')

/*
 * Next reads `NODE_ENV` directly in places, so keep the two in agreement.
 *
 * Next's types declare it read-only to discourage exactly this, but the flag
 * above is the only portable way to express "production" in an npm script, and
 * leaving the variable unset would have Next build dev-mode assets.
 */
if (!dev) (process.env as Record<string, string | undefined>).NODE_ENV = 'production'

/**
 * Allowed browser origins, comma-separated.
 *
 * Unset means "allow any", which is right for local development and wrong for
 * a public deployment — an open relay lets anyone use your bandwidth to
 * bootstrap their own calls.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

async function main(): Promise<void> {
  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()
  await app.prepare()

  const httpServer = createServer((request, response) => {
    void handle(request, response)
  })

  const signaling = attachSignaling(httpServer, {
    path: '/signal',
    allowedOrigins,
  })

  // Health endpoint, ahead of Next, so a load balancer gets a cheap answer
  // and so room counts are observable without a dashboard.
  httpServer.prependListener('request', (request, response) => {
    if (request.url !== '/healthz') return
    const stats = signaling.registry.stats()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, ...stats }))
  })

  /*
   * Reap upgrades nobody claimed.
   *
   * Node leaves an unhandled `upgrade` socket open indefinitely — neither the
   * relay nor Next responds to, say, `wss://host/nonsense`, so the connection
   * sits there consuming a file descriptor. Repeated, that is a cheap way to
   * exhaust the process.
   *
   * This listener is registered *after* the real handlers, so by the time the
   * timer fires anyone who wanted the socket has already written a handshake
   * response to it. `bytesWritten === 0` therefore means unclaimed.
   */
  httpServer.on('upgrade', (_request, socket) => {
    setTimeout(() => {
      if (socket.destroyed) return
      // `upgrade` hands over a Duplex; the underlying net.Socket is what
      // tracks bytes, so this is narrowed rather than asserted blindly.
      const written = (socket as { bytesWritten?: number }).bytesWritten
      if (typeof written === 'number' && written > 0) return
      socket.destroy()
    }, 1000).unref()
  })

  httpServer.listen(port, hostname, () => {
    console.log(`[livedeck-signaling] http://${hostname}:${port}`)
    console.log(`[livedeck-signaling] websocket path /signal`)
    if (allowedOrigins.length === 0) {
      console.warn(
        '[livedeck-signaling] ALLOWED_ORIGINS is unset: any origin may connect. ' +
          'Set it before exposing this publicly.',
      )
    } else {
      /*
       * Log the *normalized* list, not the raw variable.
       *
       * A browser that is refused shows only "WebSocket connection failed" —
       * it hides the handshake's HTTP status by design — so the allow-list is
       * effectively invisible from the client when it is wrong. Printing what
       * the server will actually compare against turns that into a one-glance
       * check, and shows up the common mistakes: a trailing slash copied from
       * an address bar, `http` where the studio is served over `https`, or the
       * relay's own address instead of the studio's.
       */
      console.log(
        `[livedeck-signaling] allowed origins: ${allowedOrigins.map(normalizeOrigin).join(', ')}`,
      )
    }
  })

  const shutdown = async (signal: string) => {
    console.log(`[livedeck-signaling] ${signal} — shutting down`)
    await signaling.close()
    httpServer.close(() => process.exit(0))
    // Do not wait forever for lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch((error: unknown) => {
  console.error('[livedeck-signaling] failed to start', error)
  process.exit(1)
})
