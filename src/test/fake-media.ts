import type {
  MediaGrant,
  NotificationData,
  NotificationEvent,
  Participant,
  RequestMethod,
  RequestParams,
  ResponseResult,
} from '@shared/protocol'
import type { LinkRemoteTrack, MediaLink, MediaLinkEvents, SendSlot } from '@/media/media-link'
import type { SignalingClient } from '@/media/signaling-client'
import type { TransportHealth } from '@/media/types'

/**
 * Scripted doubles for the session's two connections: the LiveDeck server
 * (signaling) and the media conference (a {@link MediaLink}).
 *
 * The server double answers every request the way the real one would and
 * lets tests push notifications and drop the socket. The link double records
 * what is sent in each slot and lets tests deliver remote tracks, as Jitsi
 * would, with the identity the sender's token carried.
 */

export function fakeTrack(kind: 'audio' | 'video', id = `${kind}-${Math.random().toString(36).slice(2, 7)}`): MediaStreamTrack {
  const track = {
    id,
    kind,
    readyState: 'live',
    enabled: true,
    contentHint: '',
    stop() {
      track.readyState = 'ended'
    },
    clone() {
      return fakeTrack(kind)
    },
  }
  return track as unknown as MediaStreamTrack
}

export function fakeGrant(overrides: Partial<MediaGrant> = {}): MediaGrant {
  return {
    provider: 'jitsi',
    domain: 'meet.jitsi',
    appId: '',
    room: 'livedeck-room',
    jwt: 'header.payload.signature',
    expiresAt: Date.now() + 3600_000,
    libraryUrl: 'https://jitsi.test/libs/lib-jitsi-meet.min.js',
    serviceUrl: 'wss://jitsi.test/xmpp-websocket?room=livedeck-room',
    mucDomain: 'muc.meet.jitsi',
    ...overrides,
  }
}

type SignalingState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed'

export class FakeSignaling {
  state: SignalingState = 'idle'
  readonly requests: Array<{ method: RequestMethod; params: unknown }> = []
  participants: Participant[] = []
  selfId = 'self-1'
  role: Participant['role'] = 'guest'
  resumeTokens = 0
  grants = 0
  /** Set to make the next join report a successful resume. */
  resumeNext = false
  /** Set to make the next request of this method fail with this code. */
  failNext: { method: RequestMethod; code: string } | null = null
  /** Methods that fail every time, with `internal`. */
  readonly failAlways = new Set<RequestMethod>()
  private readonly listeners = {
    state: new Set<(state: SignalingState) => void>(),
    notification: new Set<(event: NotificationEvent, data: unknown) => void>(),
    reconnected: new Set<() => void>(),
  }

  on(event: 'state' | 'notification' | 'reconnected', listener: never): () => void {
    const set = this.listeners[event] as Set<never>
    set.add(listener)
    return () => set.delete(listener)
  }

  async connect(): Promise<void> {
    this.setState('connected')
  }

  close(): void {
    this.setState('closed')
  }

  reconnectNow(): void {}

  /** The socket dropped and came back. */
  async dropAndReconnect(): Promise<void> {
    this.setState('reconnecting')
    this.setState('connected')
    for (const listener of this.listeners.reconnected) listener()
    await settle()
  }

  notify<E extends NotificationEvent>(event: E, data: NotificationData<E>): void {
    for (const listener of this.listeners.notification) listener(event, data)
  }

  count(method: RequestMethod): number {
    return this.requests.filter((request) => request.method === method).length
  }

  async request<M extends RequestMethod>(method: M, params: RequestParams<M>): Promise<ResponseResult<M>> {
    this.requests.push({ method, params })
    if (this.failNext?.method === method) {
      const { code } = this.failNext
      this.failNext = null
      throw Object.assign(new Error(code), { code })
    }
    if (this.failAlways.has(method)) throw Object.assign(new Error('internal'), { code: 'internal' })
    switch (method) {
      case 'join': {
        const resumed = this.resumeNext
        this.resumeNext = false
        this.resumeTokens += 1
        this.grants += 1
        return {
          participantId: this.selfId,
          role: this.role,
          room: (params as RequestParams<'join'>).room,
          resumeToken: `token-${this.resumeTokens}`,
          resumed,
          participants: this.participants,
          media: fakeGrant({ jwt: `grant-${this.grants}` }),
        } as ResponseResult<M>
      }
      case 'getMediaGrant':
        this.grants += 1
        return fakeGrant({ jwt: `grant-${this.grants}` }) as ResponseResult<M>
      case 'getRoomKeys':
        return { directorKey: 'dk', producerKey: 'pk' } as ResponseResult<M>
      case 'ping':
        return { at: (params as RequestParams<'ping'>).at } as ResponseResult<M>
      default:
        return {} as ResponseResult<M>
    }
  }

  private setState(state: SignalingState): void {
    this.state = state
    for (const listener of this.listeners.state) listener(state)
  }
}

export function asSignalingClient(fake: FakeSignaling): SignalingClient {
  return fake as unknown as SignalingClient
}

export class FakeLink implements MediaLink {
  static created: FakeLink[] = []
  readonly joins: MediaGrant[] = []
  readonly slots = new Map<SendSlot, MediaStreamTrack | null>()
  readonly slotHistory: Array<[SendSlot, MediaStreamTrack | null]> = []
  receiveMaxHeight: number | null = null
  sendMaxHeight: number | null = null
  stats: RTCStatsReport | null = null
  left = false
  /** Set to make `join` reject with this message. */
  joinError: string | null = null
  private readonly listeners: { [K in keyof MediaLinkEvents]: Set<MediaLinkEvents[K]> } = {
    trackAdded: new Set(),
    trackRemoved: new Set(),
    state: new Set(),
    failed: new Set(),
  }

  constructor() {
    FakeLink.created.push(this)
  }

  static latest(): FakeLink {
    const link = FakeLink.created.at(-1)
    if (!link) throw new Error('No link was created.')
    return link
  }

  on<K extends keyof MediaLinkEvents>(event: K, listener: MediaLinkEvents[K]): () => void {
    const set = this.listeners[event] as Set<MediaLinkEvents[K]>
    set.add(listener)
    return () => set.delete(listener)
  }

  async join(grant: MediaGrant): Promise<void> {
    this.joins.push(grant)
    this.emitState('connecting')
    if (this.joinError) {
      this.emitState('failed')
      throw new Error(this.joinError)
    }
    this.emitState('connected')
  }

  async setSlot(slot: SendSlot, track: MediaStreamTrack | null): Promise<void> {
    if ((this.slots.get(slot) ?? null) === track) return
    this.slots.set(slot, track)
    this.slotHistory.push([slot, track])
  }

  setReceiveMaxHeight(height: number): void {
    this.receiveMaxHeight = height
  }

  async setSendMaxHeight(height: number): Promise<void> {
    this.sendMaxHeight = height
  }

  async getStats(): Promise<RTCStatsReport | null> {
    return this.stats
  }

  async leave(): Promise<void> {
    this.left = true
    this.emitState('closed')
  }

  /* --------------------------------------------------- test controls */

  deliver(track: Partial<LinkRemoteTrack> & Pick<LinkRemoteTrack, 'id' | 'ownerId'>): LinkRemoteTrack {
    const remote: LinkRemoteTrack = {
      kind: 'video',
      source: 'camera',
      track: fakeTrack(track.kind ?? 'video', `mst-${track.id}`),
      ...track,
    }
    for (const listener of this.listeners.trackAdded) listener(remote)
    return remote
  }

  remove(id: string): void {
    for (const listener of this.listeners.trackRemoved) listener(id)
  }

  fail(message: string): void {
    this.emitState('failed')
    for (const listener of this.listeners.failed) listener(message)
  }

  emitState(state: TransportHealth): void {
    for (const listener of this.listeners.state) listener(state)
  }
}

/** Let promise chains and zero-delay timers run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
