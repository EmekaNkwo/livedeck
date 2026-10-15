import * as mediasoup from 'mediasoup'
import type { types } from 'mediasoup'
import type { MediasoupConfig } from './config'

/**
 * A fixed set of mediasoup workers, each with its own `WebRtcServer`.
 *
 * Workers are OS processes; one per core is the usual sizing and the config
 * caps it. Rooms are placed on the worker currently hosting the fewest, so
 * load spreads without a scheduler. The abstraction exists so a second
 * placement policy, or workers on another host, can be introduced without
 * touching the rooms.
 *
 * A worker that dies takes its routers with it. The pool logs it, drops it
 * and lets the rooms on it be re-created by their next join; replacing the
 * process in place is left to the supervisor that runs the container.
 */

export type WorkerSlot = {
  worker: types.Worker
  webRtcServer: types.WebRtcServer
  /** Rooms currently placed here. Maintained by the pool's callers. */
  load: number
}

export type WorkerPool = {
  slots: ReadonlyArray<WorkerSlot>
  /** The least-loaded live slot. Throws when none remain. */
  acquire: () => WorkerSlot
  release: (slot: WorkerSlot) => void
  close: () => Promise<void>
}

export async function createWorkerPool(
  config: MediasoupConfig,
  log: (event: string, detail?: Record<string, unknown>) => void,
): Promise<WorkerPool> {
  const slots: WorkerSlot[] = []

  for (let index = 0; index < config.numWorkers; index += 1) {
    const worker = await mediasoup.createWorker({ logLevel: config.logLevel })
    const port = config.port + index
    const listenInfos: types.TransportListenInfo[] = []
    if (config.enableUdp) {
      listenInfos.push({
        protocol: 'udp',
        ip: config.listenIp,
        announcedAddress: config.announcedAddress,
        port,
      })
    }
    if (config.enableTcp) {
      listenInfos.push({
        protocol: 'tcp',
        ip: config.listenIp,
        announcedAddress: config.announcedAddress,
        port,
      })
    }
    const webRtcServer = await worker.createWebRtcServer({ listenInfos })
    const slot: WorkerSlot = { worker, webRtcServer, load: 0 }
    slots.push(slot)

    worker.on('died', (error) => {
      log('worker-died', { pid: worker.pid, message: error.message })
      const position = slots.indexOf(slot)
      if (position >= 0) slots.splice(position, 1)
    })
    log('worker-ready', { pid: worker.pid, port })
  }

  return {
    slots,
    acquire: () => {
      const live = slots.filter((slot) => !slot.worker.closed)
      if (live.length === 0) throw new Error('No mediasoup workers are running.')
      const chosen = live.reduce((best, slot) => (slot.load < best.load ? slot : best))
      chosen.load += 1
      return chosen
    },
    release: (slot) => {
      slot.load = Math.max(0, slot.load - 1)
    },
    close: async () => {
      for (const slot of slots) slot.worker.close()
      slots.length = 0
    },
  }
}
