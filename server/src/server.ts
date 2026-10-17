import { createServer } from 'node:http'
import { createHttpHandler } from './http'
import { createGrantIssuer, readGrantConfig } from './jitsi/grants'
import { createRoomManager, readRoomLimits } from './rooms/room-manager'
import { createKeyService, readOrGenerateSecret } from './signaling/authorization'
import { attachSignaling, normalizeOrigin } from './signaling/server'

/**
 * The LiveDeck server: rooms, roles, director commands and room keys over one
 * WebSocket, and the signer of Jitsi media grants.
 *
 * Audio and video go through Jitsi (JaaS in production), so this process
 * needs nothing but its HTTP port: it runs on any host that serves a web
 * service, Render included. Rooms live in memory, so it needs a persistent
 * process, not a serverless runtime.
 */

const log = (event: string, detail?: Record<string, unknown>) => {
  console.info(`[livedeck] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
}

const port = Number(process.env.PORT ?? 3001)
// Deliberately HOST, not HOSTNAME: Windows pre-sets HOSTNAME to the machine
// name, which would bind the server to an address localhost cannot reach.
const hostname = process.env.HOST ?? '0.0.0.0'
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

async function main(): Promise<void> {
  const rooms = createRoomManager({ log, limits: readRoomLimits(process.env) })

  const { secret, generated } = readOrGenerateSecret(process.env)
  const keys = createKeyService(secret)

  const grantConfig = readGrantConfig(process.env)
  const grants = grantConfig ? createGrantIssuer(grantConfig) : null

  const httpServer = createServer(
    createHttpHandler(() => ({
      ...rooms.stats(),
      connections: signaling.connections(),
      media: grantConfig?.kind ?? 'none',
    })),
  )

  const signaling = attachSignaling(httpServer, {
    path: '/signal',
    allowedOrigins,
    trustProxy: process.env.TRUST_PROXY === 'true',
    rooms,
    keys,
    grants,
    log,
  })

  // Reap upgrades nobody claimed, so a stray `wss://host/nonsense` does not
  // hold a file descriptor forever.
  httpServer.on('upgrade', (_request, socket) => {
    setTimeout(() => {
      if (socket.destroyed) return
      const written = (socket as { bytesWritten?: number }).bytesWritten
      if (typeof written === 'number' && written > 0) return
      socket.destroy()
    }, 1000).unref()
  })

  httpServer.listen(port, hostname, () => {
    log('listening', { url: `http://${hostname}:${port}`, signaling: '/signal' })
    if (grantConfig) {
      log('media', {
        provider: grantConfig.kind,
        app: grantConfig.appId,
        tokenTtlSeconds: grantConfig.ttlSeconds,
      })
    } else {
      console.warn(
        '[livedeck] No media backend is configured: joins will be refused. Set JAAS_APP_ID, JAAS_API_KEY_ID and JAAS_PRIVATE_KEY (see server/.env.example).',
      )
    }
    if (generated) {
      console.warn(
        '[livedeck] ROOM_KEY_SECRET is unset: room keys were generated for this run and every director link stops working on restart. Set it before deploying.',
      )
    }
    if (allowedOrigins.length === 0) {
      console.warn('[livedeck] ALLOWED_ORIGINS is unset: any origin may connect. Set it before exposing this publicly.')
    } else {
      log('allowed-origins', { origins: allowedOrigins.map(normalizeOrigin) })
    }
  })

  const shutdown = async (signal: string) => {
    log('shutdown', { signal })
    await signaling.close()
    rooms.closeAll()
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch((error: unknown) => {
  console.error('[livedeck] failed to start', error)
  process.exit(1)
})
