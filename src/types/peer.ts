/**
 * Peer connection and signaling domain types.
 *
 * The studio never equates "a guest exists in the guest list" with "a peer
 * connection is established". Guest identity ({@link Guest}) and transport
 * state ({@link PeerState}) are deliberately separate.
 */

export type StudioMode = 'local' | 'peer'

export type PeerRole = 'host' | 'guest'

/** Mirrors the stages of the manual-signaling handshake. */
export type PeerStatus =
  | 'initializing'
  | 'waiting-for-offer'
  | 'waiting-for-answer'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed'

export const PEER_STATUS_LABEL: Record<PeerStatus, string> = {
  initializing: 'Initializing',
  'waiting-for-offer': 'Waiting for offer',
  'waiting-for-answer': 'Waiting for answer',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  failed: 'Failed',
  closed: 'Closed',
}

/** Live transport state for one peer. Never persisted. */
export type PeerState = {
  peerId: string
  role: PeerRole
  status: PeerStatus
  connectionState: RTCPeerConnectionState | null
  iceConnectionState: RTCIceConnectionState | null
  iceGatheringState: RTCIceGatheringState | null
  signalingState: RTCSignalingState | null
  /** Set when the handshake or the transport failed, with a usable message. */
  error: string | null
  hasRemoteVideo: boolean
  hasRemoteAudio: boolean
  connectedAt: number | null
}

/**
 * Guest identity metadata. Serializable and persisted; holds no live objects.
 */
export type Guest = {
  id: string
  name: string
  /** Hide this guest's video in the program mix. */
  videoHidden: boolean
  /** Mute this guest in the *local program mix* — does not affect the peer. */
  mutedInMix: boolean
  /** Peer id this guest is bound to, when in peer mode. */
  peerId: string | null
  createdAt: number
}

/** Statistics read from `RTCPeerConnection.getStats()`. */
export type PeerStats = {
  /** Null whenever the browser did not report the metric. */
  roundTripTimeMs: number | null
  videoBitrateKbps: number | null
  audioBitrateKbps: number | null
  framesPerSecond: number | null
  framesDropped: number | null
  packetsLost: number | null
  jitterMs: number | null
  candidatePair: string | null
  sampledAt: number
}

/** A signaling payload exchanged out of band (copy/paste in manual mode). */
export type SignalEnvelope = {
  v: 1
  kind: 'offer' | 'answer'
  peerId: string
  sessionId: string
  sdp: string
  /** Display name of the sender, shown to the other side. */
  label: string
  createdAt: number
}

export type IceServerConfig = {
  urls: string[]
  username?: string
  credential?: string
}
