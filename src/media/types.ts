import type {
  ControlAction,
  MediaSource,
  Participant,
  Role,
} from '@shared/protocol'

/**
 * Client-side media types.
 *
 * The studio never equates "a participant is listed" with "media is
 * flowing". Participants come from the server roster; tracks come from
 * consumers, and each is reported separately so the UI cannot imply a
 * stream it does not have.
 */

export type SignalingState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed'

/** The whole session's state, from "not started" to "in the room". */
export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'joining'
  | 'joined'
  | 'recovering'
  | 'failed'
  | 'closed'

/** The media conference's state; both directions share one connection. */
export type TransportHealth = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export type RemoteTrack = {
  consumerId: string
  producerId: string
  participantId: string
  kind: 'audio' | 'video'
  source: MediaSource
  track: MediaStreamTrack
  /** True while the *producer* is paused (the sender muted it). */
  producerPaused: boolean
}

export type LocalProducerInfo = {
  producerId: string
  source: MediaSource
  kind: 'audio' | 'video'
  paused: boolean
}

export type SessionSnapshot = {
  status: SessionStatus
  signaling: SignalingState
  /** This participant's server-assigned identity, once joined. */
  self: Participant | null
  role: Role | null
  room: string | null
  participants: Participant[]
  /** Remote tracks the studio may use, keyed by `consumerId`. */
  tracks: RemoteTrack[]
  producers: LocalProducerInfo[]
  sendTransport: TransportHealth
  recvTransport: TransportHealth
  /** A human-readable reason when `status` is `failed`. */
  error: string | null
  /** Why the server closed the session, when it did. */
  closedBecause: string | null
}

export type ControlEvent = { from: string; command: ControlAction }

export type SessionEvents = {
  snapshot: (snapshot: SessionSnapshot) => void
  /** A control command addressed to this participant, already authorized. */
  control: (event: ControlEvent) => void
  trackAdded: (track: RemoteTrack) => void
  trackRemoved: (track: RemoteTrack) => void
  participantLeft: (participantId: string) => void
  error: (message: string) => void
}

export type JoinOptions = {
  room: string
  label: string
  key?: string
  role?: 'guest' | 'viewer'
  claim?: boolean
}

export type ProduceOptions = {
  source: MediaSource
  track: MediaStreamTrack
}

export const INITIAL_SNAPSHOT: SessionSnapshot = {
  status: 'idle',
  signaling: 'idle',
  self: null,
  role: null,
  room: null,
  participants: [],
  tracks: [],
  producers: [],
  sendTransport: 'new',
  recvTransport: 'new',
  error: null,
  closedBecause: null,
}
