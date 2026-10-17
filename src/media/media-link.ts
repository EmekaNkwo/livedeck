import type { MediaGrant, MediaSource } from '@shared/protocol'
import type { TransportHealth } from './types'

/**
 * The media half of a session: one participant's link to the conference.
 *
 * {@link MediaSession} decides *what* to send and which remote media belongs
 * to whom; a link only moves tracks. The production link is Jitsi
 * (`jitsi/jitsi-link.ts`); tests use a scripted one.
 */

/** What a participant can send at once: one audio, one camera, one screen. */
export type SendSlot = 'audio' | 'camera' | 'screen'

export type LinkRemoteTrack = {
  /** Stable while the source exists. */
  id: string
  /** The LiveDeck participant id from the sender's token; null when absent. */
  ownerId: string | null
  kind: 'audio' | 'video'
  source: MediaSource
  track: MediaStreamTrack
}

export type MediaLinkEvents = {
  trackAdded: (track: LinkRemoteTrack) => void
  trackRemoved: (id: string) => void
  state: (state: TransportHealth) => void
  /** The conference ended for this participant; the reason is for people. */
  failed: (message: string) => void
}

export interface MediaLink {
  join: (grant: MediaGrant) => Promise<void>
  /** Send `track` in a slot, replacing what is there; null stops sending. */
  setSlot: (slot: SendSlot, track: MediaStreamTrack | null) => Promise<void>
  /** Highest video height to receive, for every remote video. */
  setReceiveMaxHeight: (height: number) => void
  /** Highest camera height to send. */
  setSendMaxHeight: (height: number) => Promise<void>
  getStats: () => Promise<RTCStatsReport | null>
  on: <K extends keyof MediaLinkEvents>(event: K, listener: MediaLinkEvents[K]) => () => void
  leave: () => Promise<void>
}
