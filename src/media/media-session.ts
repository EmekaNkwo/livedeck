import { Device, type types as msTypes } from 'mediasoup-client'
import type {
  ControlAction,
  IceServer,
  MediaSource,
  NotificationData,
  NotificationEvent,
  Participant,
  ProducerInfo,
  Role,
} from '@shared/protocol'
import { applyContentHint, encodingFor } from './encodings'
import { SignalingClient, SignalingError } from './signaling-client'
import {
  INITIAL_SNAPSHOT,
  type JoinOptions,
  type LocalProducerInfo,
  type RemoteTrack,
  type SessionEvents,
  type SessionSnapshot,
  type SessionStatus,
  type TransportHealth,
} from './types'

/**
 * One participant's connection to the SFU.
 *
 * Framework-free. Owns the mediasoup Device, one send and one receive
 * transport, the producers for local media and a consumer per remote
 * producer. Everything the UI needs is in the snapshot; everything that
 * must happen *now* (a track arrived, a control command) is an event.
 *
 * THE JOIN SEQUENCE
 * -----------------
 *  1. connect the socket            5. create the receive transport
 *  2. join the room                 6. consume every producer in the room
 *  3. load the Device               7. produce whatever local tracks were
 *  4. create the send transport        requested before or after joining
 *
 * Transports connect lazily: mediasoup-client fires `connect` on the first
 * produce or consume, and that is answered with the signaling request.
 *
 * RECONNECTION
 * ------------
 * The socket reconnects on its own. When it comes back, the session re-joins
 * with its resume token. If the server still has the participant, the
 * transports are restarted (ICE restart) and local producers are kept. If it
 * does not, everything is rebuilt from scratch: new transports, local tracks
 * re-published, remote producers re-consumed. Either way the identity the
 * UI sees is the one the server reports, and nothing is duplicated.
 *
 * IDEMPOTENCY
 * -----------
 * Producers are keyed by source and consumers by producer id. A notification
 * seen twice, or a resume that lists producers already consumed, changes
 * nothing.
 */

export type MediaSessionOptions = {
  url: string
  /** Extra ICE servers from settings, merged after the server's. */
  extraIceServers?: IceServer[]
  /** Per-step timeout for transport creation and media operations. */
  operationTimeoutMs?: number
  /** Injectable for tests. */
  createSignaling?: (url: string) => SignalingClient
  createDevice?: () => Device
}

const OPERATION_TIMEOUT_MS = 10_000

type Listeners = { [K in keyof SessionEvents]: Set<SessionEvents[K]> }

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignalingError('timeout', `${what} timed out.`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export class MediaSession {
  private readonly options: Required<Pick<MediaSessionOptions, 'url' | 'operationTimeoutMs'>> &
    MediaSessionOptions
  private signaling: SignalingClient | null = null
  private device: Device | null = null
  private sendTransport: msTypes.Transport | null = null
  private recvTransport: msTypes.Transport | null = null
  /** Local producers by source. One per source, always. */
  private readonly producers = new Map<MediaSource, msTypes.Producer>()
  /** Local tracks requested, by source, so a rebuild can re-publish them. */
  private readonly localTracks = new Map<MediaSource, MediaStreamTrack>()
  /** Remote consumers by producer id. */
  private readonly consumers = new Map<string, msTypes.Consumer>()
  private readonly consuming = new Set<string>()
  /**
   * Producer creation in flight, by source.
   *
   * `produce` is called from effects that can fire again before the first
   * call resolves. Without this, two calls for one source both saw no
   * producer and created two: the server kept the second, the browser kept
   * encoding both, and receivers could be handed the one the server had
   * already closed.
   */
  private readonly producing = new Map<MediaSource, Promise<void>>()
  /** Consumers the server closed while our consume call was still in flight. */
  private readonly closedConsumerIds = new Set<string>()
  private readonly participants = new Map<string, Participant>()
  private readonly knownProducers = new Map<string, ProducerInfo>()
  private join: JoinOptions | null = null
  private resumeToken: string | null = null
  private iceServers: IceServer[] = []
  private snapshot: SessionSnapshot = INITIAL_SNAPSHOT
  private closed = false
  private recovering = false
  private readonly listeners: Listeners = {
    snapshot: new Set(),
    control: new Set(),
    trackAdded: new Set(),
    trackRemoved: new Set(),
    participantLeft: new Set(),
    error: new Set(),
  }
  private readonly unsubscribe: Array<() => void> = []

  constructor(options: MediaSessionOptions) {
    this.options = { operationTimeoutMs: OPERATION_TIMEOUT_MS, ...options }
  }

  /* ------------------------------------------------------------- public */

  get current(): SessionSnapshot {
    return this.snapshot
  }

  on<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): () => void {
    const set = this.listeners[event] as Set<SessionEvents[K]>
    set.add(listener)
    return () => set.delete(listener)
  }

  static isSupported(): boolean {
    return typeof RTCPeerConnection !== 'undefined' && typeof WebSocket !== 'undefined'
  }

  /** Connect, join and bring up both transports. */
  async start(join: JoinOptions): Promise<void> {
    if (this.closed) throw new Error('This session is closed.')
    if (this.join) throw new Error('This session has already started.')
    this.join = join
    this.setStatus('connecting')
    const signaling = this.options.createSignaling?.(this.options.url) ?? new SignalingClient({ url: this.options.url })
    this.signaling = signaling
    this.unsubscribe.push(
      signaling.on('state', (state) => this.patch({ signaling: state })),
      signaling.on('notification', (event, data) => this.handleNotification(event, data)),
      signaling.on('reconnected', () => void this.recover()),
    )
    try {
      await signaling.connect()
      await this.joinAndBuild(false)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** Publish a local track. Replaces an existing producer of the same source. */
  async produce(source: MediaSource, track: MediaStreamTrack): Promise<void> {
    this.localTracks.set(source, track)
    // A creation already in flight for this source picks up the latest track.
    const pending = this.producing.get(source)
    if (pending) {
      await pending
      const created = this.producers.get(source)
      if (created && !created.closed && created.track !== track) await created.replaceTrack({ track })
      this.publishProducers()
      return
    }
    const existing = this.producers.get(source)
    if (existing && !existing.closed) {
      if (existing.track === track) return
      await existing.replaceTrack({ track })
      this.publishProducers()
      return
    }
    if (this.snapshot.status !== 'joined') return // published once joined
    await this.createProducer(source, track)
  }

  /** Stop publishing a source. */
  async closeProducer(source: MediaSource): Promise<void> {
    this.localTracks.delete(source)
    // A creation in flight finishes first, so it cannot outlive the close.
    await this.producing.get(source)?.catch(() => undefined)
    const producer = this.producers.get(source)
    this.producers.delete(source)
    if (!producer) return
    const id = producer.id
    producer.close()
    this.publishProducers()
    if (this.snapshot.status === 'joined') {
      await this.signaling?.request('closeProducer', { producerId: id }).catch(() => undefined)
    }
  }

  async pauseProducer(source: MediaSource, paused: boolean): Promise<void> {
    const producer = this.producers.get(source)
    if (!producer || producer.closed) return
    if (paused) producer.pause()
    else producer.resume()
    this.publishProducers()
    await this.signaling
      ?.request(paused ? 'pauseProducer' : 'resumeProducer', { producerId: producer.id })
      .catch(() => undefined)
  }

  async updateState(state: { micMuted?: boolean; cameraMuted?: boolean; sharing?: boolean }): Promise<void> {
    if (this.snapshot.status !== 'joined') return
    await this.signaling?.request('updateState', state)
  }

  /** Send a control command. Throws `SignalingError('forbidden')` when refused. */
  async control(target: string, command: ControlAction): Promise<void> {
    if (!this.signaling) throw new SignalingError('not-joined')
    await this.signaling.request('control', { target, command })
  }

  async getRoomKeys(): Promise<{ directorKey: string; producerKey: string }> {
    if (!this.signaling) throw new SignalingError('not-joined')
    return this.signaling.request('getRoomKeys', {})
  }

  /** Transport-level statistics, for the quality manager. */
  async getStats(): Promise<{ send: RTCStatsReport | null; recv: RTCStatsReport | null }> {
    const [send, recv] = await Promise.all([
      this.sendTransport && !this.sendTransport.closed ? this.sendTransport.getStats() : null,
      this.recvTransport && !this.recvTransport.closed ? this.recvTransport.getStats() : null,
    ])
    return { send, recv }
  }

  /** Per-consumer statistics, keyed by participant id. */
  async getConsumerStats(): Promise<Map<string, RTCStatsReport>> {
    const result = new Map<string, RTCStatsReport>()
    await Promise.all(
      [...this.consumers.values()].map(async (consumer) => {
        if (consumer.closed) return
        const participantId = String(consumer.appData.participantId ?? '')
        try {
          result.set(participantId, await consumer.getStats())
        } catch {
          // A consumer closing mid-sample has no stats; nothing to report.
        }
      }),
    )
    return result
  }

  /** Ask the SFU for a simulcast layer on every remote video consumer. */
  async setPreferredSpatialLayer(spatialLayer: number): Promise<void> {
    const signaling = this.signaling
    if (!signaling || this.snapshot.status !== 'joined') return
    await Promise.all(
      [...this.consumers.values()]
        .filter((consumer) => consumer.kind === 'video' && !consumer.closed)
        .map((consumer) =>
          signaling.request('setConsumerLayers', { consumerId: consumer.id, spatialLayer }).catch(() => undefined),
        ),
    )
  }

  /** Cap the simulcast layers this participant sends for a source. */
  async setMaxSpatialLayer(source: MediaSource, layer: number): Promise<void> {
    const producer = this.producers.get(source)
    if (!producer || producer.closed || producer.kind !== 'video') return
    try {
      await producer.setMaxSpatialLayer(layer)
    } catch {
      // A single-layer producer (screen) cannot be capped; nothing to do.
    }
  }

  /** The network came back: dial the server now rather than after backoff. */
  reconnectNow(): void {
    this.signaling?.reconnectNow()
  }

  /** Wake-up hook: after a sleep or a network change, make sure media flows. */
  async checkHealth(): Promise<void> {
    if (this.closed || this.snapshot.status !== 'joined') return
    const stale = [this.sendTransport, this.recvTransport].filter(
      (transport): transport is msTypes.Transport =>
        Boolean(transport && !transport.closed) &&
        (transport?.connectionState === 'disconnected' || transport?.connectionState === 'failed'),
    )
    await Promise.all(stale.map((transport) => this.restartIce(transport)))
  }

  /** Leave the room and release everything. Idempotent. */
  leave(): void {
    if (this.closed) return
    this.closed = true
    if (this.signaling && this.snapshot.status === 'joined') {
      void this.signaling.request('leave', {}).catch(() => undefined)
    }
    this.teardownMedia()
    for (const off of this.unsubscribe) off()
    this.unsubscribe.length = 0
    this.signaling?.close()
    this.signaling = null
    this.setStatus('closed')
  }

  /* -------------------------------------------------------------- build */

  private async joinAndBuild(resume: boolean): Promise<void> {
    const signaling = this.signaling
    const join = this.join
    if (!signaling || !join) return
    this.setStatus(resume ? 'recovering' : 'joining')

    const joined = await withTimeout(
      signaling.request('join', {
        room: join.room,
        label: join.label,
        key: join.key,
        role: join.role,
        claim: join.claim,
        resumeToken: resume ? (this.resumeToken ?? undefined) : undefined,
      }),
      this.options.operationTimeoutMs,
      'Joining the room',
    )
    this.resumeToken = joined.resumeToken
    this.iceServers = [...joined.iceServers, ...(this.options.extraIceServers ?? [])]

    const self: Participant = {
      id: joined.participantId,
      role: joined.role,
      label: join.label,
      micMuted: false,
      cameraMuted: false,
      sharing: false,
      onAir: false,
      joinedAt: Date.now(),
    }
    this.participants.clear()
    for (const participant of joined.participants) {
      if (participant.id !== self.id) this.participants.set(participant.id, participant)
    }
    this.knownProducers.clear()
    for (const producer of joined.producers) this.knownProducers.set(producer.id, producer)
    this.patch({ self, role: joined.role, room: joined.room, iceServers: this.iceServers })
    this.publishParticipants()

    if (joined.resumed && this.device && this.sendTransport && this.recvTransport) {
      // The server kept our transports. Restart ICE on both and we are back.
      await this.restartTransports()
      this.setStatus('joined')
      await this.consumeMissing()
      return
    }

    // Fresh build (first join, or the server forgot us).
    this.teardownMedia()
    const device = this.options.createDevice?.() ?? new Device()
    await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities as unknown as msTypes.RtpCapabilities })
    this.device = device

    if (this.canProduce(joined.role)) {
      this.sendTransport = await this.createTransport('send')
    }
    this.recvTransport = await this.createTransport('recv')
    this.setStatus('joined')

    await this.consumeMissing()
    for (const [source, track] of this.localTracks) {
      if (track.readyState !== 'live') continue
      await this.createProducer(source, track).catch((error: unknown) => this.report(error))
    }
  }

  private canProduce(role: Role): boolean {
    return role !== 'viewer'
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<msTypes.Transport> {
    const signaling = this.signaling
    const device = this.device
    if (!signaling || !device) throw new SignalingError('internal', 'No device.')
    const params = await withTimeout(
      signaling.request('createWebRtcTransport', { direction }),
      this.options.operationTimeoutMs,
      `Creating the ${direction} transport`,
    )
    const transportOptions: msTypes.TransportOptions = {
      id: params.id,
      iceParameters: params.iceParameters as unknown as msTypes.IceParameters,
      iceCandidates: params.iceCandidates as unknown as msTypes.IceCandidate[],
      dtlsParameters: params.dtlsParameters as unknown as msTypes.DtlsParameters,
      iceServers: this.iceServers.map((server) => ({ ...server })),
    }
    const transport =
      direction === 'send'
        ? device.createSendTransport(transportOptions)
        : device.createRecvTransport(transportOptions)

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      signaling
        .request('connectWebRtcTransport', {
          transportId: transport.id,
          dtlsParameters: dtlsParameters as unknown as Record<string, unknown>,
        })
        .then(() => callback(), errback)
    })
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        signaling
          .request('produce', {
            transportId: transport.id,
            kind,
            rtpParameters: rtpParameters as unknown as Record<string, unknown>,
            source: appData.source as MediaSource,
          })
          .then(({ producerId }) => callback({ id: producerId }), errback)
      })
    }
    transport.on('connectionstatechange', (state) => {
      this.patch(direction === 'send' ? { sendTransport: state as TransportHealth } : { recvTransport: state as TransportHealth })
      if (state === 'failed') void this.restartIce(transport)
    })
    return transport
  }

  private async restartTransports(): Promise<void> {
    const transports = [this.sendTransport, this.recvTransport].filter(
      (transport): transport is msTypes.Transport => Boolean(transport && !transport.closed),
    )
    await Promise.all(transports.map((transport) => this.restartIce(transport)))
  }

  private async restartIce(transport: msTypes.Transport): Promise<void> {
    const signaling = this.signaling
    if (!signaling || transport.closed || this.snapshot.status === 'closed') return
    try {
      await transport.updateIceServers({ iceServers: this.iceServers.map((server) => ({ ...server })) })
      const { iceParameters } = await signaling.request('restartIce', { transportId: transport.id })
      await transport.restartIce({ iceParameters: iceParameters as unknown as msTypes.IceParameters })
    } catch (error) {
      this.report(error)
    }
  }

  /** Serialize producer creation per source; see {@link producing}. */
  private createProducer(source: MediaSource, track: MediaStreamTrack): Promise<void> {
    const previous = this.producing.get(source) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.createProducerNow(source, this.localTracks.get(source) ?? track))
    const tracked = next.finally(() => {
      if (this.producing.get(source) === tracked) this.producing.delete(source)
    })
    this.producing.set(source, tracked)
    return tracked
  }

  private async createProducerNow(source: MediaSource, track: MediaStreamTrack): Promise<void> {
    // The source may have been closed while this waited its turn.
    if (!this.localTracks.has(source)) return
    const transport = this.sendTransport
    if (!transport || transport.closed) return
    const existing = this.producers.get(source)
    if (existing && !existing.closed) {
      if (existing.track !== track) await existing.replaceTrack({ track })
      return
    }
    const encoding = encodingFor(source)
    applyContentHint(track, encoding.contentHint)
    const producer = await withTimeout(
      transport.produce({
        track,
        ...(track.kind === 'video' ? { encodings: encoding.encodings } : {}),
        codecOptions: encoding.codecOptions as msTypes.ProducerCodecOptions,
        appData: { source },
        // Keep the track alive for the registry; the producer does not own it.
        stopTracks: false,
        disableTrackOnPause: true,
      }),
      this.options.operationTimeoutMs,
      `Publishing ${source}`,
    )
    this.producers.set(source, producer)
    producer.on('transportclose', () => {
      if (this.producers.get(source) === producer) this.producers.delete(source)
      this.publishProducers()
    })
    producer.on('trackended', () => {
      void this.closeProducer(source)
    })
    this.publishProducers()
  }

  /* ----------------------------------------------------------- consumers */

  private async consumeMissing(): Promise<void> {
    for (const producer of this.knownProducers.values()) {
      await this.consume(producer).catch((error: unknown) => this.report(error))
    }
  }

  private async consume(info: ProducerInfo): Promise<void> {
    const signaling = this.signaling
    const device = this.device
    const transport = this.recvTransport
    if (!signaling || !device || !transport || transport.closed) return
    if (this.consumers.has(info.id) || this.consuming.has(info.id)) return
    if (info.participantId === this.snapshot.self?.id) return
    this.consuming.add(info.id)
    try {
      const params = await withTimeout(
        signaling.request('consume', {
          producerId: info.id,
          rtpCapabilities: device.rtpCapabilities as unknown as Record<string, unknown>,
        }),
        this.options.operationTimeoutMs,
        `Receiving ${info.source}`,
      )
      if (this.consumers.has(info.id) || !this.knownProducers.has(info.id)) return
      const consumer = await transport.consume({
        id: params.consumerId,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters as unknown as msTypes.RtpParameters,
        appData: { participantId: params.participantId, source: params.source },
      })
      /*
       * The producer may have closed while the consume call was in flight:
       * its producerClosed / consumerClosed notifications then arrived before
       * there was a consumer to drop. Handing that consumer to the UI would
       * show a frozen track in place of the live one.
       */
      if (!this.knownProducers.has(info.id) || this.closedConsumerIds.has(consumer.id)) {
        consumer.close()
        return
      }
      this.consumers.set(info.id, consumer)
      const remote: RemoteTrack = {
        consumerId: consumer.id,
        producerId: params.producerId,
        participantId: params.participantId,
        kind: params.kind,
        source: params.source,
        track: consumer.track,
        producerPaused: params.producerPaused,
      }
      consumer.on('transportclose', () => this.dropConsumer(info.id))
      consumer.on('trackended', () => this.dropConsumer(info.id))
      this.patch({ tracks: [...this.snapshot.tracks.filter((t) => t.consumerId !== remote.consumerId), remote] })
      for (const listener of this.listeners.trackAdded) listener(remote)
      // Created paused on the server; resume once the track is wired.
      await signaling.request('resumeConsumer', { consumerId: consumer.id })
    } finally {
      this.consuming.delete(info.id)
    }
  }

  private dropConsumer(producerId: string): void {
    const consumer = this.consumers.get(producerId)
    if (!consumer) return
    this.consumers.delete(producerId)
    const remote = this.snapshot.tracks.find((t) => t.consumerId === consumer.id)
    if (!consumer.closed) consumer.close()
    this.patch({ tracks: this.snapshot.tracks.filter((t) => t.consumerId !== consumer.id) })
    if (remote) for (const listener of this.listeners.trackRemoved) listener(remote)
  }

  private dropConsumersOf(participantId: string): void {
    for (const [producerId, consumer] of this.consumers) {
      if (consumer.appData.participantId === participantId) this.dropConsumer(producerId)
    }
    for (const [id, producer] of this.knownProducers) {
      if (producer.participantId === participantId) this.knownProducers.delete(id)
    }
  }

  /* ------------------------------------------------------- notifications */

  private handleNotification<E extends NotificationEvent>(event: E, data: NotificationData<E>): void {
    switch (event) {
      case 'participantJoined': {
        const { participant } = data as NotificationData<'participantJoined'>
        this.participants.set(participant.id, participant)
        this.publishParticipants()
        return
      }
      case 'participantUpdated': {
        const { participant } = data as NotificationData<'participantUpdated'>
        if (participant.id === this.snapshot.self?.id) {
          this.patch({ self: participant })
          return
        }
        this.participants.set(participant.id, participant)
        this.publishParticipants()
        return
      }
      case 'participantLeft': {
        const { participantId } = data as NotificationData<'participantLeft'>
        this.participants.delete(participantId)
        this.dropConsumersOf(participantId)
        this.publishParticipants()
        for (const listener of this.listeners.participantLeft) listener(participantId)
        return
      }
      case 'newProducer': {
        const { producer } = data as NotificationData<'newProducer'>
        this.knownProducers.set(producer.id, producer)
        if (this.snapshot.status === 'joined') void this.consume(producer).catch((e: unknown) => this.report(e))
        return
      }
      case 'producerClosed': {
        const { producerId } = data as NotificationData<'producerClosed'>
        this.knownProducers.delete(producerId)
        this.dropConsumer(producerId)
        return
      }
      case 'producerPaused':
      case 'producerResumed': {
        const { producerId } = data as NotificationData<'producerPaused'>
        const known = this.knownProducers.get(producerId)
        if (known) this.knownProducers.set(producerId, { ...known, paused: event === 'producerPaused' })
        this.patch({
          tracks: this.snapshot.tracks.map((t) =>
            t.producerId === producerId ? { ...t, producerPaused: event === 'producerPaused' } : t,
          ),
        })
        return
      }
      case 'consumerClosed': {
        const { consumerId } = data as NotificationData<'consumerClosed'>
        const entry = [...this.consumers.entries()].find(([, c]) => c.id === consumerId)
        if (entry) this.dropConsumer(entry[0])
        else this.closedConsumerIds.add(consumerId)
        return
      }
      case 'consumerPaused':
      case 'consumerResumed': {
        const { consumerId } = data as NotificationData<'consumerPaused'>
        this.patch({
          tracks: this.snapshot.tracks.map((t) =>
            t.consumerId === consumerId ? { ...t, producerPaused: event === 'consumerPaused' } : t,
          ),
        })
        return
      }
      case 'control': {
        const control = data as NotificationData<'control'>
        for (const listener of this.listeners.control) listener(control)
        return
      }
      case 'closed': {
        const { code, message } = data as NotificationData<'closed'>
        this.patch({ closedBecause: code })
        this.report(new SignalingError('forbidden', message))
        this.leave()
        return
      }
    }
  }

  /* ------------------------------------------------------------ recovery */

  private async recover(): Promise<void> {
    if (this.closed || this.recovering || !this.join) return
    this.recovering = true
    try {
      await this.joinAndBuild(true)
    } catch (error) {
      this.fail(error)
    } finally {
      this.recovering = false
    }
  }

  private teardownMedia(): void {
    for (const producer of this.producers.values()) producer.close()
    this.producers.clear()
    for (const consumer of this.consumers.values()) consumer.close()
    const removed = this.snapshot.tracks
    this.consumers.clear()
    this.consuming.clear()
    this.sendTransport?.close()
    this.recvTransport?.close()
    this.sendTransport = null
    this.recvTransport = null
    this.device = null
    this.patch({ tracks: [], producers: [], sendTransport: 'new', recvTransport: 'new' })
    for (const track of removed) for (const listener of this.listeners.trackRemoved) listener(track)
  }

  /* ------------------------------------------------------------ snapshot */

  private publishParticipants(): void {
    this.patch({ participants: [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt) })
  }

  private publishProducers(): void {
    const producers: LocalProducerInfo[] = []
    for (const [source, producer] of this.producers) {
      if (producer.closed) continue
      producers.push({ producerId: producer.id, source, kind: producer.kind, paused: producer.paused })
    }
    this.patch({ producers })
  }

  private setStatus(status: SessionStatus): void {
    this.patch({ status, ...(status === 'joined' ? { error: null } : {}) })
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.patch({ status: 'failed', error: message })
    this.report(error)
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    for (const listener of this.listeners.error) listener(message)
  }

  private patch(changes: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes }
    for (const listener of this.listeners.snapshot) listener(this.snapshot)
  }
}
