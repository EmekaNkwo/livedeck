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
import { createRoomManager, type RoomManager } from '../rooms/room-manager'
import { decodeJwt, quietLog, testGrants } from '../test/fixtures'
import { createKeyService } from './authorization'
import { attachSignaling, type SignalingServer } from './server'

/**
 * Rooms of 1, 2, 4, 6, 8 and 12 participants over the real server.
 *
 * Media flows through Jitsi, which these tests do not run (the browser suite
 * does). What is checked here, for every room size, is the part the server
 * owns:
 *   - everyone sees the full roster, and joins are announced to everyone
 *     already there;
 *   - every participant gets a media grant naming them, for this room only,
 *     with no two participants sharing an identity;
 *   - authority holds at every size: the director controls the last guest,
 *     and no guest controls the director;
 *   - leaving tears the room down to nothing.
 */

type Notification = Extract<ParsedServerMessage, { kind: 'notification' }>

class Client {
  socket!: WebSocket
  id = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readonly notifications: Notification[] = []
  grantUserId = ''
  grantRoom = ''
  rosterAtJoin = -1

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

let httpServer: Server
let signaling: SignalingServer
let rooms: RoomManager
let port: number
const keys = createKeyService('load-test-secret-that-is-long-enough')
const clients: Client[] = []

beforeAll(async () => {
  rooms = createRoomManager({ log: quietLog, limits: { maxPeersPerRoom: 12 } })
  httpServer = createServer((_req, res) => res.end())
  signaling = attachSignaling(httpServer, { rooms, keys, grants: testGrants(), log: quietLog, resumeGraceMs: 200 })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  port = (httpServer.address() as AddressInfo).port
})
afterAll(async () => {
  await signaling.close()
  rooms.closeAll()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await new Promise((resolve) => setTimeout(resolve, 300))
})

async function joinRoom(room: string, index: number): Promise<Client> {
  const client = await Client.connect(port)
  clients.push(client)
  const joined = await client.request('join', { room, label: `g${index}`, key: index === 0 ? keys.keysFor(room).directorKey : undefined })
  client.id = joined.participantId
  client.grantUserId = (decodeJwt(joined.media.jwt).payload.context as { user: { id: string } }).user.id
  client.grantRoom = joined.media.room
  client.rosterAtJoin = joined.participants.length
  return client
}

describe.each([1, 2, 4, 6, 8, 12])('a room of %i', (size) => {
  it('rosters, grants and authority hold for everyone', async () => {
    const room = `load-${size}`
    const members: Client[] = []
    for (let i = 0; i < size; i += 1) members.push(await joinRoom(room, i))

    expect(rooms.get(room)?.peers.size).toBe(size)
    members.forEach((member, index) => {
      // Each joiner saw everyone who was already there.
      expect(member.rosterAtJoin).toBe(index)
      // And heard about everyone who came after.
      expect(member.notifications.filter((n) => n.event === 'participantJoined')).toHaveLength(size - 1 - index)
      expect(member.grantUserId).toBe(member.id)
      expect(member.grantRoom).toBe(`livedeck-${room}`)
    })
    expect(new Set(members.map((member) => member.grantUserId)).size).toBe(size)

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
