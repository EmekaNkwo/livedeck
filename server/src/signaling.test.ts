import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '../../shared/signaling-protocol'
import { attachSignaling, type SignalingServer } from './signaling'

/**
 * The relay, over a real socket.
 *
 * The room registry is unit-tested separately; what this covers is the part
 * that can only be wrong end-to-end — the upgrade handshake, framing,
 * validation of hostile input, and the fact that two independent clients
 * naming the same room actually reach each other.
 */

let httpServer: Server
let signaling: SignalingServer
let port: number

/** A test client with an awaitable message queue. */
class Client {
  private readonly socket: WebSocket
  private readonly queue: ServerMessage[] = []
  private readonly waiters: Array<(message: ServerMessage) => void> = []
  readonly closes: Array<{ code: number; reason: string }> = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
    socket.on('close', (code, reason) => {
      this.closes.push({ code, reason: reason.toString() })
    })
  }

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return new Client(socket)
  }

  send(message: ClientMessage | Record<string, unknown> | string): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message))
  }

  /** Await the next message, failing rather than hanging the suite. */
  next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a server message')),
        timeoutMs,
      )
      this.waiters.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  async nextOfType<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const message = await this.next(Math.max(50, deadline - Date.now()))
      if (message.type === type) return message as Extract<ServerMessage, { type: T }>
      if (Date.now() > deadline) throw new Error(`never received a ${type} message`)
    }
  }

  async join(room: string, role: 'director' | 'guest', label: string): Promise<string> {
    this.send({ v: 1, type: 'join', room, role, label })
    const joined = await this.nextOfType('joined')
    return joined.peerId
  }

  close(): void {
    this.socket.close()
  }

  async waitForClose(timeoutMs = 2000): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs)
      this.socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

const url = () => `ws://127.0.0.1:${port}/signal`

beforeEach(async () => {
  httpServer = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  // Silence the per-event logging so the suite output stays readable.
  signaling = attachSignaling(httpServer, { path: '/signal', log: () => {} })

  /*
   * Reap unclaimed upgrade sockets, exactly as `server.ts` does in production.
   *
   * `attachSignaling` deliberately ignores paths it does not own, so another
   * handler (Next's HMR) can have them. Nothing then destroys an upgrade to a
   * path nobody owns, and because the socket was hijacked out of the HTTP
   * server it is not tracked by `closeAllConnections()` either — so teardown
   * would hang. Only the process that knows every handler can reap safely,
   * which is why this lives at the server level rather than in the relay.
   */
  httpServer.on('upgrade', (_request, socket) => {
    setTimeout(() => {
      const written = (socket as { bytesWritten?: number }).bytesWritten
      if (socket.destroyed || (typeof written === 'number' && written > 0)) return
      socket.destroy()
    }, 100).unref()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterEach(async () => {
  await signaling.close()
  /*
   * Force lingering sockets closed before waiting.
   *
   * An upgrade to a path nobody claims leaves a raw socket open, and
   * `httpServer.close()` waits for every connection — so without this the
   * teardown hangs on exactly the case one of the tests below creates.
   */
  httpServer.closeAllConnections()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

describe('join', () => {
  it('assigns a peer id and reports an empty room', async () => {
    const client = await Client.connect(url())
    client.send({ v: 1, type: 'join', room: 'room1', role: 'director', label: 'Control' })

    const joined = await client.nextOfType('joined')
    expect(joined.room).toBe('room1')
    expect(joined.peerId).toBeTruthy()
    expect(joined.peers).toEqual([])
    client.close()
  })

  it('tells an existing member when somebody arrives', async () => {
    const director = await Client.connect(url())
    await director.join('room1', 'director', 'Control')

    const guest = await Client.connect(url())
    const guestId = await guest.join('room1', 'guest', 'Ana')

    const announcement = await director.nextOfType('peer-joined')
    expect(announcement.peer).toEqual({ peerId: guestId, role: 'guest', label: 'Ana' })

    director.close()
    guest.close()
  })

  it('rejects an invalid room name rather than creating it', async () => {
    const client = await Client.connect(url())
    // Uppercase and spaces are not permitted; rooms appear in URLs and logs.
    client.send({ v: 1, type: 'join', room: 'Not A Room', role: 'guest', label: 'x' })

    const error = await client.nextOfType('error')
    expect(error.code).toBe('bad-message')
    client.close()
  })

  it('closes the socket when a room is full', async () => {
    await signaling.close()
    signaling = attachSignaling(httpServer, {
      path: '/signal',
      limits: { maxPeersPerRoom: 1 },
      log: () => {},
    })

    const first = await Client.connect(url())
    await first.join('room1', 'director', 'Control')

    const second = await Client.connect(url())
    second.send({ v: 1, type: 'join', room: 'room1', role: 'guest', label: 'Ana' })

    const error = await second.nextOfType('error')
    expect(error.code).toBe('room-full')
    // Fatal: retrying will not help, so the server hangs up rather than
    // letting the client loop forever.
    expect(error.fatal).toBe(true)
    await second.waitForClose()

    first.close()
  })
})

describe('relaying', () => {
  it('carries an offer and an answer between two clients', async () => {
    const director = await Client.connect(url())
    const directorId = await director.join('room1', 'director', 'Control')

    const guest = await Client.connect(url())
    const guestId = await guest.join('room1', 'guest', 'Ana')
    await director.nextOfType('peer-joined')

    director.send({ v: 1, type: 'offer', to: guestId, sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0' })
    const offer = await guest.nextOfType('offer')
    expect(offer.from).toBe(directorId)
    expect(offer.sdp).toContain('v=0')

    guest.send({ v: 1, type: 'answer', to: directorId, sdp: 'v=0\r\na=answer' })
    const answer = await director.nextOfType('answer')
    expect(answer.from).toBe(guestId)

    director.close()
    guest.close()
  })

  it('trickles ICE candidates', async () => {
    const director = await Client.connect(url())
    const directorId = await director.join('room1', 'director', 'Control')
    const guest = await Client.connect(url())
    const guestId = await guest.join('room1', 'guest', 'Ana')
    await director.nextOfType('peer-joined')

    director.send({
      v: 1,
      type: 'candidate',
      to: guestId,
      candidate: {
        candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    })

    const relayed = await guest.nextOfType('candidate')
    expect(relayed.from).toBe(directorId)
    expect(relayed.candidate.candidate).toContain('typ host')
    expect(relayed.candidate.sdpMLineIndex).toBe(0)

    director.close()
    guest.close()
  })

  it('does not leak between rooms', async () => {
    const a = await Client.connect(url())
    const aId = await a.join('room-a', 'director', 'A')
    const b = await Client.connect(url())
    await b.join('room-b', 'director', 'B')

    // `aId` is valid, but it is not in B's room.
    b.send({ v: 1, type: 'offer', to: aId, sdp: 'v=0' })
    const error = await b.nextOfType('error')
    expect(error.code).toBe('unknown-peer')

    a.close()
    b.close()
  })

  it('refuses signaling before a join', async () => {
    const client = await Client.connect(url())
    client.send({ v: 1, type: 'offer', to: 'someone', sdp: 'v=0' })

    const error = await client.nextOfType('error')
    expect(error.code).toBe('not-joined')
    client.close()
  })

  it('reports a peer that left mid-handshake', async () => {
    const director = await Client.connect(url())
    await director.join('room1', 'director', 'Control')
    const guest = await Client.connect(url())
    const guestId = await guest.join('room1', 'guest', 'Ana')
    await director.nextOfType('peer-joined')

    guest.close()
    await director.nextOfType('peer-left')

    director.send({ v: 1, type: 'offer', to: guestId, sdp: 'v=0' })
    const error = await director.nextOfType('error')
    expect(error.code).toBe('unknown-peer')

    director.close()
  })

  it('silently drops a candidate for a departed peer', async () => {
    // Candidates routinely arrive just after the other side hangs up.
    // Surfacing that as an error would spam the operator during teardown.
    const director = await Client.connect(url())
    await director.join('room1', 'director', 'Control')
    const guest = await Client.connect(url())
    const guestId = await guest.join('room1', 'guest', 'Ana')
    await director.nextOfType('peer-joined')

    guest.close()
    await director.nextOfType('peer-left')

    director.send({
      v: 1,
      type: 'candidate',
      to: guestId,
      candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null },
    })
    // A ping afterwards proves the socket is healthy and no error came back.
    director.send({ v: 1, type: 'ping', at: 42 })
    const pong = await director.nextOfType('pong')
    expect(pong.at).toBe(42)

    director.close()
  })
})

describe('hostile and malformed input', () => {
  it('rejects non-JSON', async () => {
    const client = await Client.connect(url())
    client.send('not json at all')

    const error = await client.nextOfType('error')
    expect(error.code).toBe('bad-message')
    client.close()
  })

  it('rejects a mismatched protocol version', async () => {
    const client = await Client.connect(url())
    client.send({ v: 99, type: 'join', room: 'room1', role: 'guest', label: 'x' })

    expect((await client.nextOfType('error')).code).toBe('bad-message')
    client.close()
  })

  it('rejects an SDP that is not an SDP', async () => {
    const client = await Client.connect(url())
    await client.join('room1', 'director', 'Control')
    client.send({ v: 1, type: 'offer', to: 'x', sdp: 'definitely not sdp' })

    expect((await client.nextOfType('error')).code).toBe('bad-message')
    client.close()
  })

  it('survives an unknown message type', async () => {
    const client = await Client.connect(url())
    client.send({ v: 1, type: 'drop-tables' })

    expect((await client.nextOfType('error')).code).toBe('bad-message')
    client.send({ v: 1, type: 'ping', at: 7 })
    expect((await client.nextOfType('pong')).at).toBe(7)
    client.close()
  })

  it('rate-limits a flood', async () => {
    await signaling.close()
    signaling = attachSignaling(httpServer, {
      path: '/signal',
      limits: { maxMessagesPerWindow: 5, rateWindowMs: 60_000 },
      log: () => {},
    })

    const client = await Client.connect(url())
    for (let i = 0; i < 20; i += 1) client.send({ v: 1, type: 'ping', at: i })

    // Somewhere in that burst the budget runs out and the server says so
    // rather than silently dropping messages.
    let sawRateLimit = false
    for (let i = 0; i < 20 && !sawRateLimit; i += 1) {
      const message = await client.next()
      if (message.type === 'error' && message.code === 'rate-limited') sawRateLimit = true
    }
    expect(sawRateLimit).toBe(true)
    client.close()
  })
})

describe('leave', () => {
  it('leaves a room without closing the socket', async () => {
    const director = await Client.connect(url())
    await director.join('room1', 'director', 'Control')
    const guest = await Client.connect(url())
    await guest.join('room1', 'guest', 'Ana')
    await director.nextOfType('peer-joined')

    guest.send({ v: 1, type: 'leave' })
    await director.nextOfType('peer-left')

    // The socket is still usable — the guest can re-join.
    await guest.join('room1', 'guest', 'Ana')
    await director.nextOfType('peer-joined')

    director.close()
    guest.close()
  })
})

describe('upgrade handling', () => {
  it('leaves other upgrade paths alone', async () => {
    /*
     * Next.js owns its own upgrades (HMR in dev); hijacking every one would
     * break the dev server. So an upgrade to an unrelated path is *ignored*
     * rather than refused — the socket neither opens nor errors, it waits for
     * whoever does own that path. The contract asserted here is "does not
     * reach the relay", not "is rejected".
     */
    const socket = new WebSocket(`ws://127.0.0.1:${port}/some-other-path`)
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 600)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    socket.terminate()
    expect(opened).toBe(false)
  })

  it('refuses a disallowed origin', async () => {
    await signaling.close()
    signaling = attachSignaling(httpServer, {
      path: '/signal',
      allowedOrigins: ['https://allowed.example'],
      log: () => {},
    })

    const socket = new WebSocket(url(), { origin: 'https://evil.example' })
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      }),
    ).rejects.toThrow()
  })
})
