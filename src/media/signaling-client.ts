import {
  ERROR_TEXT,
  parseResponseResult,
  parseServerMessage,
  requestEnvelope,
  type ErrorCode,
  type NotificationData,
  type NotificationEvent,
  type RequestMethod,
  type RequestParams,
  type ResponseResult,
} from '@shared/protocol'
import type { SignalingState } from './types'

/**
 * The WebSocket to the media server: requests with responses, plus
 * notifications.
 *
 * Owns the socket lifecycle only. Reconnection with backoff happens here;
 * what to do once reconnected (resume the room, restart ICE) is the
 * session's job, driven by the `reconnected` event.
 *
 * Every request has a timeout. A signaling server that never answers must
 * not leave the studio in "connecting" forever.
 */

export class SignalingError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_TEXT[code])
    this.name = 'SignalingError'
    this.code = code
  }
}

export type SignalingClientEvents = {
  state: (state: SignalingState) => void
  notification: <E extends NotificationEvent>(event: E, data: NotificationData<E>) => void
  /** The socket came back after a drop. */
  reconnected: () => void
}

export type SignalingClientOptions = {
  url: string
  path?: string
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  /** Backoff schedule; the last value repeats. */
  reconnectDelaysMs?: number[]
  maxReconnectAttempts?: number
  pingIntervalMs?: number
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocket
}

const DEFAULTS = {
  path: '/signal',
  requestTimeoutMs: 10_000,
  connectTimeoutMs: 8_000,
  reconnectDelaysMs: [500, 1000, 2000, 4000, 8000, 15_000],
  maxReconnectAttempts: 12,
  pingIntervalMs: 20_000,
}

type Pending = {
  method: RequestMethod
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SignalingClient {
  private readonly options: Required<Omit<SignalingClientOptions, 'createSocket'>> & {
    createSocket: (url: string) => WebSocket
  }
  private socket: WebSocket | null = null
  private state: SignalingState = 'idle'
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private closedByUser = false
  private hadConnected = false
  private readonly listeners: { [K in keyof SignalingClientEvents]: Set<SignalingClientEvents[K]> } = {
    state: new Set(),
    notification: new Set(),
    reconnected: new Set(),
  }

  constructor(options: SignalingClientOptions) {
    this.options = {
      ...DEFAULTS,
      ...options,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url)),
    }
  }

  get currentState(): SignalingState {
    return this.state
  }

  on<K extends keyof SignalingClientEvents>(event: K, listener: SignalingClientEvents[K]): () => void {
    const set = this.listeners[event] as Set<SignalingClientEvents[K]>
    set.add(listener)
    return () => set.delete(listener)
  }

  /** Open the socket. Resolves once connected; rejects on a definitive failure. */
  async connect(): Promise<void> {
    if (this.state === 'connected') return
    this.closedByUser = false
    await this.open()
  }

  /** The network came back: skip the remaining backoff and dial now. */
  reconnectNow(): void {
    if (this.closedByUser || this.state === 'connected' || this.state === 'connecting') return
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    void this.open().catch(() => undefined)
  }

  close(): void {
    this.closedByUser = true
    this.clearTimers()
    this.rejectAll(new SignalingError('internal', 'The connection was closed.'))
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client-closed')
    this.setState('closed')
  }

  request<M extends RequestMethod>(method: M, params: RequestParams<M>): Promise<ResponseResult<M>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new SignalingError('internal', 'Not connected to the media server.'))
    }
    const id = this.nextId++
    return new Promise<ResponseResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SignalingError('timeout', `The server did not answer "${method}" in time.`))
      }, this.options.requestTimeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as ResponseResult<M>),
        reject,
        timer,
      })
      try {
        socket.send(JSON.stringify(requestEnvelope(id, method, params)))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new SignalingError('internal', error instanceof Error ? error.message : String(error)))
      }
    })
  }

  /* --------------------------------------------------------------- internals */

  private resolveUrl(): string {
    const base = this.options.url.replace(/^http(s)?:/i, (_m, s) => (s ? 'wss:' : 'ws:'))
    const url = new URL(base)
    if (url.pathname === '/' || url.pathname === '') url.pathname = this.options.path
    return url.toString()
  }

  private open(): Promise<void> {
    this.setState(this.hadConnected ? 'reconnecting' : 'connecting')
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let socket: WebSocket
      try {
        socket = this.options.createSocket(this.resolveUrl())
      } catch (error) {
        this.setState('failed')
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.socket = socket

      const connectTimer = setTimeout(() => {
        if (settled) return
        socket.close()
      }, this.options.connectTimeoutMs)

      socket.onopen = () => {
        clearTimeout(connectTimer)
        settled = true
        const wasReconnect = this.hadConnected
        this.hadConnected = true
        this.reconnectAttempt = 0
        this.setState('connected')
        this.startPing()
        resolve()
        if (wasReconnect) for (const listener of this.listeners.reconnected) listener()
      }
      socket.onmessage = (event) => {
        this.handleMessage(typeof event.data === 'string' ? event.data : '')
      }
      socket.onerror = () => {
        // `close` always follows; the decision is made there.
      }
      socket.onclose = (event) => {
        clearTimeout(connectTimer)
        this.stopPing()
        if (this.socket === socket) this.socket = null
        this.rejectAll(new SignalingError('internal', 'The connection to the media server dropped.'))
        if (this.closedByUser) return
        // 1008 is a policy violation (protocol version, join deadline): retrying
        // the same thing would fail the same way.
        if (event.code === 1008) {
          this.setState('failed')
          if (!settled) {
            settled = true
            reject(new SignalingError('protocol-version', event.reason || 'The server refused the connection.'))
          }
          return
        }
        if (!settled) {
          settled = true
          this.scheduleReconnect().then(resolve, reject)
          return
        }
        void this.scheduleReconnect().catch(() => undefined)
      }
    })
  }

  private scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempt >= this.options.maxReconnectAttempts) {
      this.setState('failed')
      return Promise.reject(
        new SignalingError('internal', 'Could not reach the media server after repeated attempts.'),
      )
    }
    const delays = this.options.reconnectDelaysMs
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 1000
    this.reconnectAttempt += 1
    this.setState('reconnecting')
    return new Promise<void>((resolve, reject) => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (this.closedByUser) {
          resolve()
          return
        }
        this.open().then(resolve, reject)
      }, delay)
    })
  }

  private handleMessage(raw: string): void {
    const message = parseServerMessage(raw)
    if (!message) return
    if (message.kind === 'notification') {
      for (const listener of this.listeners.notification) listener(message.event, message.data)
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (!message.ok) {
      entry.reject(new SignalingError(message.error.code, message.error.message))
      return
    }
    const result = parseResponseResult(entry.method, message.result)
    if (result === null) {
      entry.reject(new SignalingError('bad-message', `The server's answer to "${entry.method}" was malformed.`))
      return
    }
    entry.resolve(result)
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      void this.request('ping', { at: Date.now() }).catch(() => undefined)
    }, this.options.pingIntervalMs)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private clearTimers(): void {
    this.stopPing()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private setState(state: SignalingState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.listeners.state) listener(state)
  }
}
