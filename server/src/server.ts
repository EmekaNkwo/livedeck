import { createServer } from 'node:http'
import { createHttpHandler } from './http'
import { readMediasoupConfig } from './mediasoup/config'
import { createWorkerPool } from './mediasoup/worker-pool'
import { createRoomManager, readRoomLimits } from './rooms/room-manager'
import { createKeyService, readOrGenerateSecret } from './signaling/authorization'
import { attachSignaling, normalizeOrigin } from './signaling/server'
import { createTurnProvider, readTurnConfig } from './turn/credentials'

/**
 * The LiveDeck media server: HTTP + WebSocket signaling + mediasoup, in one
 * Node process.
 *
 * It holds room state and media routers in memory, so it needs a persistent
 * host with a reachable UDP/TCP media port — a container or VM, not a
 * serverless runtime. See `mediasoup/config.ts` for the ports.
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
  const mediasoupConfig = readMediasoupConfig(process.env)
  const pool = await createWorkerPool(mediasoupConfig, log)
  const rooms = createRoomManager({ pool, config: mediasoupConfig, log, limits: readRoomLimits(process.env) })

  const { secret, generated } = readOrGenerateSecret(process.env)
  const keys = createKeyService(secret)

  const turnConfig = readTurnConfig(process.env)
  const turn = turnConfig ? createTurnProvider(turnConfig) : null

  const httpServer = createServer(
    createHttpHandler(() => ({
      ...rooms.stats(),
      ...rooms.mediaStats(),
      connections: signaling.connections(),
      workerLoad: pool.slots.map((slot) => slot.load),
      workers: pool.slots.length,
      turn: turnConfig?.kind ?? 'none',
    })),
  )

  const signaling = attachSignaling(httpServer, {
    path: '/signal',
    allowedOrigins,
    trustProxy: process.env.TRUST_PROXY === 'true',
    rooms,
    keys,
    turn,
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
    log('mediasoup', {
      workers: mediasoupConfig.numWorkers,
      mediaPorts: `${mediasoupConfig.port}-${mediasoupConfig.port + mediasoupConfig.numWorkers - 1}`,
      announcedAddress: mediasoupConfig.announcedAddress ?? '(unset)',
      announcedFrom: process.env.MEDIASOUP_ANNOUNCED_ADDRESS ? 'env' : 'auto-detected (set MEDIASOUP_ANNOUNCED_ADDRESS when deploying)',
      udp: mediasoupConfig.enableUdp,
      tcp: mediasoupConfig.enableTcp,
    })
    log('turn', turnConfig ? { provider: turnConfig.kind, ttlSeconds: turnConfig.ttlSeconds } : { provider: 'none (STUN only)' })
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
    await pool.close()
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
