import type { MediaGrant, MediaSource } from '@shared/protocol'
import type { LinkRemoteTrack, MediaLink, MediaLinkEvents, SendSlot } from '../media-link'
import type { TransportHealth } from '../types'
import type { JitsiConference, JitsiLocalTrack, JitsiMeetJS, JitsiRemoteTrack } from './lib-types'
import { loadJitsi } from './loader'

/**
 * A {@link MediaLink} over a Jitsi conference (JaaS or self-hosted).
 *
 * THE STUDIO OWNS ITS TRACKS
 * --------------------------
 * Cameras, microphones and screens are captured and reference-counted by the
 * studio's stream registry. lib-jitsi-meet stops a track's media when its
 * local track is disposed, and in Chrome a camera "mute" re-opens the camera
 * itself. So each slot sends a *clone* of the studio's track: disposing the
 * clone never ends a capture another part of the studio is using, and
 * pausing a source removes its clone rather than asking Jitsi to mute it.
 */

const JOIN_TIMEOUT_MS = 20_000

type Listeners = { [K in keyof MediaLinkEvents]: Set<MediaLinkEvents[K]> }

type SlotState = { source: MediaStreamTrack; clone: MediaStreamTrack; local: JitsiLocalTrack }

const FAILURE_TEXT: Record<string, string> = {
  'conference.connectionError.notAllowed': 'The media server refused this participant’s token.',
  'conference.connectionError.accessDenied': 'The media server refused this participant’s token.',
  'conference.authenticationRequired': 'The media server refused this participant’s token.',
  'conference.max_users': 'The media server’s conference is full.',
  'conference.iceFailed': 'Audio and video could not get through this network.',
  'conference.destroyed': 'The media conference ended.',
  'conference.focusDisconnected': 'The media server lost its conference focus.',
  'conference.gracefulShutdown': 'The media server is restarting.',
}

function describeFailure(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return FAILURE_TEXT[code] ?? `The media server connection failed${code ? ` (${code})` : ''}.`
}

function sourceOf(track: JitsiRemoteTrack): MediaSource {
  if (track.getType() === 'audio') return 'mic'
  return track.getVideoType() === 'desktop' ? 'screen' : 'camera'
}

export type JitsiLinkOptions = {
  load?: (libraryUrl: string) => Promise<JitsiMeetJS>
  joinTimeoutMs?: number
}

export class JitsiLink implements MediaLink {
  private readonly options: JitsiLinkOptions
  private api: JitsiMeetJS | null = null
  private conference: JitsiConference | null = null
  private readonly slots = new Map<SendSlot, SlotState>()
  /** What each slot should send, so tracks set before joining go out on join. */
  private readonly wanted = new Map<SendSlot, MediaStreamTrack>()
  private readonly detach: Array<() => void> = []
  private queue: Promise<void> = Promise.resolve()
  private left = false
  private readonly listeners: Listeners = {
    trackAdded: new Set(),
    trackRemoved: new Set(),
    state: new Set(),
    failed: new Set(),
  }

  constructor(options: JitsiLinkOptions = {}) {
    this.options = options
  }

  on<K extends keyof MediaLinkEvents>(event: K, listener: MediaLinkEvents[K]): () => void {
    const set = this.listeners[event] as Set<MediaLinkEvents[K]>
    set.add(listener)
    return () => set.delete(listener)
  }

  async join(grant: MediaGrant): Promise<void> {
    if (this.left) throw new Error('This media link was closed.')
    this.emitState('connecting')
    const api = await (this.options.load ?? loadJitsi)(grant.libraryUrl)
    this.api = api
    let conference: JitsiConference
    try {
      conference = await api.joinConference(grant.room, grant.appId, grant.jwt, {
        connectionOptions:
          grant.provider === 'jitsi'
            ? {
                hosts: { domain: grant.domain, muc: grant.mucDomain ?? `muc.${grant.domain}` },
                serviceUrl: grant.serviceUrl,
              }
            : undefined,
        // Everything goes through the bridge: the studio composes every
        // guest, which a peer-to-peer call between two people would bypass.
        conferenceOptions: { p2p: { enabled: false } },
      })
    } catch (error) {
      this.emitState('failed')
      throw new Error(describeFailure(error))
    }
    if (this.left) {
      void conference.leave().catch(() => undefined)
      return
    }
    this.conference = conference
    this.bind(api, conference)
    await this.waitForJoin(api, conference)
    // Receive every remote video, at 720p until told otherwise.
    conference.setReceiverConstraints({ lastN: -1, defaultConstraints: { maxHeight: 720 } })
    for (const [slot, track] of this.wanted) await this.enqueue(() => this.apply(slot, track))
  }

  setSlot(slot: SendSlot, track: MediaStreamTrack | null): Promise<void> {
    if (track) this.wanted.set(slot, track)
    else this.wanted.delete(slot)
    if (!this.conference) return Promise.resolve()
    return this.enqueue(() => this.apply(slot, track))
  }

  setReceiveMaxHeight(height: number): void {
    this.conference?.setReceiverConstraints({ lastN: -1, defaultConstraints: { maxHeight: height } })
  }

  async setSendMaxHeight(height: number): Promise<void> {
    await this.conference?.setSenderVideoConstraint(height)
  }

  async getStats(): Promise<RTCStatsReport | null> {
    const pc = this.conference?.getActivePeerConnection()
    return pc ? pc.getStats() : null
  }

  async leave(): Promise<void> {
    if (this.left) return
    this.left = true
    for (const off of this.detach.splice(0)) off()
    const conference = this.conference
    this.conference = null
    for (const slot of [...this.slots.keys()]) await this.drop(slot, conference)
    if (conference) {
      await conference.leave().catch(() => undefined)
      try {
        conference.connection.disconnect()
      } catch {
        // Already disconnected.
      }
    }
    this.emitState('closed')
  }

  /* ------------------------------------------------------------ internals */

  /** Slot changes run one at a time: Jitsi renegotiates for each. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async apply(slot: SendSlot, track: MediaStreamTrack | null): Promise<void> {
    const conference = this.conference
    const api = this.api
    if (!conference || !api || this.left) return
    const current = this.slots.get(slot)
    if (current?.source === track) return
    if (!track) {
      await this.drop(slot, conference)
      return
    }
    const clone = track.clone()
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
    const [local] = api.createLocalTracksFromMediaStreams([
      {
        stream: new MediaStream([clone]),
        track: clone,
        mediaType: slot === 'audio' ? 'audio' : 'video',
        sourceType: slot === 'audio' ? 'microphone' : slot === 'screen' ? 'desktop' : 'camera',
        videoType: slot === 'audio' ? undefined : slot === 'screen' ? 'desktop' : 'camera',
        constraints:
          slot === 'audio'
            ? undefined
            : { height: { ideal: settings.height ?? 720 }, width: { ideal: settings.width ?? 1280 } },
      },
    ])
    if (!local) {
      clone.stop()
      throw new Error('The media library could not wrap a local track.')
    }
    if (current) {
      await conference.replaceTrack(current.local, local)
      await current.local.dispose().catch(() => undefined)
    } else {
      await conference.addTrack(local)
    }
    this.slots.set(slot, { source: track, clone, local })
  }

  private async drop(slot: SendSlot, conference: JitsiConference | null): Promise<void> {
    const current = this.slots.get(slot)
    if (!current) return
    this.slots.delete(slot)
    if (conference) await conference.removeTrack(current.local).catch(() => undefined)
    await current.local.dispose().catch(() => undefined)
    current.clone.stop()
  }

  private bind(api: JitsiMeetJS, conference: JitsiConference): void {
    const events = api.events.conference
    const listen = (event: string, handler: (...args: never[]) => void) => {
      conference.on(event, handler)
      this.detach.push(() => conference.off(event, handler))
    }
    /*
     * A remote source is reported only while it carries media. lib-jitsi-meet
     * removes a sender's track by *muting* its source (the source stays
     * signaled), so a mute is reported as a removal and an unmute as a new
     * arrival. A source that arrives muted waits for its first unmute.
     */
    const describe = (track: JitsiRemoteTrack): LinkRemoteTrack => {
      const identity = conference.getParticipantById(track.getParticipantId())?.getIdentity()
      return {
        id: track.getSourceName(),
        ownerId: identity?.user?.id ?? null,
        kind: track.getType(),
        source: sourceOf(track),
        track: track.getTrack(),
      }
    }
    const announce = (track: JitsiRemoteTrack) => {
      const remote = describe(track)
      for (const listener of this.listeners.trackAdded) listener(remote)
    }
    const retract = (track: JitsiRemoteTrack) => {
      for (const listener of this.listeners.trackRemoved) listener(track.getSourceName())
    }
    listen(events.TRACK_ADDED, (track: JitsiRemoteTrack) => {
      if (track.isLocal() || track.isMuted()) return
      announce(track)
    })
    listen(events.TRACK_MUTE_CHANGED, (track: JitsiRemoteTrack) => {
      if (track.isLocal()) return
      if (track.isMuted()) retract(track)
      else announce(track)
    })
    listen(events.TRACK_REMOVED, (track: JitsiRemoteTrack) => {
      if (track.isLocal()) return
      retract(track)
    })
    listen(events.CONNECTION_INTERRUPTED, () => this.emitState('disconnected'))
    listen(events.CONNECTION_RESTORED, () => this.emitState('connected'))
    const fail = (message: string) => {
      this.emitState('failed')
      for (const listener of this.listeners.failed) listener(message)
    }
    listen(events.CONFERENCE_FAILED, (error: string) => fail(describeFailure(error)))
    listen(events.KICKED, () => fail('You were removed from the media conference.'))
  }

  private waitForJoin(api: JitsiMeetJS, conference: JitsiConference): Promise<void> {
    const events = api.events.conference
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        this.emitState('failed')
        reject(new Error('The media conference did not answer in time.'))
      }, this.options.joinTimeoutMs ?? JOIN_TIMEOUT_MS)
      const joined = () => {
        cleanup()
        this.emitState('connected')
        resolve()
      }
      const failed = (error: string) => {
        cleanup()
        reject(new Error(describeFailure(error)))
      }
      const cleanup = () => {
        clearTimeout(timer)
        conference.off(events.CONFERENCE_JOINED, joined)
        conference.off(events.CONFERENCE_FAILED, failed)
      }
      conference.on(events.CONFERENCE_JOINED, joined)
      conference.on(events.CONFERENCE_FAILED, failed)
    })
  }

  private emitState(state: TransportHealth): void {
    for (const listener of this.listeners.state) listener(state)
  }
}
