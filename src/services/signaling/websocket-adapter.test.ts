import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '@shared/signaling-protocol'
import type { RoomPeerInfo, TransportState } from './types'
import { WebSocketSignalingAdapter, toWebSocketUrl } from './websocket-adapter'

/**
 * The room-based signaling adapter.
 *
 * What is worth testing here is not the happy path — it is everything that
 * happens when the network misbehaves, because those are the cases where a
 * studio could start showing a connected state that is not real:
 *
 *  - a dropped socket must retry *and* re-join the room, or the director keeps
 *    a confident-looking UI while no new guest can ever arrive
 *  - a refusal the server will not change its mind about (1008) must be
 *    terminal, not an infinite retry loop
 *  - a message this build cannot parse must surface as an error, since the
 *    server is as untrusted as any other remote input
 *  - a message sent while disconnected must be dropped and reported, never
 *    silently queued to be replayed against a peer connection that is gone
 */

/* -------------------------------------------------------- fake transport */

/**
 * A `WebSocket` stand-in.
 *
 * jsdom has no WebSocket implementation, and a real one would make these tests
 * depend on a listening server. Instances register themselves so a test can
 * drive open/message/close from the outside.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: FakeWebSocket[] = []
  /** Set to make the constructor throw, as a malformed URL does. */
  static throwOnConstruct = false

  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1)
    if (!socket) throw new Error('No socket was opened')
    return socket
  }

  readyState: number = FakeWebSocket.CONNECTING
  sent: string[] = []
  closeCalls: Array<{ code?: number; reason?: string }> = []

  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  readonly url: string

  constructor(url: string) {
    // Declared and assigned separately rather than as a parameter property,
    // which `erasableSyntaxOnly` disallows.
    this.url = url
    if (FakeWebSocket.throwOnConstruct) throw new Error('bad url')
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
  }

  /* ------------------------------------------------------- test drivers */

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emit(message: ServerMessage): void {
    this.raw(JSON.stringify(message))
  }

  raw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }

  /** Parsed messages the adapter sent, newest last. */
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>)
  }

  typesSent(): string[] {
    return this.messages.map((message) => String(message.type))
  }
}

/* ------------------------------------------------------------- fixtures */

type Recorder = {
  states: TransportState[]
  errors: string[]
  peers: RoomPeerInfo[]
  gone: string[]
  offers: Array<{ peerId: string; sdp: string }>
  answers: Array<{ peerId: string; sdp: string }>
  candidates: Array<{ peerId: string; candidate: RTCIceCandidateInit }>
}

function recorder(): Recorder {
  return { states: [], errors: [], peers: [], gone: [], offers: [], answers: [], candidates: [] }
}

function eventsFor(log: Recorder) {
  return {
    onTransportState: (state: TransportState) => log.states.push(state),
    onError: (message: string) => log.errors.push(message),
    onPeerAvailable: (peer: RoomPeerInfo) => log.peers.push(peer),
    onPeerGone: (peerId: string) => log.gone.push(peerId),
    onOffer: (envelope: { peerId: string; sdp: string }) =>
      log.offers.push({ peerId: envelope.peerId, sdp: envelope.sdp }),
    onAnswer: (envelope: { peerId: string; sdp: string }) =>
      log.answers.push({ peerId: envelope.peerId, sdp: envelope.sdp }),
    onRemoteCandidate: (peerId: string, candidate: RTCIceCandidateInit) =>
      log.candidates.push({ peerId, candidate }),
  }
}

let log: Recorder
let adapter: WebSocketSignalingAdapter
const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.throwOnConstruct = false
  Object.defineProperty(globalThis, 'WebSocket', {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  })
  log = recorder()
  adapter = new WebSocketSignalingAdapter({ url: 'ws://localhost:3000' })
})

afterEach(() => {
  adapter.disconnect()
  vi.useRealTimers()
  Object.defineProperty(globalThis, 'WebSocket', {
    value: originalWebSocket,
    configurable: true,
    writable: true,
  })
})

/** Connect and reach the point where a room has been joined. */
async function connectAndJoin(room = 'studio', role: 'director' | 'guest' = 'director') {
  await adapter.connect(eventsFor(log))
  FakeWebSocket.last.open()
  await adapter.joinRoom({ room, role, label: 'Control' })
}

/* ---------------------------------------------------------------- tests */

describe('toWebSocketUrl', () => {
  it('upgrades http to ws and https to wss', () => {
    // A page on https cannot open an insecure socket, so the scheme has to
    // follow the one the operator pasted.
    expect(toWebSocketUrl('http://localhost:3000', '/signal')).toBe('ws://localhost:3000/signal')
    expect(toWebSocketUrl('https://signal.example.com', '/signal')).toBe(
      'wss://signal.example.com/signal',
    )
  })

  it('leaves an explicit ws or wss scheme alone', () => {
    expect(toWebSocketUrl('ws://localhost:3000', '/signal')).toBe('ws://localhost:3000/signal')
    expect(toWebSocketUrl('wss://signal.example.com', '/signal')).toBe(
      'wss://signal.example.com/signal',
    )
  })

  it('assumes https when no scheme is given', () => {
    // Pasting a bare hostname is the likeliest input, and defaulting to the
    // secure scheme fails safe.
    expect(toWebSocketUrl('signal.example.com', '/signal')).toBe('wss://signal.example.com/signal')
  })

  it('replaces any path, query, and fragment on the configured base', () => {
    expect(toWebSocketUrl('https://example.com/app?x=1#y', '/signal')).toBe(
      'wss://example.com/signal',
    )
  })

  it('tolerates trailing slashes and a path without a leading one', () => {
    expect(toWebSocketUrl('https://example.com///', 'signal')).toBe('wss://example.com/signal')
  })
})

describe('capabilities', () => {
  it('advertises rooms and trickle, and no manual exchange', () => {
    // The UI keys off these: `supportsRooms` is what hides the copy-a-code
    // flow, and claiming it falsely would leave the operator with controls
    // that do nothing.
    expect(adapter.capabilities.supportsRooms).toBe(true)
    expect(adapter.capabilities.supportsTrickleIce).toBe(true)
    expect(adapter.capabilities.requiresManualExchange).toBe(false)
    expect(adapter.capabilities.crossDevice).toBe(true)
  })
})

describe('connecting', () => {
  it('reports connecting then connected', async () => {
    await adapter.connect(eventsFor(log))
    expect(log.states).toEqual(['connecting'])

    FakeWebSocket.last.open()
    expect(log.states).toEqual(['connecting', 'connected'])
  })

  it('opens the configured endpoint with the signal path', async () => {
    await adapter.connect(eventsFor(log))
    expect(FakeWebSocket.last.url).toBe('ws://localhost:3000/signal')
  })

  it('retries when the socket cannot even be constructed', async () => {
    vi.useFakeTimers()
    FakeWebSocket.throwOnConstruct = true
    await adapter.connect(eventsFor(log))

    // No socket exists, but the adapter must not sit silently idle.
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(log.states).toContain('reconnecting')
  })
})

describe('joining a room', () => {
  it('sends a join message', async () => {
    await connectAndJoin('studio')

    expect(FakeWebSocket.last.messages).toEqual([
      { v: 1, type: 'join', room: 'studio', role: 'director', label: 'Control' },
    ])
  })

  it('records the assigned peer id', async () => {
    await connectAndJoin()
    expect(adapter.localPeerId()).toBeNull()

    FakeWebSocket.last.emit({ v: 1, type: 'joined', peerId: 'me', room: 'studio', peers: [] })
    expect(adapter.localPeerId()).toBe('me')
  })

  it('announces everyone already in the room', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({
      v: 1,
      type: 'joined',
      peerId: 'me',
      room: 'studio',
      peers: [
        { peerId: 'g1', role: 'guest', label: 'Ana' },
        { peerId: 'g2', role: 'guest', label: 'Bo' },
      ],
    })

    // Existing members are immediately connectable, so they must surface the
    // same way a later arrival does.
    expect(log.peers).toEqual([
      { peerId: 'g1', role: 'guest', label: 'Ana' },
      { peerId: 'g2', role: 'guest', label: 'Bo' },
    ])
  })

  it('announces a later arrival', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({
      v: 1,
      type: 'peer-joined',
      peer: { peerId: 'g1', role: 'guest', label: 'Ana' },
    })

    expect(log.peers).toEqual([{ peerId: 'g1', role: 'guest', label: 'Ana' }])
  })

  it('reports a departure', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({ v: 1, type: 'peer-left', peerId: 'g1' })

    expect(log.gone).toEqual(['g1'])
  })
})

describe('relaying descriptions', () => {
  it('addresses an offer to the remote peer', async () => {
    await connectAndJoin()
    await adapter.publish({
      v: 1,
      kind: 'offer',
      peerId: 'g1',
      sessionId: 'studio',
      sdp: 'v=0',
      label: 'Ana',
      createdAt: 0,
    })

    expect(FakeWebSocket.last.messages.at(-1)).toEqual({
      v: 1,
      type: 'offer',
      to: 'g1',
      sdp: 'v=0',
    })
  })

  it('surfaces an inbound offer keyed by its sender', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({ v: 1, type: 'offer', from: 'g1', sdp: 'v=0' })

    // The peer manager keys connections on the *other* side's id.
    expect(log.offers).toEqual([{ peerId: 'g1', sdp: 'v=0' }])
  })

  it('surfaces an inbound answer keyed by its sender', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({ v: 1, type: 'answer', from: 'g1', sdp: 'v=0' })

    expect(log.answers).toEqual([{ peerId: 'g1', sdp: 'v=0' }])
  })
})

describe('trickled candidates', () => {
  it('relays a local candidate to one peer', async () => {
    await connectAndJoin()
    adapter.sendCandidate('g1', {
      candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'abcd',
    })

    expect(FakeWebSocket.last.messages.at(-1)).toEqual({
      v: 1,
      type: 'candidate',
      to: 'g1',
      candidate: {
        candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abcd',
      },
    })
  })

  it('ignores the empty end-of-candidates marker', async () => {
    await connectAndJoin()
    const before = FakeWebSocket.last.sent.length

    // An empty candidate signals gathering is done; the server has no use for
    // it and the far side infers completion from the connection state.
    adapter.sendCandidate('g1', { candidate: '' })

    expect(FakeWebSocket.last.sent).toHaveLength(before)
  })

  it('surfaces a remote candidate with its sender', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({
      v: 1,
      type: 'candidate',
      from: 'g1',
      candidate: {
        candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    })

    expect(log.candidates).toHaveLength(1)
    expect(log.candidates[0]?.peerId).toBe('g1')
    expect(log.candidates[0]?.candidate.sdpMid).toBe('0')
  })
})

describe('server errors', () => {
  it('reports a non-fatal error without changing state', async () => {
    await connectAndJoin()
    log.states.length = 0
    FakeWebSocket.last.emit({
      v: 1,
      type: 'error',
      code: 'unknown-peer',
      message: 'That peer has left.',
      fatal: false,
    })

    expect(log.errors).toEqual(['That peer has left.'])
    expect(log.states).toEqual([])
  })

  it('marks the transport failed on a fatal error', async () => {
    await connectAndJoin()
    FakeWebSocket.last.emit({
      v: 1,
      type: 'error',
      code: 'room-full',
      message: 'That room is full.',
      fatal: true,
    })

    expect(log.states.at(-1)).toBe('failed')
  })

  it('reports a message it cannot parse rather than ignoring it', async () => {
    await connectAndJoin()
    FakeWebSocket.last.raw('{"type":"something-else"}')

    // The server is untrusted input like any other. Silently dropping this
    // would leave the UI waiting forever with no explanation.
    expect(log.errors).toHaveLength(1)
    expect(log.errors[0]).toMatch(/could not read/i)
  })

  it('ignores non-string frames', async () => {
    await connectAndJoin()
    FakeWebSocket.last.raw(new ArrayBuffer(4))

    expect(log.errors).toEqual([])
  })
})

describe('reconnection', () => {
  it('retries after an unexpected close', async () => {
    vi.useFakeTimers()
    await connectAndJoin()
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.last.serverClose(1006)
    expect(log.states.at(-1)).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(600)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('re-joins the room on the new socket', async () => {
    vi.useFakeTimers()
    await connectAndJoin('studio')

    FakeWebSocket.last.serverClose(1006)
    await vi.advanceTimersByTimeAsync(600)
    FakeWebSocket.last.open()

    /*
     * Without this the director's UI would look fine while being invisible to
     * the room — nobody new could ever be introduced.
     */
    expect(FakeWebSocket.last.messages).toEqual([
      { v: 1, type: 'join', room: 'studio', role: 'director', label: 'Control' },
    ])
  })

  it('backs off between attempts instead of hammering the server', async () => {
    vi.useFakeTimers()
    await adapter.connect(eventsFor(log))

    FakeWebSocket.last.serverClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.last.serverClose(1006)
    // The second delay is longer, so nothing new appears at the first one.
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(600)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('does not retry a policy refusal', async () => {
    vi.useFakeTimers()
    await connectAndJoin()

    // 1008 means the server will not change its mind — room full, or a
    // protocol version it cannot speak. Retrying would loop forever.
    FakeWebSocket.last.serverClose(1008, 'room-full')

    expect(log.states.at(-1)).toBe('failed')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('explains a policy refusal in the server’s own terms', async () => {
    await connectAndJoin()
    FakeWebSocket.last.serverClose(1008, 'room-full')

    expect(log.errors).toHaveLength(1)
    expect(log.errors[0]).not.toBe('room-full')
    expect(log.errors[0]?.length).toBeGreaterThan('room-full'.length)
  })

  it('falls back to a generic explanation when no reason is given', async () => {
    await connectAndJoin()
    FakeWebSocket.last.serverClose(1008, '')

    expect(log.errors[0]).toMatch(/refused/i)
  })
})

describe('sending while disconnected', () => {
  it('drops the message and says so', async () => {
    await adapter.connect(eventsFor(log))
    // Socket never opened.
    await adapter.joinRoom({ room: 'studio', role: 'guest', label: 'Ana' })

    expect(FakeWebSocket.last.sent).toEqual([])
    expect(log.errors.at(-1)).toMatch(/not connected/i)
  })

  it('does not queue it for replay after a reconnect', async () => {
    vi.useFakeTimers()
    await connectAndJoin('studio')
    FakeWebSocket.last.serverClose(1006)

    await adapter.publish({
      v: 1,
      kind: 'offer',
      peerId: 'g1',
      sessionId: 'studio',
      sdp: 'v=0',
      label: 'Ana',
      createdAt: 0,
    })

    await vi.advanceTimersByTimeAsync(600)
    FakeWebSocket.last.open()

    /*
     * Only the re-join. A stale offer replayed here would be answered against
     * a peer connection that no longer exists, which is worse than losing it:
     * negotiation restarts cleanly from the re-join instead.
     */
    expect(FakeWebSocket.last.typesSent()).toEqual(['join'])
  })
})

describe('ingest', () => {
  it('explains that there is nothing to paste', async () => {
    await connectAndJoin()
    await adapter.ingest('LDK1.whatever')

    expect(log.errors.at(-1)).toMatch(/join by opening the room/i)
  })
})

describe('disconnect', () => {
  it('closes the socket cleanly and stops reconnecting', async () => {
    vi.useFakeTimers()
    await connectAndJoin()
    const socket = FakeWebSocket.last

    adapter.disconnect()

    expect(socket.closeCalls.at(-1)?.code).toBe(1000)
    expect(adapter.getState()).toBe('closed')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('forgets the room so a later close cannot re-join', async () => {
    await connectAndJoin()
    adapter.disconnect()

    expect(adapter.localPeerId()).toBeNull()
  })
})

describe('keepalive', () => {
  it('pings while connected', async () => {
    vi.useFakeTimers()
    await connectAndJoin()
    const before = FakeWebSocket.last.typesSent()

    await vi.advanceTimersByTimeAsync(21_000)

    expect(before).not.toContain('ping')
    expect(FakeWebSocket.last.typesSent()).toContain('ping')
  })

  it('stops pinging once the socket closes', async () => {
    vi.useFakeTimers()
    await connectAndJoin()
    const socket = FakeWebSocket.last
    socket.serverClose(1006)
    const after = socket.sent.length

    await vi.advanceTimersByTimeAsync(21_000)

    // A timer left running on a dead socket would report a send failure on
    // every tick, for as long as the page stayed open.
    expect(socket.sent).toHaveLength(after)
  })
})
