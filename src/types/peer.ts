/**
 * Participant and transport domain types.
 *
 * The studio never equates "a guest exists in the guest list" with "media is
 * flowing". Guest identity ({@link Guest}) and live state ({@link PeerState})
 * are deliberately separate.
 */

export type StudioMode = 'local' | 'peer'

export type PeerRole = 'host' | 'guest'

export type PeerStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed'

export const PEER_STATUS_LABEL: Record<PeerStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  failed: 'Failed',
  closed: 'Closed',
}

export type TransportHealth = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

/** Live state for one remote participant. Never persisted. */
export type PeerState = {
  /** The participant's server-assigned id. */
  peerId: string
  role: PeerRole
  status: PeerStatus
  error: string | null
  hasRemoteVideo: boolean
  hasRemoteAudio: boolean
  connectedAt: number | null
  /** Health of this studio's connection to the media conference. */
  transport: TransportHealth
}

/** Guest identity metadata. Serializable and persisted; holds no live objects. */
export type Guest = {
  id: string
  name: string
  /** Hide this guest's video in the program mix. */
  videoHidden: boolean
  /** Mute this guest in the *local program mix* — does not affect the peer. */
  mutedInMix: boolean
  /** Participant id this guest is bound to while in a room. */
  peerId: string | null
  createdAt: number
}

/** Statistics sampled from the receive transport for one participant. */
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

export type IceServerConfig = {
  urls: string[]
  username?: string
  credential?: string
}
