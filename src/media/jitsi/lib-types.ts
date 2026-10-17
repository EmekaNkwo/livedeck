/**
 * The parts of lib-jitsi-meet LiveDeck uses, typed.
 *
 * The library is loaded at runtime from the Jitsi deployment itself (see
 * `loader.ts`), so client and backend versions always match; that also means
 * there is no npm package to take types from. These declarations cover only
 * what this code calls, against lib-jitsi-meet's TypeScript sources.
 */

export type JitsiMediaType = 'audio' | 'video'
export type JitsiVideoType = 'camera' | 'desktop'

export interface JitsiTrack {
  getTrack: () => MediaStreamTrack
  getType: () => JitsiMediaType
  getVideoType: () => JitsiVideoType | undefined
  isLocal: () => boolean
  isMuted: () => boolean
}

export interface JitsiLocalTrack extends JitsiTrack {
  mute: () => Promise<void>
  unmute: () => Promise<void>
  dispose: () => Promise<void>
}

export interface JitsiRemoteTrack extends JitsiTrack {
  getParticipantId: () => string
  /** Stable for the life of the source, e.g. "8da75150-v0". */
  getSourceName: () => string
}

export interface JitsiParticipant {
  /** From the participant's JWT, via the server's presence identity. */
  getIdentity: () => { user?: Record<string, string> } | undefined
}

export interface JitsiPeerConnection {
  getStats: () => Promise<RTCStatsReport>
}

export interface JitsiConnection {
  disconnect: () => unknown
}

export interface JitsiReceiverConstraints {
  lastN?: number
  defaultConstraints?: { maxHeight: number }
}

export interface JitsiConference {
  on: (event: string, handler: (...args: never[]) => void) => void
  off: (event: string, handler: (...args: never[]) => void) => void
  addTrack: (track: JitsiLocalTrack) => Promise<void>
  removeTrack: (track: JitsiLocalTrack) => Promise<void>
  replaceTrack: (oldTrack: JitsiLocalTrack | null, newTrack: JitsiLocalTrack | null) => Promise<void>
  leave: (reason?: string) => Promise<void>
  myUserId: () => string
  getParticipantById: (id: string) => JitsiParticipant | undefined
  setReceiverConstraints: (constraints: JitsiReceiverConstraints) => void
  setSenderVideoConstraint: (maxFrameHeight: number) => Promise<void>
  getActivePeerConnection: () => JitsiPeerConnection | null
  connection: JitsiConnection
}

export interface JitsiTrackInfo {
  stream: MediaStream
  track: MediaStreamTrack
  mediaType: JitsiMediaType
  sourceType: string
  videoType?: JitsiVideoType
  /**
   * The size to assume for a camera when the track cannot report one yet (a
   * fresh clone may not). Without it the library throws reading `height`.
   */
  constraints?: { height: { ideal: number }; width: { ideal: number } }
}

export interface JitsiConnectionOptions {
  hosts?: { domain: string; muc: string }
  serviceUrl?: string
}

export interface JitsiConferenceOptions {
  p2p?: { enabled: boolean }
  startSilent?: boolean
}

export interface JitsiMeetJS {
  init: (options: Record<string, unknown>) => void
  setLogLevel: (level: unknown) => void
  logLevels: { ERROR: unknown }
  events: {
    conference: {
      CONFERENCE_JOINED: string
      CONFERENCE_FAILED: string
      CONFERENCE_ERROR: string
      CONNECTION_INTERRUPTED: string
      CONNECTION_RESTORED: string
      KICKED: string
      TRACK_ADDED: string
      TRACK_REMOVED: string
      TRACK_MUTE_CHANGED: string
      USER_LEFT: string
    }
  }
  joinConference: (
    roomName: string,
    appId: string,
    token: string | null,
    options: { connectionOptions?: JitsiConnectionOptions; conferenceOptions?: JitsiConferenceOptions },
  ) => Promise<JitsiConference>
  createLocalTracksFromMediaStreams: (infos: JitsiTrackInfo[]) => JitsiLocalTrack[]
}

declare global {
  interface Window {
    JitsiMeetJS?: JitsiMeetJS
  }
}
