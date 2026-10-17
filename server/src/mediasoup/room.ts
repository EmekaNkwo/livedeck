import type { types } from 'mediasoup'
import type {
  ErrorCode,
  MediaSource,
  NotificationData,
  NotificationEvent,
  ProducerInfo,
  ResponseResult,
  TransportDirection,
} from '../../../shared/protocol'
import type { MediasoupConfig } from './config'
import { Peer, type ProducerEntry } from './peer'
import type { WorkerPool, WorkerSlot } from './worker-pool'

/**
 * A studio room: one mediasoup Router and the peers attached to it.
 *
 * The room owns every media operation. Handlers in `signaling/` validate the
 * request and the caller's authority, then call in here; this file never
 * reads a socket and never decides who is allowed to do what.
 *
 * Errors are thrown as {@link RoomError} with a protocol error code, so the
 * handler can answer the request with the right code without parsing text.
 */

export class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RoomError'
  }
}

export type RoomOptions = {
  name: string
  slot: WorkerSlot
  router: types.Router
  config: MediasoupConfig
  maxPeers: number
  log: (event: string, detail?: Record<string, unknown>) => void
}

export class Room {
  readonly name: string
  readonly router: types.Router
  readonly peers = new Map<string, Peer>()
  private readonly slot: WorkerSlot
  private readonly config: MediasoupConfig
  private readonly maxPeers: number
  private readonly log: RoomOptions['log']
  private closed = false
  /**
   * Whether a studio has claimed this room. Set once, for the room's life:
   * the room is reaped when its last participant leaves, which resets it.
   */
  private claimedByStudio = false

  constructor(options: RoomOptions) {
    this.name = options.name
    this.router = options.router
    this.slot = options.slot
    this.config = options.config
    this.maxPeers = options.maxPeers
    this.log = options.log
  }

  static async create(
    pool: WorkerPool,
    options: Omit<RoomOptions, 'slot' | 'router'>,
  ): Promise<Room> {
    const slot = pool.acquire()
    try {
      const router = await slot.worker.createRouter({ mediaCodecs: options.config.mediaCodecs })
      return new Room({ ...options, slot, router })
    } catch (error) {
      pool.release(slot)
      throw error
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Hand the director role to the first studio that asks. True once only.
   *
   * Guests who open the link first do not block it: what matters is that
   * nobody has claimed the room yet, not that it is empty.
   */
  claim(): boolean {
    if (this.claimedByStudio) return false
    this.claimedByStudio = true
    return true
  }

  get isEmpty(): boolean {
    return this.peers.size === 0
  }

  get rtpCapabilities(): types.RtpCapabilities {
    return this.router.rtpCapabilities
  }

  /* ----------------------------------------------------------- membership */

  addPeer(peer: Peer): void {
    if (this.peers.size >= this.maxPeers) {
      throw new RoomError(
        'room-full',
        `This room already has ${this.maxPeers} participants, which is the limit.`,
      )
    }
    this.peers.set(peer.id, peer)
    this.broadcast('participantJoined', { participant: peer.toParticipant() }, peer.id)
    this.log('peer-joined', { room: this.name, peerId: peer.id, role: peer.role })
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    // Consumers on other peers that watch this peer's producers close with the
    // producers (mediasoup emits `producerclose`), and those handlers notify
    // their owners. Only the departure itself needs announcing here.
    peer.close()
    this.peers.delete(peerId)
    this.broadcast('participantLeft', { participantId: peerId })
    this.log('peer-left', { room: this.name, peerId })
  }

  getPeer(peerId: string): Peer {
    const peer = this.peers.get(peerId)
    if (!peer || peer.isClosed) {
      throw new RoomError('unknown-participant', 'That participant is no longer in the room.')
    }
    return peer
  }

  participants(): ReturnType<Peer['toParticipant']>[] {
    return [...this.peers.values()].map((peer) => peer.toParticipant())
  }

  producers(): ProducerInfo[] {
    return [...this.peers.values()].flatMap((peer) => peer.producerInfos())
  }

  broadcast<E extends NotificationEvent>(
    event: E,
    data: NotificationData<E>,
    exceptPeerId?: string,
  ): void {
    for (const peer of this.peers.values()) {
      if (peer.id === exceptPeerId) continue
      peer.send(event, data)
    }
  }

  /** Announce a change to one participant's public state. */
  announcePeer(peer: Peer): void {
    this.broadcast('participantUpdated', { participant: peer.toParticipant() })
  }

  /* ------------------------------------------------------------ transports */

  async createTransport(
    peer: Peer,
    direction: TransportDirection,
  ): Promise<ResponseResult<'createWebRtcTransport'>> {
    const transport = await this.router.createWebRtcTransport({
      webRtcServer: this.slot.webRtcServer,
      enableUdp: this.config.enableUdp,
      enableTcp: this.config.enableTcp,
      preferUdp: true,
      initialAvailableOutgoingBitrate: this.config.initialAvailableOutgoingBitrate,
      appData: { peerId: peer.id, direction },
    })
    if (direction === 'send') {
      await transport.setMaxIncomingBitrate(this.config.maxIncomingBitrate)
    }
    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        this.log('transport-dtls', { peerId: peer.id, transportId: transport.id, state })
      }
      /*
       * Ask for a fresh keyframe once media can actually flow.
       *
       * A receive transport connects lazily on its first consume, and the
       * consumers are resumed straight away. The keyframe mediasoup requests
       * on resume can therefore reach the browser before DTLS is up and be
       * dropped; every frame after it is a delta that cannot be decoded until
       * the browser's own keyframe request fires, seconds later. Requesting
       * again on connect makes first frames arrive at once.
       */
      if (state === 'connected' && direction === 'recv') {
        void this.requestKeyFrames(peer, transport.id)
      }
    })
    transport.on('routerclose', () => {
      peer.transports.delete(transport.id)
    })
    peer.transports.set(transport.id, transport)
    return {
      id: transport.id,
      iceParameters: transport.iceParameters as Record<string, unknown>,
      iceCandidates: transport.iceCandidates as unknown as Record<string, unknown>[],
      dtlsParameters: transport.dtlsParameters as unknown as Record<string, unknown>,
    }
  }

  getTransport(peer: Peer, transportId: string): types.WebRtcTransport {
    const transport = peer.transports.get(transportId)
    if (!transport || transport.closed) {
      throw new RoomError('unknown-transport', 'That transport no longer exists.')
    }
    return transport
  }

  async connectTransport(
    peer: Peer,
    transportId: string,
    dtlsParameters: Record<string, unknown>,
  ): Promise<void> {
    const transport = this.getTransport(peer, transportId)
    await transport.connect({ dtlsParameters: dtlsParameters as unknown as types.DtlsParameters })
  }

  async restartIce(peer: Peer, transportId: string): Promise<types.IceParameters> {
    const transport = this.getTransport(peer, transportId)
    return transport.restartIce()
  }

  /* ------------------------------------------------------------- producers */

  async produce(
    peer: Peer,
    options: {
      transportId: string
      kind: types.MediaKind
      rtpParameters: Record<string, unknown>
      source: MediaSource
    },
  ): Promise<string> {
    const transport = this.getTransport(peer, options.transportId)
    if (transport.appData.direction !== 'send') {
      throw new RoomError('media-error', 'Producers go on the send transport.')
    }
    // One producer per source: a second camera producer replaces the first
    // rather than leaving two, which is what a reconnect that re-publishes
    // without closing would otherwise create.
    for (const [existingId, entry] of peer.producers) {
      if (entry.source === options.source) this.closeProducer(peer, existingId)
    }
    const producer = await transport.produce({
      kind: options.kind,
      rtpParameters: options.rtpParameters as unknown as types.RtpParameters,
      appData: { peerId: peer.id, source: options.source },
    })
    peer.producers.set(producer.id, { producer, source: options.source })
    producer.on('transportclose', () => {
      peer.producers.delete(producer.id)
      this.broadcast('producerClosed', { producerId: producer.id, participantId: peer.id })
    })
    this.broadcast(
      'newProducer',
      {
        producer: {
          id: producer.id,
          participantId: peer.id,
          kind: producer.kind,
          source: options.source,
          paused: producer.paused,
        },
      },
      peer.id,
    )
    return producer.id
  }

  getProducer(peer: Peer, producerId: string): types.Producer {
    const entry = peer.producers.get(producerId)
    if (!entry || entry.producer.closed) {
      throw new RoomError('unknown-producer', 'That media stream no longer exists.')
    }
    return entry.producer
  }

  /** Find a producer anywhere in the room, with its owner. */
  findProducer(producerId: string): { peer: Peer; entry: ProducerEntry } | null {
    for (const peer of this.peers.values()) {
      const entry = peer.producers.get(producerId)
      if (entry && !entry.producer.closed) return { peer, entry }
    }
    return null
  }

  async pauseProducer(peer: Peer, producerId: string): Promise<void> {
    await this.getProducer(peer, producerId).pause()
    this.broadcast('producerPaused', { producerId }, peer.id)
  }

  async resumeProducer(peer: Peer, producerId: string): Promise<void> {
    await this.getProducer(peer, producerId).resume()
    this.broadcast('producerResumed', { producerId }, peer.id)
  }

  closeProducer(peer: Peer, producerId: string): void {
    const entry = peer.producers.get(producerId)
    if (!entry) return
    entry.producer.close()
    peer.producers.delete(producerId)
    this.broadcast('producerClosed', { producerId, participantId: peer.id })
  }

  /* ------------------------------------------------------------- consumers */

  async consume(
    peer: Peer,
    options: { producerId: string; rtpCapabilities: Record<string, unknown> },
  ): Promise<ResponseResult<'consume'>> {
    // Idempotent: consuming a producer already consumed returns the existing
    // consumer rather than a duplicate stream.
    for (const entry of peer.consumers.values()) {
      if (entry.producerId === options.producerId && !entry.consumer.closed) {
        return this.describeConsumer(entry.consumer, entry)
      }
    }
    const found = this.findProducer(options.producerId)
    if (!found) throw new RoomError('unknown-producer', 'That media stream no longer exists.')
    // Mix-minus is a property of the topology: nobody receives their own
    // media back. Enforced here so no client can undo it.
    if (found.peer.id === peer.id) {
      throw new RoomError('forbidden', 'A participant cannot consume its own media.')
    }
    const rtpCapabilities = options.rtpCapabilities as unknown as types.RtpCapabilities
    if (!this.router.canConsume({ producerId: options.producerId, rtpCapabilities })) {
      throw new RoomError('media-error', 'This browser cannot decode that stream.')
    }
    const transport = [...peer.transports.values()].find(
      (candidate) => candidate.appData.direction === 'recv' && !candidate.closed,
    )
    if (!transport) throw new RoomError('unknown-transport', 'Create a receive transport first.')

    const consumer = await transport.consume({
      producerId: options.producerId,
      rtpCapabilities,
      // Paused until the client has wired the track; otherwise the first
      // frames arrive before anything can render them.
      paused: true,
      appData: {
        peerId: peer.id,
        producerPeerId: found.peer.id,
        source: found.entry.source,
        transportId: transport.id,
      },
    })
    const entry = {
      consumer,
      producerId: options.producerId,
      producerPeerId: found.peer.id,
      source: found.entry.source,
    }
    peer.consumers.set(consumer.id, entry)
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id))
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id)
      peer.send('consumerClosed', { consumerId: consumer.id })
    })
    consumer.on('producerpause', () => peer.send('consumerPaused', { consumerId: consumer.id }))
    consumer.on('producerresume', () => peer.send('consumerResumed', { consumerId: consumer.id }))
    return this.describeConsumer(consumer, entry)
  }

  private describeConsumer(
    consumer: types.Consumer,
    entry: { producerId: string; producerPeerId: string; source: MediaSource },
  ): ResponseResult<'consume'> {
    return {
      consumerId: consumer.id,
      producerId: entry.producerId,
      participantId: entry.producerPeerId,
      kind: consumer.kind,
      source: entry.source,
      rtpParameters: consumer.rtpParameters as unknown as Record<string, unknown>,
      producerPaused: consumer.producerPaused,
    }
  }

  getConsumer(peer: Peer, consumerId: string): types.Consumer {
    const entry = peer.consumers.get(consumerId)
    if (!entry || entry.consumer.closed) {
      throw new RoomError('unknown-consumer', 'That media stream no longer exists.')
    }
    return entry.consumer
  }

  async resumeConsumer(peer: Peer, consumerId: string): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId)
    await consumer.resume()
    // mediasoup asks for one on resume too; asking again is cheap and covers
    // a resume that raced the transport coming up.
    if (consumer.kind === 'video') await consumer.requestKeyFrame().catch(() => undefined)
  }

  /** Request a keyframe for every live video consumer on one transport. */
  async requestKeyFrames(peer: Peer, transportId: string): Promise<number> {
    let requested = 0
    for (const entry of peer.consumers.values()) {
      const consumer = entry.consumer
      if (consumer.closed || consumer.paused || consumer.kind !== 'video') continue
      if ((consumer.appData as { transportId?: string }).transportId !== transportId) continue
      await consumer.requestKeyFrame().catch(() => undefined)
      requested += 1
    }
    return requested
  }

  async pauseConsumer(peer: Peer, consumerId: string): Promise<void> {
    await this.getConsumer(peer, consumerId).pause()
  }

  async setConsumerLayers(
    peer: Peer,
    consumerId: string,
    layers: { spatialLayer: number; temporalLayer?: number },
  ): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId)
    if (consumer.kind !== 'video') return
    await consumer.setPreferredLayers(layers)
  }

  closeConsumer(peer: Peer, consumerId: string): void {
    const entry = peer.consumers.get(consumerId)
    if (!entry) return
    entry.consumer.close()
    peer.consumers.delete(consumerId)
  }

  /* --------------------------------------------------------------- close */

  close(reason: NotificationData<'closed'>['code']): void {
    if (this.closed) return
    this.closed = true
    for (const peer of this.peers.values()) {
      peer.send('closed', { code: reason, message: 'The room was closed.' })
      peer.close()
    }
    this.peers.clear()
    this.router.close()
    this.log('room-closed', { room: this.name, reason })
  }
}
