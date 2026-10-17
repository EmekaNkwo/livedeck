import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MAX_MESSAGE_BYTES,
  parseServerMessage,
  requestEnvelope,
  type ErrorCode,
  type NotificationEvent,
  type ParsedServerMessage,
  type RequestMethod,
  type RequestParams,
  type ResponseResult,
} from '../../../shared/protocol'
import { createRoomManager, type RoomManager } from '../rooms/room-manager'
import { DEFAULT_RATE_LIMITS } from '../security/rate-limit'
import { decodeJwt, quietLog, testGrants } from '../test/fixtures'
import { createKeyService } from './authorization'
import { attachSignaling, type SignalingOptions, type SignalingServer } from './server'

/* ------------------------------------------------------------- harness */

type Notification = Extract<ParsedServerMessage, { kind: 'notification' }>

class TestClient {
  private socket!: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readonly notifications: Notification[] = []
  closeCode: number | null = null

  static async connect(port: number, origin?: string): Promise<TestClient> {
    const client = new TestClient()
    client.socket = new WebSocket(`ws://127.0.0.1:${port}/signal`, origin ? { origin } : undefined)
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve)
      client.socket.once('error', reject)
    })
    client.socket.on('message', (raw) => {
      const message = parseServerMessage(raw.toString())
      if (!message) throw new Error(`Unparseable server frame: ${raw.toString().slice(0, 100)}`)
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
    client.socket.on('close', (code) => {
      client.closeCode = code
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

  sendRaw(text: string | Buffer): void {
    this.socket.send(text)
  }

  async expectError<M extends RequestMethod>(method: M, params: RequestParams<M>, code: ErrorCode): Promise<void> {
    await expect(this.request(method, params)).rejects.toMatchObject({ code })
  }

  async waitFor(event: NotificationEvent, predicate: (n: Notification) => boolean = () => true): Promise<Notification> {
    await vi.waitFor(() => {
      expect(this.notifications.some((n) => n.event === event && predicate(n))).toBe(true)
    })
    return this.notifications.find((n) => n.event === event && predicate(n)) as Notification
  }

  has(event: NotificationEvent): boolean {
    return this.notifications.some((n) => n.event === event)
  }

  /** Drop the socket without a `leave`, as a network failure would. */
  terminate(): void {
    this.socket.terminate()
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      // 1000, as the browser client sends on Leave or unmount.
      this.socket.close(1000, 'client-closed')
    })
  }

  async closed(): Promise<number> {
    await vi.waitFor(() => expect(this.closeCode).not.toBeNull())
    return this.closeCode as number
  }
}

let httpServer: Server
let signaling: SignalingServer
let rooms: RoomManager
let port: number
const keys = createKeyService('test-secret-that-is-long-enough')
const clients: TestClient[] = []

async function startServer(overrides: Partial<SignalingOptions> = {}): Promise<void> {
  rooms = createRoomManager({ log: quietLog, limits: { maxPeersPerRoom: 3 } })
  httpServer = createServer((_req, res) => res.end())
  signaling = attachSignaling(httpServer, { rooms, keys, grants: testGrants(), log: quietLog, resumeGraceMs: 1500, ...overrides })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  port = (httpServer.address() as AddressInfo).port
}

async function stopServer(): Promise<void> {
  await signaling.close()
  rooms.closeAll()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
}

async function connect(origin?: string): Promise<TestClient> {
  const client = await TestClient.connect(port, origin)
  clients.push(client)
  return client
}

async function joinAs(label: string, key?: string, room = 'studio'): Promise<{ client: TestClient; joined: ResponseResult<'join'> }> {
  const client = await connect()
  const joined = await client.request('join', { room, label, key })
  return { client, joined }
}

beforeAll(async () => {
  await startServer()
})
afterAll(async () => {
  await stopServer()
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  // Let grace timers and reaps settle so rooms do not leak between tests.
  await vi.waitFor(() => expect(signaling.connections()).toBe(0))
  await vi.waitFor(() => expect(rooms.stats().peers).toBe(0), { timeout: 5000, interval: 50 })
})

/* ------------------------------------------------------------- tests */

describe('joining', () => {
  it('assigns guest by default and never lets the client pick a higher role', async () => {
    const { joined } = await joinAs('Ada')
    expect(joined.role).toBe('guest')
    expect(joined.participantId).toMatch(/^[0-9a-f-]{36}$/)
    expect(joined.resumeToken.length).toBeGreaterThan(20)
    expect(joined.media.room).toBe('livedeck-studio')
    expect(joined.resumed).toBe(false)
  })

  it('grants director and producer only by key, and a viewer on request', async () => {
    const { directorKey, producerKey } = keys.keysFor('studio')
    const { joined: director } = await joinAs('Dir', directorKey)
    const { joined: producer } = await joinAs('Prod', producerKey)
    const viewer = await connect()
    const viewerJoined = await viewer.request('join', { room: 'studio', label: 'V', role: 'viewer' })
    expect(director.role).toBe('director')
    expect(producer.role).toBe('producer')
    expect(viewerJoined.role).toBe('viewer')
    expect(viewerJoined.participants.map((p) => p.role).sort()).toEqual(['director', 'producer'])
  })

  it('treats a forged key as a guest and refuses it the room keys', async () => {
    const { client, joined } = await joinAs('Mallory', 'forged-key')
    expect(joined.role).toBe('guest')
    await client.expectError('getRoomKeys', {}, 'forbidden')
  })

  it('lets the first studio claim an empty room, and nobody after', async () => {
    const first = await connect()
    const claimed = await first.request('join', { room: 'studio', label: 'Studio', claim: true })
    expect(claimed.role).toBe('director')
    await expect(first.request('getRoomKeys', {})).resolves.toEqual(keys.keysFor('studio'))
    const second = await connect()
    const late = await second.request('join', { room: 'studio', label: 'Impostor', claim: true })
    expect(late.role).toBe('guest')
    await second.expectError('getRoomKeys', {}, 'forbidden')
  })

  it('lets the studio claim a room that guests opened first', async () => {
    const guest = await connect()
    expect((await guest.request('join', { room: 'early', label: 'Guest' })).role).toBe('guest')
    const studio = await connect()
    const claimed = await studio.request('join', { room: 'early', label: 'Studio', claim: true })
    expect(claimed.role).toBe('director')
    const late = await connect()
    expect((await late.request('join', { room: 'early', label: 'Impostor', claim: true })).role).toBe('guest')
  })

  it('gives the director the keys', async () => {
    const { client } = await joinAs('Dir', keys.keysFor('studio').directorKey)
    await expect(client.request('getRoomKeys', {})).resolves.toEqual(keys.keysFor('studio'))
  })

  it('refuses requests before joining and double joins after', async () => {
    const client = await connect()
    await client.expectError('getMediaGrant', {}, 'not-joined')
    await client.expectError('updateState', { micMuted: true }, 'not-joined')
    await client.request('join', { room: 'studio', label: 'A' })
    await client.expectError('join', { room: 'studio', label: 'A' }, 'already-joined')
  })

  it('fills a room at the limit', async () => {
    await joinAs('1')
    await joinAs('2')
    await joinAs('3')
    const fourth = await connect()
    await fourth.expectError('join', { room: 'studio', label: '4' }, 'room-full')
  })

  it('tells others about joins, leaves and reaps the room', async () => {
    const { client: a } = await joinAs('A')
    const { client: b, joined } = await joinAs('B')
    expect(joined.participants.map((p) => p.label)).toEqual(['A'])
    await a.waitFor('participantJoined', (n) => (n.data as { participant: { label: string } }).participant.label === 'B')
    await b.request('leave', {})
    await a.waitFor('participantLeft')
    await a.request('leave', {})
    expect(rooms.stats()).toEqual({ rooms: 0, peers: 0 })
  })
})

describe('authorization end to end', () => {
  it('guest A cannot mute, relabel, cue or put on air guest B, and B hears nothing', async () => {
    const { client: a } = await joinAs('A')
    const { client: b, joined: bJoined } = await joinAs('B')
    await a.expectError('control', { target: bJoined.participantId, command: { action: 'mute-mic', muted: true } }, 'forbidden')
    await a.expectError('control', { target: bJoined.participantId, command: { action: 'mute-camera', muted: true } }, 'forbidden')
    await a.expectError('control', { target: bJoined.participantId, command: { action: 'label', label: 'Pwned' } }, 'forbidden')
    await a.expectError('control', { target: bJoined.participantId, command: { action: 'cue', text: 'hi' } }, 'forbidden')
    await a.expectError('control', { target: bJoined.participantId, command: { action: 'on-air', onAir: true } }, 'forbidden')
    await a.expectError('control', { target: bJoined.participantId, command: { action: 'kick' } }, 'forbidden')
    await a.request('ping', { at: 1 })
    expect(b.has('control')).toBe(false)
    expect(b.notifications.filter((n) => n.event === 'participantUpdated')).toEqual([])
  })

  it('a forged target id is rejected', async () => {
    const { client: dir } = await joinAs('Dir', keys.keysFor('studio').directorKey)
    await dir.expectError('control', { target: 'not-a-participant', command: { action: 'mute-mic', muted: true } }, 'unknown-participant')
  })

  it('the director can control everyone, and the target learns who did it', async () => {
    const { client: dir, joined: dirJoined } = await joinAs('Dir', keys.keysFor('studio').directorKey)
    const { client: b, joined: bJoined } = await joinAs('B')
    await dir.request('control', { target: bJoined.participantId, command: { action: 'mute-mic', muted: true } })
    const control = await b.waitFor('control')
    expect(control.data).toEqual({ from: dirJoined.participantId, command: { action: 'mute-mic', muted: true } })

    await dir.request('control', { target: bJoined.participantId, command: { action: 'label', label: 'Bea' } })
    const updated = await dir.waitFor('participantUpdated', (n) => (n.data as { participant: { label: string } }).participant.label === 'Bea')
    expect((updated.data as { participant: { id: string } }).participant.id).toBe(bJoined.participantId)

    await dir.request('control', { target: bJoined.participantId, command: { action: 'on-air', onAir: true } })
    await b.waitFor('participantUpdated', (n) => (n.data as { participant: { onAir: boolean } }).participant.onAir)
  })

  it('a producer may mute guests but not put them on air or touch the director', async () => {
    const { joined: dirJoined } = await joinAs('Dir', keys.keysFor('studio').directorKey)
    const { client: prod } = await joinAs('Prod', keys.keysFor('studio').producerKey)
    const { client: g, joined: gJoined } = await joinAs('G')
    await prod.request('control', { target: gJoined.participantId, command: { action: 'mute-mic', muted: true } })
    await g.waitFor('control')
    await prod.expectError('control', { target: gJoined.participantId, command: { action: 'on-air', onAir: true } }, 'forbidden')
    await prod.expectError('control', { target: dirJoined.participantId, command: { action: 'mute-mic', muted: true } }, 'forbidden')
  })

  it('kick removes the target and tells the room', async () => {
    const { client: dir } = await joinAs('Dir', keys.keysFor('studio').directorKey)
    const { client: g, joined: gJoined } = await joinAs('G')
    await dir.request('control', { target: gJoined.participantId, command: { action: 'kick' } })
    const closed = await g.waitFor('closed')
    expect(closed.data).toMatchObject({ code: 'kicked' })
    await dir.waitFor('participantLeft')
  })

})

describe('media grants', () => {
  it('names the participant, this room\'s conference, and expires within the hour', async () => {
    const { joined } = await joinAs('Ada')
    const { header, payload } = decodeJwt(joined.media.jwt)
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT' })
    expect(payload).toMatchObject({
      aud: 'jitsi',
      iss: 'livedeck',
      sub: 'meet.jitsi',
      room: 'livedeck-studio',
      context: { user: { id: joined.participantId, name: 'Ada', moderator: 'false' } },
    })
    const lifetime = (payload.exp as number) - Math.floor(Date.now() / 1000)
    expect(lifetime).toBeGreaterThan(3500)
    expect(lifetime).toBeLessThanOrEqual(3600)
    expect(joined.media).toMatchObject({
      provider: 'jitsi',
      domain: 'meet.jitsi',
      mucDomain: 'muc.meet.jitsi',
      libraryUrl: 'https://jitsi.test/libs/lib-jitsi-meet.min.js',
      serviceUrl: 'wss://jitsi.test/xmpp-websocket?room=livedeck-studio',
    })
  })

  it('makes only the director a Jitsi moderator', async () => {
    const { directorKey, producerKey } = keys.keysFor('studio')
    const moderatorOf = (jwt: string) => (decodeJwt(jwt).payload.context as { user: { moderator: string } }).user.moderator
    const { joined: director } = await joinAs('Dir', directorKey)
    const { joined: producer } = await joinAs('Prod', producerKey)
    const viewer = await connect()
    const viewerJoined = await viewer.request('join', { room: 'studio', label: 'V', role: 'viewer' })
    expect(moderatorOf(director.media.jwt)).toBe('true')
    expect(moderatorOf(producer.media.jwt)).toBe('false')
    expect(moderatorOf(viewerJoined.media.jwt)).toBe('false')
  })

  it('a token for one room does not name another', async () => {
    const { joined: a } = await joinAs('A', undefined, 'alpha')
    const { joined: b } = await joinAs('B', undefined, 'beta')
    expect(decodeJwt(a.media.jwt).payload.room).toBe('livedeck-alpha')
    expect(decodeJwt(b.media.jwt).payload.room).toBe('livedeck-beta')
  })

  it('issues a fresh grant on request, for the same participant', async () => {
    const { client, joined } = await joinAs('A')
    const fresh = await client.request('getMediaGrant', {})
    expect(fresh.room).toBe(joined.media.room)
    expect(decodeJwt(fresh.jwt).payload.context).toMatchObject({ user: { id: joined.participantId } })
  })

  it('refuses joins when the server has no media backend', async () => {
    await stopServer()
    await startServer({ grants: null })
    const client = await connect()
    await client.expectError('join', { room: 'studio', label: 'A' }, 'media-error')
    expect(rooms.stats().peers).toBe(0)
    await stopServer()
    await startServer()
  })

  it('broadcasts each participant\'s reported state', async () => {
    const { client: a } = await joinAs('A')
    const { client: b } = await joinAs('B')
    await a.request('updateState', { micMuted: true, sharing: true })
    await b.waitFor('participantUpdated', (n) => {
      const participant = (n.data as { participant: { micMuted: boolean; sharing: boolean } }).participant
      return participant.micMuted && participant.sharing
    })
  })
})

describe('reconnection', () => {
  it('resumes a dropped session with the same identity and a fresh grant', async () => {
    const { client: a, joined } = await joinAs('A')
    const { client: b } = await joinAs('B')

    a.terminate()
    const resumedClient = await connect()
    const resumed = await resumedClient.request('join', { room: 'studio', label: 'A', resumeToken: joined.resumeToken })
    expect(resumed.resumed).toBe(true)
    expect(resumed.participantId).toBe(joined.participantId)
    expect(resumed.resumeToken).not.toBe(joined.resumeToken)
    expect(decodeJwt(resumed.media.jwt).payload.context).toMatchObject({ user: { id: joined.participantId } })
    expect(b.has('participantLeft')).toBe(false)
    expect(b.notifications.filter((n) => n.event === 'participantJoined')).toHaveLength(0)
  })

  it('a clean close leaves at once; only a drop is held for resume', async () => {
    const { client: a } = await joinAs('A')
    const { client: b } = await joinAs('B')
    await b.close()
    await a.waitFor('participantLeft')
    const { client: c, joined } = await joinAs('C')
    c.terminate()
    // Dropped, not closed: still in the room during the grace window.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rooms.get('studio')?.peers.has(joined.participantId)).toBe(true)
    expect(a.notifications.filter((n) => n.event === 'participantLeft')).toHaveLength(1)
  })

  it('a stale token joins fresh rather than failing', async () => {
    const { client: a } = await joinAs('A')
    const stale = await connect()
    const joined = await stale.request('join', { room: 'studio', label: 'X', resumeToken: 'no-such-token' })
    expect(joined.resumed).toBe(false)
    await a.waitFor('participantJoined')
  })

  it('a second resume replaces the first socket', async () => {
    const { client: a, joined } = await joinAs('A')
    a.terminate()
    const first = await connect()
    const firstJoin = await first.request('join', { room: 'studio', label: 'A', resumeToken: joined.resumeToken })
    const second = await connect()
    const secondJoin = await second.request('join', { room: 'studio', label: 'A', resumeToken: firstJoin.resumeToken })
    expect(secondJoin.participantId).toBe(joined.participantId)
    const replaced = await first.waitFor('closed')
    expect(replaced.data).toMatchObject({ code: 'replaced' })
    // The old token is dead.
    const third = await connect()
    const thirdJoin = await third.request('join', { room: 'studio', label: 'A', resumeToken: joined.resumeToken })
    expect(thirdJoin.resumed).toBe(false)
  })
})

describe('hardening', () => {
  it('answers malformed frames with bad-message', async () => {
    const client = await connect()
    const bad = new Promise<void>((resolve) => {
      const check = () => {
        if (client.closeCode !== null) return resolve()
        setTimeout(check, 10)
      }
      client.sendRaw('{"nope"')
      // A bad frame is answered, not fatal: the next request still works.
      client.request('ping', { at: 1 }).then(() => resolve())
    })
    await bad
    expect(client.closeCode).toBeNull()
  })

  it('closes the socket on an oversized frame', async () => {
    const client = await connect()
    client.sendRaw('x'.repeat(MAX_MESSAGE_BYTES + 1))
    expect(await client.closed()).toBe(1009)
  })

  it('rejects binary frames', async () => {
    const client = await connect()
    client.sendRaw(Buffer.from([1, 2, 3]))
    await client.request('ping', { at: 2 })
    expect(client.closeCode).toBeNull()
  })

  it('closes a socket speaking an older protocol', async () => {
    const client = await connect()
    client.sendRaw(JSON.stringify({ v: 1, type: 'join', room: 'x', role: 'director', label: 'x' }))
    expect(await client.closed()).toBe(1008)
  })

  it('refuses origins outside the allow-list', async () => {
    await stopServer()
    await startServer({ allowedOrigins: ['https://studio.example.com/'] })
    await expect(TestClient.connect(port, 'https://evil.example.com')).rejects.toThrow()
    const ok = await TestClient.connect(port, 'HTTPS://studio.example.com')
    clients.push(ok)
    const noOrigin = await TestClient.connect(port)
    clients.push(noOrigin)
    await ok.close()
    await noOrigin.close()
    await stopServer()
    await startServer()
  })

  it('caps connections per address', async () => {
    await stopServer()
    await startServer({ connectionLimits: { maxPerAddress: 2, maxTotal: 10 } })
    await connect()
    await connect()
    await expect(TestClient.connect(port)).rejects.toThrow()
    await Promise.all(clients.splice(0).map((c) => c.close()))
    await stopServer()
    await startServer()
  })

  it('rate limits per category without dropping the request silently', async () => {
    await stopServer()
    await startServer({ rateLimits: { ...DEFAULT_RATE_LIMITS, keepalive: { capacity: 2, refillPerSecond: 0.001 } } })
    const client = await connect()
    await client.request('ping', { at: 1 })
    await client.request('ping', { at: 2 })
    await client.expectError('ping', { at: 3 }, 'rate-limited')
    // Other categories are unaffected.
    await client.request('join', { room: 'studio', label: 'A' })
    await Promise.all(clients.splice(0).map((c) => c.close()))
    await stopServer()
    await startServer()
  })
})
