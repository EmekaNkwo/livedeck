import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorResponse, notification, okResponse, type RequestEnvelope } from '@shared/protocol'
import { SignalingClient, SignalingError } from './signaling-client'

/**
 * A scripted WebSocket. Tests open it, read what the client sent, and answer.
 */
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: RequestEnvelope[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as RequestEnvelope)
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  // test helpers
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
  last(): RequestEnvelope {
    return this.sent[this.sent.length - 1] as RequestEnvelope
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof SignalingClient>[0]> = {}) {
  return new SignalingClient({
    url: 'ws://localhost:3001',
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    requestTimeoutMs: 500,
    connectTimeoutMs: 500,
    reconnectDelaysMs: [100, 200],
    maxReconnectAttempts: 3,
    pingIntervalMs: 60_000,
    ...overrides,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', { OPEN: 1, CLOSING: 2, CLOSED: 3 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SignalingClient', () => {
  it('connects, sends a request and resolves the matching response', async () => {
    const client = makeClient()
    const states: string[] = []
    client.on('state', (state) => states.push(state))
    const connecting = client.connect()
    const socket = FakeSocket.instances[0]!
    expect(socket.url).toBe('ws://localhost:3001/signal')
    socket.open()
    await connecting
    expect(states).toEqual(['connecting', 'connected'])

    const pending = client.request('ping', { at: 7 })
    const sent = socket.last()
    expect(sent).toMatchObject({ kind: 'request', method: 'ping', params: { at: 7 } })
    socket.receive(okResponse(sent.id, { at: 7 }))
    await expect(pending).resolves.toEqual({ at: 7 })
  })

  it('rejects a request with the server error code', async () => {
    const client = makeClient()
    const connecting = client.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting
    const pending = client.request('getRoomKeys', {})
    socket.receive(errorResponse(socket.last().id, 'forbidden', 'nope'))
    await expect(pending).rejects.toMatchObject({ code: 'forbidden', message: 'nope' })
  })

  it('rejects a malformed response body and a request that times out', async () => {
    const client = makeClient()
    const connecting = client.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting
    const bad = client.request('ping', { at: 1 })
    socket.receive(okResponse(socket.last().id, { wrong: true }))
    await expect(bad).rejects.toMatchObject({ code: 'bad-message' })

    const slow = client.request('ping', { at: 2 })
    vi.advanceTimersByTime(600)
    await expect(slow).rejects.toMatchObject({ code: 'timeout' })
  })

  it('delivers notifications and ignores frames it cannot parse', async () => {
    const client = makeClient()
    const received: string[] = []
    client.on('notification', (event) => received.push(event))
    const connecting = client.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting
    socket.receive(notification('participantLeft', { participantId: 'p1' }))
    socket.onmessage?.({ data: 'garbage' })
    socket.receive({ v: 2, kind: 'notification', event: 'bogus', data: {} })
    expect(received).toEqual(['participantLeft'])
  })

  it('reconnects with backoff after a drop, fails pending requests, and announces the reconnect', async () => {
    const client = makeClient()
    const states: string[] = []
    const reconnected = vi.fn()
    client.on('state', (state) => states.push(state))
    client.on('reconnected', reconnected)
    const connecting = client.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    await connecting

    const inFlight = client.request('ping', { at: 1 })
    first.drop()
    await expect(inFlight).rejects.toBeInstanceOf(SignalingError)
    expect(states.at(-1)).toBe('reconnecting')
    expect(FakeSocket.instances).toHaveLength(1)

    vi.advanceTimersByTime(100)
    expect(FakeSocket.instances).toHaveLength(2)
    const second = FakeSocket.instances[1]!
    second.open()
    expect(states.at(-1)).toBe('connected')
    expect(reconnected).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured attempts', async () => {
    const client = makeClient()
    const states: string[] = []
    client.on('state', (state) => states.push(state))
    const connecting = client.connect()
    FakeSocket.instances[0]!.drop()
    vi.advanceTimersByTime(100)
    FakeSocket.instances[1]!.drop()
    vi.advanceTimersByTime(200)
    FakeSocket.instances[2]!.drop()
    vi.advanceTimersByTime(200)
    FakeSocket.instances[3]!.drop()
    await expect(connecting).rejects.toBeInstanceOf(SignalingError)
    expect(states.at(-1)).toBe('failed')
  })

  it('treats a policy close as final rather than retrying', async () => {
    const client = makeClient()
    const connecting = client.connect()
    FakeSocket.instances[0]!.open()
    await connecting
    FakeSocket.instances[0]!.close(1008, 'protocol-version')
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(client.currentState).toBe('failed')
  })

  it('reconnectNow skips the remaining backoff', async () => {
    const client = makeClient()
    const connecting = client.connect()
    FakeSocket.instances[0]!.open()
    await connecting
    FakeSocket.instances[0]!.drop()
    expect(FakeSocket.instances).toHaveLength(1)
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('close() stops everything and rejects what is pending', async () => {
    const client = makeClient()
    const connecting = client.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting
    const pending = client.request('ping', { at: 1 })
    client.close()
    await expect(pending).rejects.toBeInstanceOf(SignalingError)
    expect(client.currentState).toBe('closed')
    vi.advanceTimersByTime(5000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
