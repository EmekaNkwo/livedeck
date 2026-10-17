import { canProduce } from '@shared/authorization'
import type {
  ControlAction,
  MediaGrant,
  MediaSource,
  NotificationData,
  NotificationEvent,
  Participant,
} from '@shared/protocol'
import { SendAudioMix } from './jitsi/audio-mix'
import { JitsiLink } from './jitsi/jitsi-link'
import type { LinkRemoteTrack, MediaLink, SendSlot } from './media-link'
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
 * One participant's session: the room on our server, the media on Jitsi.
 *
 * Framework-free. Everything the UI needs is in the snapshot; everything that
 * must happen *now* (a track arrived, a control command) is an event.
 *
 * TWO CONNECTIONS, ONE AUTHORITY
 * ------------------------------
 * The LiveDeck server decides who is in the room and what each participant
 * may do, and signs a Jitsi token naming them. Jitsi carries the audio and
 * video. Remote media is matched to the roster by the identity in the
 * sender's token, which the browser cannot forge, and is shown only when the
 * sender's role may publish that source. A track from someone the server
 * does not list, or from a viewer, never reaches the studio.
 *
 * THE JOIN SEQUENCE
 * -----------------
 *  1. connect the socket and join the room (roster, role, media grant)
 *  2. join the Jitsi conference with the grant
 *  3. send whatever local tracks were requested before or after joining
 *
 * RECOVERY
 * --------
 * The socket reconnects on its own and re-joins with the resume token. If the
 * server kept the participant, the conference link is kept too. If it did not,
 * the participant has a new identity and the link is rebuilt with a new grant.
 * A conference that drops on its own (an expired token on reconnect, a bridge
 * restart) is rejoined with a fresh grant, a few times before giving up.
 */

export type MediaSessionOptions = {
  url: string
  /** Per-step timeout for joining. */
  operationTimeoutMs?: number
  /** Injectable for tests. */
  createSignaling?: (url: string) => SignalingClient
  createLink?: () => MediaLink
  /** Delay before rejoining a dropped conference; doubles per attempt. */
  rejoinDelayMs?: number
}

const OPERATION_TIMEOUT_MS = 15_000
const MAX_REJOIN_ATTEMPTS = 3
/** Video heights for quality tiers 0, 1 and 2. */
const TIER_HEIGHTS = [180, 360, 720] as const

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

function heightFor(tier: number): number {
  return TIER_HEIGHTS[Math.max(0, Math.min(TIER_HEIGHTS.length - 1, tier))] ?? 720
}

/** Split a whole-connection stats report by direction. */
function filterReport(report: RTCStatsReport, types: ReadonlySet<string>, keep?: (stat: Record<string, unknown>) => boolean): RTCStatsReport {
  const subset = new Map<string, unknown>()
  report.forEach((stat: Record<string, unknown>, id: string) => {
    if (types.has(String(stat.type)) && (!keep || keep(stat))) subset.set(id, stat)
  })
  // A Map has RTCStatsReport's read surface (`forEach`, `get`, iteration).
  return subset as unknown as RTCStatsReport
}

const SEND_STATS = new Set(['outbound-rtp', 'remote-inbound-rtp', 'candidate-pair'])
const RECV_STATS = new Set(['inbound-rtp', 'candidate-pair'])

export class MediaSession {
  private readonly options: Required<Pick<MediaSessionOptions, 'url' | 'operationTimeoutMs' | 'rejoinDelayMs'>> &
    MediaSessionOptions
  private signaling: SignalingClient | null = null
  private link: MediaLink | null = null
  private linkOff: Array<() => void> = []
  private readonly audioMix = new SendAudioMix()
  /** Local tracks requested, by source. */
  private readonly localTracks = new Map<MediaSource, MediaStreamTrack>()
  private readonly paused = new Set<MediaSource>()
  /** Every remote track the link reported, shown or not. */
  private readonly remote = new Map<string, LinkRemoteTrack>()
  private readonly participants = new Map<string, Participant>()
  private join: JoinOptions | null = null
  private resumeToken: string | null = null
  private snapshot: SessionSnapshot = INITIAL_SNAPSHOT
  private closed = false
  private recovering = false
  private rejoinAttempts = 0
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null
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
    this.options = { operationTimeoutMs: OPERATION_TIMEOUT_MS, rejoinDelayMs: 2000, ...options }
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

  /** Connect, join the room and the conference. */
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

  /** Publish a local track. Replaces whatever the source was sending. */
  async produce(source: MediaSource, track: MediaStreamTrack): Promise<void> {
    if (this.localTracks.get(source) === track) return
    this.localTracks.set(source, track)
    await this.syncSlots()
  }

  /** Stop publishing a source. */
  async closeProducer(source: MediaSource): Promise<void> {
    if (!this.localTracks.delete(source)) return
    this.paused.delete(source)
    await this.syncSlots()
  }

  /** Pausing stops sending the source; resuming sends it again. */
  async pauseProducer(source: MediaSource, paused: boolean): Promise<void> {
    if (!this.localTracks.has(source)) return
    if (paused === this.paused.has(source)) return
    if (paused) this.paused.add(source)
    else this.paused.delete(source)
    await this.syncSlots()
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

  /** Connection statistics, split by direction, for the quality controller. */
  async getStats(): Promise<{ send: RTCStatsReport | null; recv: RTCStatsReport | null }> {
    const report = await this.link?.getStats().catch(() => null)
    if (!report) return { send: null, recv: null }
    return { send: filterReport(report, SEND_STATS), recv: filterReport(report, RECV_STATS) }
  }

  /** Receive statistics per participant, keyed by participant id. */
  async getConsumerStats(): Promise<Map<string, RTCStatsReport>> {
    const result = new Map<string, RTCStatsReport>()
    const report = await this.link?.getStats().catch(() => null)
    if (!report) return result
    const ownerOfTrack = new Map(this.snapshot.tracks.map((track) => [track.track.id, track.participantId]))
    for (const participantId of new Set(ownerOfTrack.values())) {
      result.set(
        participantId,
        filterReport(report, RECV_STATS, (stat) =>
          stat.type === 'candidate-pair' || ownerOfTrack.get(String(stat.trackIdentifier ?? '')) === participantId,
        ),
      )
    }
    return result
  }

  /** Receive every remote video at this quality tier (0 low, 2 high). */
  async setPreferredSpatialLayer(spatialLayer: number): Promise<void> {
    this.link?.setReceiveMaxHeight(heightFor(spatialLayer))
  }

  /** Cap the camera this participant sends at this quality tier. */
  async setMaxSpatialLayer(source: MediaSource, layer: number): Promise<void> {
    if (source !== 'camera') return
    await this.link?.setSendMaxHeight(heightFor(layer)).catch(() => undefined)
  }

  /** The network came back: dial the server now rather than after backoff. */
  reconnectNow(): void {
    this.signaling?.reconnectNow()
  }

  /** Wake-up hook: after a sleep or a network change, make sure media flows. */
  async checkHealth(): Promise<void> {
    if (this.closed || this.snapshot.status !== 'joined') return
    if (this.snapshot.recvTransport === 'failed' || this.snapshot.recvTransport === 'closed') {
      this.rejoinAttempts = 0
      await this.rejoinConference()
    }
  }

  /** Leave the room and release everything. Idempotent. */
  leave(): void {
    if (this.closed) return
    this.closed = true
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer)
    if (this.signaling && this.snapshot.status === 'joined') {
      void this.signaling.request('leave', {}).catch(() => undefined)
    }
    this.teardownLink()
    this.audioMix.release()
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
    const previousSelf = this.snapshot.self
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
    this.patch({ self, role: joined.role, room: joined.room })
    this.publishParticipants()

    // Same participant and a live link: the conference never noticed.
    const sameIdentity = joined.resumed && previousSelf?.id === self.id
    if (sameIdentity && this.link && this.snapshot.recvTransport === 'connected') {
      this.setStatus('joined')
      this.publishTracks()
      return
    }
    await this.connectConference(joined.media)
    this.setStatus('joined')
  }

  private async connectConference(grant: MediaGrant): Promise<void> {
    this.teardownLink()
    const link = this.options.createLink?.() ?? new JitsiLink()
    this.link = link
    this.linkOff = [
      link.on('state', (state) => this.onLinkState(link, state)),
      link.on('trackAdded', (track) => {
        if (this.link !== link) return
        this.remote.set(track.id, track)
        this.publishTracks()
      }),
      link.on('trackRemoved', (id) => {
        if (this.link !== link || !this.remote.delete(id)) return
        this.publishTracks()
      }),
      link.on('failed', (message) => {
        if (this.link !== link) return
        this.report(new Error(message))
        this.scheduleRejoin()
      }),
    ]
    await withTimeout(link.join(grant), this.options.operationTimeoutMs + 10_000, 'Joining the media conference')
    this.rejoinAttempts = 0
    await this.syncSlots()
  }

  private onLinkState(link: MediaLink, state: TransportHealth): void {
    if (this.link !== link) return
    this.patch({ sendTransport: state, recvTransport: state })
  }

  private scheduleRejoin(): void {
    if (this.closed || this.rejoinTimer || this.snapshot.status !== 'joined') return
    if (this.rejoinAttempts >= MAX_REJOIN_ATTEMPTS) {
      this.fail(new Error('Audio and video were lost and could not be restored. Leave and rejoin the room.'))
      return
    }
    const delay = this.options.rejoinDelayMs * 2 ** this.rejoinAttempts
    this.rejoinAttempts += 1
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null
      void this.rejoinConference()
    }, delay)
  }

  /** A new grant and a new conference link, for the same participant. */
  private async rejoinConference(): Promise<void> {
    const signaling = this.signaling
    if (this.closed || !signaling) return
    try {
      const grant = await withTimeout(signaling.request('getMediaGrant', {}), this.options.operationTimeoutMs, 'Renewing media access')
      await this.connectConference(grant)
    } catch (error) {
      this.report(error)
      this.scheduleRejoin()
    }
  }

  /** Push the local tracks into the link's three slots. */
  private async syncSlots(): Promise<void> {
    const role = this.snapshot.role
    const sending = new Map<MediaSource, MediaStreamTrack>()
    if (role) {
      for (const [source, track] of this.localTracks) {
        if (this.paused.has(source) || track.readyState !== 'live') continue
        if (!canProduce(role, source)) continue
        sending.set(source, track)
      }
    }
    const slots: Record<SendSlot, MediaStreamTrack | null> = {
      audio: this.audioMix.output([sending.get('mic') ?? sending.get('program-audio'), sending.get('screen-audio')]),
      camera: sending.get('camera') ?? sending.get('program') ?? null,
      screen: sending.get('screen') ?? null,
    }
    this.publishProducers(sending)
    const link = this.link
    if (!link) return
    const results = await Promise.allSettled(
      (Object.keys(slots) as SendSlot[]).map((slot) => link.setSlot(slot, slots[slot])),
    )
    for (const result of results) if (result.status === 'rejected') this.report(result.reason)
  }

  /* -------------------------------------------------------- notifications */

  private handleNotification(event: NotificationEvent, data: unknown): void {
    switch (event) {
      case 'participantJoined':
      case 'participantUpdated': {
        const { participant } = data as NotificationData<'participantJoined'>
        if (participant.id === this.snapshot.self?.id) {
          this.patch({ self: { ...participant } })
          return
        }
        this.participants.set(participant.id, participant)
        this.publishParticipants()
        this.publishTracks()
        return
      }
      case 'participantLeft': {
        const { participantId } = data as NotificationData<'participantLeft'>
        this.participants.delete(participantId)
        this.publishParticipants()
        this.publishTracks()
        for (const listener of this.listeners.participantLeft) listener(participantId)
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

  private teardownLink(): void {
    for (const off of this.linkOff) off()
    this.linkOff = []
    const link = this.link
    this.link = null
    if (link) void link.leave().catch(() => undefined)
    this.remote.clear()
    this.publishTracks()
    this.patch({ sendTransport: 'new', recvTransport: 'new' })
  }

  /* ------------------------------------------------------------ snapshot */

  /**
   * The remote tracks the studio may use: owned by someone the server lists,
   * whose role may publish that source, and not this participant's own.
   */
  private publishTracks(): void {
    const selfId = this.snapshot.self?.id ?? null
    const visible: RemoteTrack[] = []
    for (const track of this.remote.values()) {
      if (!track.ownerId || track.ownerId === selfId) continue
      const owner = this.participants.get(track.ownerId)
      if (!owner || !canProduce(owner.role, track.source)) continue
      visible.push({
        consumerId: track.id,
        producerId: track.id,
        participantId: track.ownerId,
        kind: track.kind,
        source: track.source,
        track: track.track,
        producerPaused: false,
      })
    }
    const before = new Map(this.snapshot.tracks.map((track) => [track.consumerId, track]))
    const after = new Map(visible.map((track) => [track.consumerId, track]))
    if (before.size === after.size && [...after.keys()].every((id) => before.has(id))) return
    this.patch({ tracks: visible })
    for (const [id, track] of before) {
      if (!after.has(id)) for (const listener of this.listeners.trackRemoved) listener(track)
    }
    for (const [id, track] of after) {
      if (!before.has(id)) for (const listener of this.listeners.trackAdded) listener(track)
    }
  }

  private publishParticipants(): void {
    this.patch({ participants: [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt) })
  }

  private publishProducers(sending: Map<MediaSource, MediaStreamTrack>): void {
    const producers: LocalProducerInfo[] = []
    for (const [source, track] of this.localTracks) {
      producers.push({
        producerId: source,
        source,
        kind: track.kind === 'audio' ? 'audio' : 'video',
        paused: !sending.has(source),
      })
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
