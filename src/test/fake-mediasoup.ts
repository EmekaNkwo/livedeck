import type { Device, types as msTypes } from 'mediasoup-client'
import type {
  NotificationData,
  NotificationEvent,
  Participant,
  ProducerInfo,
  RequestMethod,
  RequestParams,
  ResponseResult,
} from '@shared/protocol'
import type { SignalingClient } from '@/media/signaling-client'

/**
 * Scripted doubles for mediasoup-client and the signaling client.
 *
 * They model the parts of the real API the session drives: event
 * registration on transports, producers and consumers; the lazy `connect`
 * and `produce` callbacks a send transport raises; the server answering
 * every request. Nothing here encodes media; the point is to prove the
 * session's lifecycle and idempotency without a browser.
 */

type Handler = (...args: never[]) => void

class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>()
  on(event: string, handler: Handler): this {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler)
    this.handlers.set(event, set)
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
  }
}

export function fakeTrack(kind: 'audio' | 'video', id = `${kind}-${Math.random().toString(36).slice(2, 7)}`): MediaStreamTrack {
  return { id, kind, readyState: 'live', enabled: true, contentHint: '' } as unknown as MediaStreamTrack
}

export class FakeProducer extends Emitter {
  readonly id: string
  readonly kind: 'audio' | 'video'
  track: MediaStreamTrack
  paused = false
  closed = false
  maxSpatialLayer: number | null = null
  readonly appData: Record<string, unknown>
  constructor(id: string, track: MediaStreamTrack, appData: Record<string, unknown>) {
    super()
    this.id = id
    this.kind = track.kind as 'audio' | 'video'
    this.track = track
    this.appData = appData
  }
  async replaceTrack({ track }: { track: MediaStreamTrack }): Promise<void> {
    this.track = track
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
  }
  close(): void {
    this.closed = true
  }
  async setMaxSpatialLayer(layer: number): Promise<void> {
    this.maxSpatialLayer = layer
  }
}

export class FakeConsumer extends Emitter {
  readonly id: string
  readonly producerId: string
  readonly kind: 'audio' | 'video'
  readonly track: MediaStreamTrack
  readonly appData: Record<string, unknown>
  closed = false
  constructor(options: { id: string; producerId: string; kind: 'audio' | 'video'; appData: Record<string, unknown> }) {
    super()
    this.id = options.id
    this.producerId = options.producerId
    this.kind = options.kind
    this.track = fakeTrack(options.kind, `consumer-${options.id}`)
    this.appData = options.appData
  }
  close(): void {
    this.closed = true
  }
  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport
  }
}

export class FakeTransport extends Emitter {
  readonly id: string
  readonly direction: 'send' | 'recv'
  connectionState: RTCPeerConnectionState = 'new'
  closed = false
  iceRestarts = 0
  iceServers: unknown[] = []
  readonly producers: FakeProducer[] = []
  readonly consumers: FakeConsumer[] = []
  private nextProducer = 1
  constructor(id: string, direction: 'send' | 'recv') {
    super()
    this.id = id
    this.direction = direction
  }
  async produce(options: { track: MediaStreamTrack; appData: Record<string, unknown> }): Promise<FakeProducer> {
    if (this.connectionState === 'new') {
      await new Promise<void>((resolve, reject) => {
        this.emit('connect', { dtlsParameters: { role: 'client' } }, resolve, reject)
      })
      this.connectionState = 'connected'
      this.emit('connectionstatechange', 'connected')
    }
    const id = await new Promise<string>((resolve, reject) => {
      this.emit(
        'produce',
        { kind: options.track.kind, rtpParameters: { codecs: [] }, appData: options.appData },
        ({ id: producerId }: { id: string }) => resolve(producerId),
        reject,
      )
    })
    void this.nextProducer++
    const producer = new FakeProducer(id, options.track, options.appData)
    this.producers.push(producer)
    return producer
  }
  async consume(options: { id: string; producerId: string; kind: 'audio' | 'video'; appData: Record<string, unknown> }): Promise<FakeConsumer> {
    if (this.connectionState === 'new') {
      await new Promise<void>((resolve, reject) => {
        this.emit('connect', { dtlsParameters: { role: 'client' } }, resolve, reject)
      })
      this.connectionState = 'connected'
      this.emit('connectionstatechange', 'connected')
    }
    const consumer = new FakeConsumer(options)
    this.consumers.push(consumer)
    return consumer
  }
  async restartIce(): Promise<void> {
    this.iceRestarts += 1
    this.connectionState = 'connected'
    this.emit('connectionstatechange', 'connected')
  }
  async updateIceServers({ iceServers }: { iceServers: unknown[] }): Promise<void> {
    this.iceServers = iceServers
  }
  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport
  }
  close(): void {
    this.closed = true
    for (const producer of this.producers) if (!producer.closed) producer.emit('transportclose')
    for (const consumer of this.consumers) if (!consumer.closed) consumer.emit('transportclose')
  }
  /** Test helper: simulate the network going away. */
  fail(): void {
    this.connectionState = 'failed'
    this.emit('connectionstatechange', 'failed')
  }
}

export class FakeDevice {
  loaded = false
  rtpCapabilities = { codecs: [{ mimeType: 'audio/opus' }] }
  readonly transports: FakeTransport[] = []
  async load({ routerRtpCapabilities }: { routerRtpCapabilities: unknown }): Promise<void> {
    void routerRtpCapabilities
    this.loaded = true
  }
  createSendTransport(options: { id: string }): msTypes.Transport {
    const transport = new FakeTransport(options.id, 'send')
    this.transports.push(transport)
    return transport as unknown as msTypes.Transport
  }
  createRecvTransport(options: { id: string }): msTypes.Transport {
    const transport = new FakeTransport(options.id, 'recv')
    this.transports.push(transport)
    return transport as unknown as msTypes.Transport
  }
}

/**
 * A fake server behind a fake signaling client.
 *
 * Answers every request the way the real server would, keeps a roster and
 * producer list, and lets tests push notifications and drop the socket.
 */
export class FakeSignaling {
  state: 'idle' | 'connected' | 'reconnecting' | 'closed' = 'idle'
  readonly requests: Array<{ method: RequestMethod; params: unknown }> = []
  participants: Participant[] = []
  producers: ProducerInfo[] = []
  selfId = 'self-1'
  role: Participant['role'] = 'guest'
  resumeTokens = 0
  /** Set to make the next join report a successful resume. */
  resumeNext = false
  private nextTransport = 1
  private nextProducer = 1
  private nextConsumer = 1
  private readonly listeners = {
    state: new Set<(state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed') => void>(),
    notification: new Set<(event: NotificationEvent, data: unknown) => void>(),
    reconnected: new Set<() => void>(),
  }

  get currentState() {
    return this.state
  }

  on(event: 'state' | 'notification' | 'reconnected', listener: never): () => void {
    const set = this.listeners[event] as Set<never>
    set.add(listener)
    return () => set.delete(listener)
  }

  async connect(): Promise<void> {
    this.state = 'connected'
    for (const l of this.listeners.state) l('connected')
  }

  close(): void {
    this.state = 'closed'
    for (const l of this.listeners.state) l('closed')
  }

  reconnectNow(): void {}

  /** Test helper: the socket dropped and came back. */
  async dropAndReconnect(): Promise<void> {
    this.state = 'reconnecting'
    for (const l of this.listeners.state) l('reconnecting')
    this.state = 'connected'
    for (const l of this.listeners.state) l('connected')
    for (const l of this.listeners.reconnected) l()
    // Let the session's recovery run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  notify<E extends NotificationEvent>(event: E, data: NotificationData<E>): void {
    for (const l of this.listeners.notification) l(event, data)
  }

  async request<M extends RequestMethod>(method: M, params: RequestParams<M>): Promise<ResponseResult<M>> {
    this.requests.push({ method, params })
    switch (method) {
      case 'join': {
        const resumed = this.resumeNext
        this.resumeNext = false
        this.resumeTokens += 1
        return {
          participantId: this.selfId,
          role: this.role,
          room: (params as RequestParams<'join'>).room,
          resumeToken: `token-${this.resumeTokens}`,
          resumed,
          participants: this.participants,
          producers: this.producers,
          iceServers: [{ urls: ['stun:stun.example.com'] }],
          routerRtpCapabilities: { codecs: [] },
        } as ResponseResult<M>
      }
      case 'createWebRtcTransport':
        return {
          id: `t${this.nextTransport++}`,
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: {},
        } as ResponseResult<M>
      case 'produce':
        return { producerId: `p${this.nextProducer++}` } as ResponseResult<M>
      case 'consume': {
        const { producerId } = params as RequestParams<'consume'>
        const info = this.producers.find((p) => p.id === producerId)
        if (!info) throw Object.assign(new Error('unknown'), { code: 'unknown-producer' })
        return {
          consumerId: `c${this.nextConsumer++}`,
          producerId,
          participantId: info.participantId,
          kind: info.kind,
          source: info.source,
          rtpParameters: {},
          producerPaused: info.paused,
        } as ResponseResult<M>
      }
      case 'restartIce':
        return { iceParameters: { usernameFragment: 'new' } } as ResponseResult<M>
      case 'getRoomKeys':
        return { directorKey: 'dk', producerKey: 'pk' } as ResponseResult<M>
      case 'ping':
        return { at: (params as RequestParams<'ping'>).at } as ResponseResult<M>
      default:
        return {} as ResponseResult<M>
    }
  }
}

export function asSignalingClient(fake: FakeSignaling): SignalingClient {
  return fake as unknown as SignalingClient
}

export function asDevice(fake: FakeDevice): Device {
  return fake as unknown as Device
}
