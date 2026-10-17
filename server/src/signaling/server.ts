import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  MAX_MESSAGE_BYTES,
  errorResponse,
  notification,
  okResponse,
  parseRequest,
  type NotificationData,
  type NotificationEvent,
} from '../../../shared/protocol'
import { RoomError } from '../rooms/room'
import type { RoomManager } from '../rooms/room-manager'
import {
  clientAddress,
  createConnectionLimiter,
  type ConnectionLimits,
} from '../security/connection-limit'
import { METHOD_CATEGORY, createRateLimiter, type RateLimits } from '../security/rate-limit'
import type { GrantIssuer } from '../jitsi/grants'
import type { KeyService } from './authorization'
import { dispatch, onSessionClosed, type HandlerContext, type Session } from './handlers'

/**
 * The WebSocket endpoint.
 *
 * Owns the socket lifecycle only: origin and connection caps at upgrade,
 * frame size, heartbeat, the join deadline, rate limiting and the
 * request/response envelope. What a request *does* lives in `handlers.ts`.
 */

export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

export type SignalingOptions = {
  path?: string
  allowedOrigins?: string[]
  trustProxy?: boolean
  rateLimits?: RateLimits
  connectionLimits?: ConnectionLimits
  rooms: RoomManager
  keys: KeyService
  grants: GrantIssuer | null
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** How long a dropped participant's media survives awaiting a resume. */
  resumeGraceMs?: number
}

export type SignalingServer = {
  connections: () => number
  close: () => Promise<void>
}

const HEARTBEAT_INTERVAL_MS = 30_000
/** A socket that has not joined by then is holding a slot for nothing. */
const JOIN_DEADLINE_MS = 15_000

type Connection = {
  socket: WebSocket
  session: Session
  awaitingPong: boolean
  joinTimer: NodeJS.Timeout
}

export function attachSignaling(httpServer: Server, options: SignalingOptions): SignalingServer {
  const path = options.path ?? '/signal'
  const log =
    options.log ??
    ((event: string, detail?: Record<string, unknown>) => {
      console.info(`[signal] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
    })
  const allowedOrigins = (options.allowedOrigins ?? []).map(normalizeOrigin).filter(Boolean)
  const connectionLimiter = createConnectionLimiter(options.connectionLimits)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const connections = new Set<Connection>()

  const originAllowed = (request: IncomingMessage): boolean => {
    if (allowedOrigins.length === 0) return true
    const origin = request.headers.origin
    // A missing Origin is a non-browser client. The allow-list exists to stop
    // other *sites* using the relay through a visitor's browser; a script can
    // set any origin it likes, so refusing the absent header buys nothing.
    if (!origin) return true
    return allowedOrigins.includes(normalizeOrigin(origin))
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== path) return
    if (!originAllowed(request)) {
      log('upgrade-rejected', { origin: request.headers.origin })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const address = clientAddress(request, options.trustProxy ?? false)
    if (!connectionLimiter.acquire(address)) {
      log('connection-refused', { address })
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, address)
    })
  }
  httpServer.on('upgrade', onUpgrade)

  wss.on('connection', (socket: WebSocket, _request: IncomingMessage, address: string) => {
    const sendRaw = (payload: unknown) => {
      if (socket.readyState !== socket.OPEN) return
      try {
        socket.send(JSON.stringify(payload))
      } catch (error) {
        log('send-failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    const send = <E extends NotificationEvent>(event: E, data: NotificationData<E>) =>
      sendRaw(notification(event, data))

    const session: Session = { id: randomUUID(), address, peer: null, room: null, send }
    const ctx: HandlerContext = {
      session,
      rooms: options.rooms,
      keys: options.keys,
      grants: options.grants,
      log,
      resumeGraceMs: options.resumeGraceMs,
    }
    const limiter = createRateLimiter(options.rateLimits)
    const connection: Connection = {
      socket,
      session,
      awaitingPong: false,
      joinTimer: setTimeout(() => {
        if (!session.peer) {
          log('join-deadline', { session: session.id })
          socket.close(1008, 'join-deadline')
        }
      }, JOIN_DEADLINE_MS),
    }
    connection.joinTimer.unref?.()
    connections.add(connection)
    log('connected', { session: session.id, address })

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        sendRaw(errorResponse(0, 'bad-message', 'Binary frames are not accepted.'))
        return
      }
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString() : raw.toString()
      const parsed = parseRequest(text)
      if (!parsed.ok) {
        sendRaw(errorResponse(parsed.id ?? 0, parsed.code, parsed.message))
        if (parsed.code === 'protocol-version') socket.close(1008, 'protocol-version')
        return
      }
      const { request } = parsed
      if (!limiter.allow(METHOD_CATEGORY[request.method])) {
        sendRaw(errorResponse(request.id, 'rate-limited', 'Too many requests. Slow down and retry.'))
        return
      }
      void dispatch(ctx, request)
        .then((result) => sendRaw(okResponse(request.id, result)))
        .catch((error: unknown) => {
          if (error instanceof RoomError) {
            sendRaw(errorResponse(request.id, error.code, error.message))
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          log('request-failed', { method: request.method, message })
          sendRaw(errorResponse(request.id, 'media-error', message.slice(0, 300)))
        })
    })

    socket.on('pong', () => {
      connection.awaitingPong = false
    })

    socket.on('close', (code: number) => {
      clearTimeout(connection.joinTimer)
      connections.delete(connection)
      connectionLimiter.release(address)
      // 1000 is a deliberate close by the client (tab closed, Leave, page
      // unmount): the participant is gone. Anything else is a network drop
      // and keeps the participant for the resume window.
      onSessionClosed(ctx, { intentional: code === 1000 })
      log('disconnected', { session: session.id })
    })

    socket.on('error', (error) => {
      log('socket-error', { session: session.id, message: error.message })
    })
  })

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (connection.awaitingPong) {
        log('heartbeat-timeout', { session: connection.session.id })
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
  heartbeat.unref?.()

  return {
    connections: () => connections.size,
    close: async () => {
      clearInterval(heartbeat)
      httpServer.removeListener('upgrade', onUpgrade)
      for (const connection of connections) {
        connection.session.send('closed', {
          code: 'server-shutdown',
          message: 'The server is shutting down.',
        })
        connection.socket.close(1001, 'server-shutdown')
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
