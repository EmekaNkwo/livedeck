import type { SignalEnvelope } from '@/types/peer'
import {
  PROTOCOL_VERSION,
  SERVER_ERROR_TEXT,
  parseServerMessage,
  toCandidatePayload,
  type ClientMessage,
  type RoomPeer,
} from '@shared/signaling-protocol'
import type {
  JoinRoomOptions,
  SignalingAdapter,
  SignalingCapabilities,
  SignalingEvents,
  TransportState,
} from './types'

/**
 * Room-based signaling over a WebSocket.
 *
 * This is the adapter that makes the workflow behave like real VDO.Ninja:
 * everyone who opens the same room name finds each other, with no link to
 * carry and no answer to paste back.
 *
 * It requires the relay in `server/` to be running. That is a deliberate
 * trade, not a default — see the capability flags below and the README. The
 * manual adapter remains the zero-infrastructure path, and nothing here
 * changes it.
 *
 * TRICKLE ICE
 * -----------
 * A live channel can carry candidates one at a time, so this adapter does not
 * wait for gathering to complete. Connections come up in a fraction of the
 * time the manual path needs, and a candidate discovered late (a TURN
 * allocation, say) still gets through instead of being lost.
 */

/** Backoff schedule for reconnection, in milliseconds. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]
const PING_INTERVAL_MS = 20_000

export type WebSocketAdapterOptions = {
  /** Base URL of the relay, e.g. `wss://signal.example.com` or `http://localhost:3001`. */
  url: string
  /** Path the relay listens on. */
  path?: string
}

export class WebSocketSignalingAdapter implements SignalingAdapter {
  readonly capabilities: SignalingCapabilities = {
    id: 'websocket',
    label: 'Signaling server (rooms)',
    crossDevice: true,
    requiresManualExchange: false,
    supportsRooms: true,
    supportsTrickleIce: true,
    description:
      'Peers find each other by room name through a relay, and ICE candidates trickle as they ' +
      'are discovered — so connections come up quickly and nothing has to be copied. Requires ' +
      'the signaling server to be running; it relays connection setup only and never sees media.',
  }

  private socket: WebSocket | null = null
  private events: Partial<SignalingEvents> = {}
  private state: TransportState = 'idle'

  private peerId: string | null = null
  private pendingJoin: JoinRoomOptions | null = null

  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Set when `disconnect()` was called, so we do not fight the user. */
  private closedByUs = false

  private readonly endpoint: string

  constructor(options: WebSocketAdapterOptions) {
    this.endpoint = toWebSocketUrl(options.url, options.path ?? '/signal')
  }

  async connect(events: Partial<SignalingEvents>): Promise<void> {
    this.events = events
    this.closedByUs = false
    this.open()
  }

  localPeerId(): string | null {
    return this.peerId
  }

  getState(): TransportState {
    return this.state
  }

  /**
   * Enter a room.
   *
   * The request is remembered, so a reconnect re-joins automatically without
   * the UI having to notice the socket ever dropped.
   */
  async joinRoom(options: JoinRoomOptions): Promise<void> {
    this.pendingJoin = options
    this.send({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: options.room,
      role: options.role,
      label: options.label,
    })
  }

  /**
   * Leave the room, keeping the socket.
   *
   * `pendingJoin` is cleared too, so a reconnect does not helpfully re-join a
   * room the user deliberately left.
   */
  async leaveRoom(): Promise<void> {
    if (!this.pendingJoin) return
    this.pendingJoin = null
    this.send({ v: PROTOCOL_VERSION, type: 'leave' })
  }

  /** Relay a local description to the peer it is addressed to. */
  async publish(envelope: SignalEnvelope): Promise<void> {
    // `peerId` on the envelope is the *remote* peer this description is for;
    // the server infers the sender from the connection.
    this.send({
      v: PROTOCOL_VERSION,
      type: envelope.kind,
      to: envelope.peerId,
      sdp: envelope.sdp,
    })
  }

  sendCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    if (!candidate.candidate) return
    this.send({
      v: PROTOCOL_VERSION,
      type: 'candidate',
      to: peerId,
      candidate: toCandidatePayload({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        usernameFragment: candidate.usernameFragment ?? null,
      }),
    })
  }

  /**
   * Not used by this transport — there is nothing to paste when a server is
   * relaying. Implemented because the interface requires it, and because a
   * caller holding only a `SignalingAdapter` should not have to special-case.
   */
  async ingest(raw: string): Promise<void> {
    void raw
    this.events.onError?.(
      'This session is using a signaling server, so there is no code to paste — guests join by ' +
        'opening the room.',
    )
  }

  disconnect(): void {
    this.closedByUs = true
    this.clearTimers()
    this.pendingJoin = null
    this.peerId = null

    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close(1000, 'client-closed')
      } catch {
        // Already closing.
      }
    }
    this.setState('closed')
    this.events = {}
  }

  /* ----------------------------------------------------------- internals */

  private open(): void {
    if (this.closedByUs) return
    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(this.endpoint)
    } catch {
      // A malformed URL throws synchronously; treat it as a failed attempt so
      // the backoff reports it rather than silently doing nothing.
      this.scheduleReconnect()
      return
    }

    this.socket = socket

    socket.onopen = () => {
      this.reconnectAttempt = 0
      this.setState('connected')
      this.startPing()
      // Re-join after a reconnect, so the room survives a dropped socket.
      if (this.pendingJoin) void this.joinRoom(this.pendingJoin)
    }

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      this.handle(event.data)
    }

    socket.onerror = () => {
      // Always followed by `onclose`; reconnection is handled there.
    }

    socket.onclose = (event: CloseEvent) => {
      this.clearTimers()
      this.socket = null
      this.peerId = null

      if (this.closedByUs) return

      /*
       * 1008 is a policy violation — the server rejected us for a reason that
       * will not change by trying again (room full, bad protocol version).
       * Retrying would loop forever, so this is terminal.
       */
      if (event.code === 1008) {
        this.setState('failed')
        this.events.onError?.(
          event.reason
            ? (SERVER_ERROR_TEXT[event.reason as keyof typeof SERVER_ERROR_TEXT] ?? event.reason)
            : 'The signaling server refused the connection.',
        )
        return
      }

      this.scheduleReconnect()
    }
  }

  private handle(raw: string): void {
    const message = parseServerMessage(raw)
    if (!message) {
      // The server is as untrusted as any other remote input.
      this.events.onError?.('The signaling server sent a message this build could not read.')
      return
    }

    switch (message.type) {
      case 'joined': {
        this.peerId = message.peerId
        // Everyone already in the room is immediately connectable.
        for (const peer of message.peers) this.announce(peer)
        return
      }

      case 'peer-joined':
        this.announce(message.peer)
        return

      case 'peer-left':
        this.events.onPeerGone?.(message.peerId)
        return

      case 'offer':
        this.events.onOffer?.(this.toEnvelope('offer', message.from, message.sdp))
        return

      case 'answer':
        this.events.onAnswer?.(this.toEnvelope('answer', message.from, message.sdp))
        return

      case 'candidate':
        this.events.onRemoteCandidate?.(message.from, {
          candidate: message.candidate.candidate,
          sdpMid: message.candidate.sdpMid,
          sdpMLineIndex: message.candidate.sdpMLineIndex,
          usernameFragment: message.candidate.usernameFragment,
        })
        return

      case 'error':
        this.events.onError?.(message.message || SERVER_ERROR_TEXT[message.code])
        if (message.fatal) this.setState('failed')
        return

      case 'pong':
        // Liveness only; nothing to do.
        return
    }
  }

  private announce(peer: RoomPeer): void {
    this.events.onPeerAvailable?.({
      peerId: peer.peerId,
      role: peer.role,
      label: peer.label,
    })
  }

  private toEnvelope(kind: 'offer' | 'answer', from: string, sdp: string): SignalEnvelope {
    return {
      v: 1,
      kind,
      // The envelope's peerId identifies the *other* side, which is what the
      // peer manager keys its connections on.
      peerId: from,
      sessionId: this.pendingJoin?.room ?? '',
      sdp,
      label: this.pendingJoin?.label ?? 'Peer',
      createdAt: Date.now(),
    }
  }

  private send(message: ClientMessage): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Dropping is correct rather than queueing: a stale offer replayed after
      // a reconnect would be answered against a peer connection that no longer
      // exists. The re-join on reconnect restarts negotiation cleanly.
      this.events.onError?.(
        'Not connected to the signaling server, so that message was not sent. Reconnecting…',
      )
      return
    }
    try {
      socket.send(JSON.stringify(message))
    } catch {
      this.events.onError?.('The signaling message could not be sent.')
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return
    this.clearTimers()

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      15_000
    this.reconnectAttempt += 1
    this.setState('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      this.send({ v: PROTOCOL_VERSION, type: 'ping', at: Date.now() })
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer === null) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private clearTimers(): void {
    this.stopPing()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(state: TransportState): void {
    if (this.state === state) return
    this.state = state
    this.events.onTransportState?.(state)
  }
}

/**
 * Normalize a configured base URL into a WebSocket endpoint.
 *
 * Accepts `http(s)://` and `ws(s)://` so the setting can be pasted from a
 * browser address bar, and upgrades the scheme to match — a `wss://` page
 * cannot open a `ws://` socket, and getting that wrong produces a mixed-content
 * failure that is not obvious from the error.
 */
export function toWebSocketUrl(base: string, path: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)

  url.protocol = url.protocol === 'http:' ? 'ws:' : url.protocol === 'https:' ? 'wss:' : url.protocol
  url.pathname = path.startsWith('/') ? path : `/${path}`
  url.search = ''
  url.hash = ''
  return url.toString()
}
