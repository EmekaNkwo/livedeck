import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  parseServerMessage,
  requestEnvelope,
  type ParsedServerMessage,
  type RequestMethod,
  type RequestParams,
  type ResponseResult,
} from '../../../shared/protocol'
import type { MediasoupConfig } from '../mediasoup/config'
import type { WorkerPool } from '../mediasoup/worker-pool'
import { createRoomManager, type RoomManager } from '../rooms/room-manager'
import { audioRtpParameters, createTestPool, quietLog, videoRtpParameters } from '../test/fixtures'
import { createKeyService } from './authorization'
import { attachSignaling, type SignalingServer } from './server'

/**
 * Rooms of 1, 2, 4, 6, 8 and 12 participants, each publishing a microphone
 * and a camera and consuming everyone else's, over the real server and real
 * mediasoup routers.
 *
 * What is checked for every room size:
 *   - every participant ends with exactly (n-1) × 2 consumers;
 *   - no consumer is for the participant's own producer (mix-minus);
 *   - no producer is consumed twice by the same participant;
 *   - the server's totals match: n peers, 2n producers;
 *   - leaving tears down the room completely.
 */

type Notification = Extract<ParsedServerMessage, { kind: 'notification' }>

class Client {
  socket!: WebSocket
  id = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readonly notifications: Notification[] = []
  readonly consumed = new Map<string, string>() // producerId → consumerId

  static async connect(port: number): Promise<Client> {
    const client = new Client()
    client.socket = new WebSocket(`ws://127.0.0.1:${port}/signal`)
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve)
      client.socket.once('error', reject)
    })
    client.socket.on('message', (raw) => {
      const message = parseServerMessage(raw.toString())
      if (!message) return
      if (message.kind === 'notification') {
        client.notifications.push(message)
        return
      }
      const entry = client.pending.get(message.id)
      if (!entry) return
      client.pending.delete(message.id)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    })
    return client
  }

  request<M extends RequestMethod>(method: M, params: RequestParams<M>): Promise<ResponseResult<M>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.socket.send(JSON.stringify(requestEnvelope(id, method, params)))
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }
}

let pool: WorkerPool
let config: MediasoupConfig
let httpServer: Server
let signaling: SignalingServer
let rooms: RoomManager
let port: number
const keys = createKeyService('load-test-secret-that-is-long-enough')
const clients: Client[] = []

beforeAll(async () => {
  ;({ pool, config } = await createTestPool())
  rooms = createRoomManager({ pool, config, log: quietLog, limits: { maxPeersPerRoom: 12 } })
  httpServer = createServer((_req, res) => res.end())
  signaling = attachSignaling(httpServer, { rooms, keys, turn: null, log: quietLog, resumeGraceMs: 200 })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  port = (httpServer.address() as AddressInfo).port
})
afterAll(async () => {
  await signaling.close()
  rooms.closeAll()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await pool.close()
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await new Promise((resolve) => setTimeout(resolve, 300))
})

async function joinAndPublish(room: string, index: number): Promise<Client> {
  const client = await Client.connect(port)
  clients.push(client)
  const joined = await client.request('join', { room, label: `g${index}`, key: index === 0 ? keys.keysFor(room).directorKey : undefined })
  client.id = joined.participantId
  const send = await client.request('createWebRtcTransport', { direction: 'send' })
  await client.request('createWebRtcTransport', { direction: 'recv' })
  await client.request('produce', { transportId: send.id, kind: 'audio', rtpParameters: audioRtpParameters(10_000 + index * 2), source: 'mic' })
  await client.request('produce', { transportId: send.id, kind: 'video', rtpParameters: videoRtpParameters(10_001 + index * 2), source: 'camera' })
  return client
}

async function consumeEverything(client: Client, room: string): Promise<void> {
  const caps = (await client.request('getRouterRtpCapabilities', {})).rtpCapabilities
  // The server knows every producer; ask for each one, as a client would on
  // join and on each newProducer notification.
  const roomState = rooms.get(room)
  for (const producer of roomState?.producers() ?? []) {
    if (producer.participantId === client.id) {
      await expect(client.request('consume', { producerId: producer.id, rtpCapabilities: caps })).rejects.toMatchObject({ code: 'forbidden' })
      continue
    }
    const consumed = await client.request('consume', { producerId: producer.id, rtpCapabilities: caps })
    // A repeat is the same consumer, not a second one.
    const again = await client.request('consume', { producerId: producer.id, rtpCapabilities: caps })
    expect(again.consumerId).toBe(consumed.consumerId)
    client.consumed.set(producer.id, consumed.consumerId)
    await client.request('resumeConsumer', { consumerId: consumed.consumerId })
  }
}

describe.each([1, 2, 4, 6, 8, 12])('a room of %i', (size) => {
  it('gives every participant everyone else exactly once, never themselves', async () => {
    const room = `load-${size}`
    const members: Client[] = []
    for (let i = 0; i < size; i += 1) members.push(await joinAndPublish(room, i))
    for (const member of members) await consumeEverything(member, room)

    const state = rooms.get(room)
    expect(state?.peers.size).toBe(size)
    expect(state?.producers()).toHaveLength(size * 2)

    for (const member of members) {
      expect(member.consumed.size).toBe((size - 1) * 2)
      const peer = state?.peers.get(member.id)
      expect(peer?.consumers.size).toBe((size - 1) * 2)
      for (const entry of peer?.consumers.values() ?? []) {
        expect(entry.producerPeerId).not.toBe(member.id)
      }
      // Each producer consumed by this member appears once.
      const producerIds = [...(peer?.consumers.values() ?? [])].map((c) => c.producerId)
      expect(new Set(producerIds).size).toBe(producerIds.length)
    }

    // Everyone heard about everyone else's producers.
    for (const member of members) {
      const announced = member.notifications.filter((n) => n.event === 'newProducer').length
      // Producers published after this member joined.
      const index = members.indexOf(member)
      expect(announced).toBe((size - 1 - index) * 2)
    }

    // The director (index 0) can mute the last guest; the last guest cannot mute the director.
    if (size > 1) {
      const director = members[0]!
      const last = members[size - 1]!
      await director.request('control', { target: last.id, command: { action: 'mute-mic', muted: true } })
      await expect(
        last.request('control', { target: director.id, command: { action: 'mute-mic', muted: true } }),
      ).rejects.toMatchObject({ code: 'forbidden' })
    }

    // Leaving in order tears the room down to nothing.
    for (const member of members) await member.request('leave', {})
    expect(rooms.stats()).toEqual({ rooms: 0, peers: 0 })
  }, 60_000)
})
