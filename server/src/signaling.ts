import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseClientMessage, type ServerErrorCode, type ServerMessage } from '../../shared/signaling-protocol'
import { RoomRegistry, type PeerHandle, type RoomLimits } from './rooms'

/**
 * The WebSocket signaling endpoint.
 *
 * Attached to an existing HTTP server rather than listening on its own port,
 * so it shares the Next.js origin. That avoids a second TLS certificate and
 * sidesteps CORS entirely.
 *
 * WHY A CUSTOM SERVER AND NOT A NEXT.JS ROUTE HANDLER
 * ---------------------------------------------------
 * Next.js route handlers cannot own a WebSocket upgrade: they run per-request,
 * and on serverless platforms the process does not outlive the response. A
 * signaling relay is the opposite — a long-lived process holding connections
 * and in-memory room state. So this runs Next programmatically inside a plain
 * Node HTTP server and handles `upgrade` itself.
 *
 * The practical consequence, stated plainly: **this will not run on Vercel's
 * serverless runtime.** It needs a container or VM — Fly, Render, Railway, a
 * VPS. See the README.
 */

export type SignalingOptions = {
  path?: string
  limits?: Partial<RoomLimits>
  /** Allowed `Origin` values. Empty means allow all — fine for local dev. */
  allowedOrigins?: string[]
  /** Called for notable events. Defaults to console. */
  log?: (event: string, detail?: Record<string, unknown>) => void
}

const HEARTBEAT_INTERVAL_MS = 30_000

type Connection = {
  socket: WebSocket
  peerId: string
  /** True once a valid `join` has been processed. */
  joined: boolean
  /** Set by the heartbeat; cleared by a pong. */
  awaitingPong: boolean
}

export type SignalingServer = {
  registry: RoomRegistry
  close: () => Promise<void>
}

export function attachSignaling(
  httpServer: Server,
  options: SignalingOptions = {},
): SignalingServer {
  const path = options.path ?? '/signal'
  const registry = new RoomRegistry(options.limits)
  const log =
    options.log ??
    ((event: string, detail?: Record<string, unknown>) => {
      // One line per event, so it greps cleanly in a container log.
      console.log(`[signal] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
    })

  // `noServer`: we own the upgrade, because the same HTTP server also serves
  // Next.js and must not have every upgrade hijacked.
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Set<Connection>()

  const originAllowed = (request: IncomingMessage): boolean => {
    const allowed = options.allowedOrigins ?? []
    if (allowed.length === 0) return true
    const origin = request.headers.origin
    // A missing Origin means a non-browser client; allow it, since the browser
    // security model is what Origin exists to express.
    if (!origin) return true
    return allowed.includes(origin)
  }

  /*
   * Held in a named function so `close()` can detach it.
   *
   * Without that, attaching a second relay to the same HTTP server — which
   * happens on a hot reload, and in tests — leaves the previous (closed)
   * listener in place. It answers first and rejects every upgrade with a 503,
   * so the new relay never sees a connection.
   */
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    // Anything not aimed at the signaling path is left alone, so Next's own
    // upgrades (HMR in dev) still work.
    if (url.pathname !== path) return

    if (!originAllowed(request)) {
      log('upgrade-rejected', { origin: request.headers.origin })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (socket_) => {
      wss.emit('connection', socket_, request)
    })
  }

  httpServer.on('upgrade', onUpgrade)

  wss.on('connection', (socket: WebSocket) => {
    const connection: Connection = {
      socket,
      peerId: randomUUID(),
      joined: false,
      awaitingPong: false,
    }
    connections.add(connection)
    log('connected', { peerId: connection.peerId })

    const send = (message: ServerMessage) => {
      if (socket.readyState !== socket.OPEN) return
      try {
        socket.send(JSON.stringify(message))
      } catch {
        // A failing send means the socket is going away; the close handler
        // will clean up.
      }
    }

    const fail = (code: ServerErrorCode, message: string, fatal = false) => {
      send({ v: 1, type: 'error', code, message, fatal })
      if (fatal) socket.close(1008, code)
    }

    socket.on('message', (raw: unknown) => {
      const text = typeof raw === 'string' ? raw : String(raw)

      /*
       * Rate limiting comes first, before parsing.
       *
       * Parsing a large payload is the expensive part, so budgeting after it
       * would let a flood of oversized junk do real work before being
       * rejected.
       */
      if (!registry.allowMessage(connection.peerId)) {
        fail('rate-limited', 'Too many signaling messages. Slow down and retry.')
        return
      }

      const message = parseClientMessage(text)
      if (!message) {
        // Specific, because a silently-dropped signaling message produces a
        // connection that hangs with no explanation.
        fail('bad-message', 'That signaling message was malformed and was ignored.')
        return
      }

      switch (message.type) {
        case 'join': {
          const handle: PeerHandle = {
            peerId: connection.peerId,
            role: message.role,
            label: message.label,
            send,
            close: () => socket.close(1000, 'server-closed'),
          }

          const result = registry.join(message.room, handle)
          if (!result.ok) {
            fail(result.code, result.message, true)
            return
          }

          connection.joined = true
          send({
            v: 1,
            type: 'joined',
            peerId: connection.peerId,
            room: message.room,
            peers: result.peers,
          })
          log('joined', {
            peerId: connection.peerId,
            room: message.room,
            role: message.role,
            existing: result.peers.length,
          })
          return
        }

        case 'offer':
        case 'answer': {
          if (!connection.joined) {
            fail('not-joined', 'Join a room before sending a session description.')
            return
          }
          const outcome = registry.relay(connection.peerId, message.to, {
            v: 1,
            type: message.type,
            from: connection.peerId,
            sdp: message.sdp,
          })
          if (outcome === 'unknown-peer') {
            fail('unknown-peer', 'That participant is no longer in the room.')
          }
          return
        }

        case 'candidate': {
          if (!connection.joined) {
            fail('not-joined', 'Join a room before sending ICE candidates.')
            return
          }
          /*
           * A candidate for a peer that has gone is *not* an error worth
           * reporting. Candidates trickle in asynchronously and routinely
           * arrive a moment after the other side hung up; surfacing that as a
           * failure would spam the operator during normal teardown.
           */
          registry.relay(connection.peerId, message.to, {
            v: 1,
            type: 'candidate',
            from: connection.peerId,
            candidate: message.candidate,
          })
          return
        }

        case 'leave':
          registry.leave(connection.peerId)
          connection.joined = false
          return

        case 'ping':
          send({ v: 1, type: 'pong', at: message.at })
          return
      }
    })

    socket.on('pong', () => {
      connection.awaitingPong = false
    })

    socket.on('close', () => {
      connections.delete(connection)
      registry.leave(connection.peerId)
      log('disconnected', { peerId: connection.peerId })
    })

    socket.on('error', () => {
      // Errors are always followed by close; cleanup happens there.
    })
  })

  /**
   * Heartbeat.
   *
   * A TCP connection can die without either side noticing — a laptop lid
   * closing, a NAT dropping the mapping. Without this, dead peers would linger
   * in rooms and the director would keep seeing guests that are gone.
   */
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (connection.awaitingPong) {
        log('heartbeat-timeout', { peerId: connection.peerId })
        connection.socket.terminate()
        continue
      }
      connection.awaitingPong = true
      try {
        connection.socket.ping()
      } catch {
        connection.socket.terminate()
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  return {
    registry,
    close: async () => {
      clearInterval(heartbeat)
      // Detach before closing, so the HTTP server stops routing upgrades here.
      httpServer.removeListener('upgrade', onUpgrade)
      registry.closeAll()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
