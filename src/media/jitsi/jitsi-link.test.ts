import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeGrant, fakeTrack } from '@/test/fake-media'
import type { LinkRemoteTrack } from '../media-link'
import { JitsiLink } from './jitsi-link'
import type { JitsiConference, JitsiLocalTrack, JitsiMeetJS, JitsiRemoteTrack, JitsiTrackInfo } from './lib-types'

/**
 * The Jitsi link against a scripted lib-jitsi-meet. The real library runs
 * against a real conference in the browser suite.
 */

const EVENTS = {
  CONFERENCE_JOINED: 'joined',
  CONFERENCE_FAILED: 'failed',
  CONFERENCE_ERROR: 'error',
  CONNECTION_INTERRUPTED: 'interrupted',
  CONNECTION_RESTORED: 'restored',
  KICKED: 'kicked',
  TRACK_ADDED: 'track-added',
  TRACK_REMOVED: 'track-removed',
  TRACK_MUTE_CHANGED: 'track-muted',
  USER_LEFT: 'user-left',
}

type Handler = (...args: never[]) => void

class FakeLocal implements JitsiLocalTrack {
  disposed = false
  readonly info: JitsiTrackInfo
  constructor(info: JitsiTrackInfo) {
    this.info = info
  }
  getTrack = () => this.info.track
  getType = () => this.info.mediaType
  getVideoType = () => this.info.videoType
  isLocal = () => true
  isMuted = () => false
  mute = async () => undefined
  unmute = async () => undefined
  dispose = async () => {
    this.disposed = true
    this.info.track.stop()
  }
}

class FakeConference implements JitsiConference {
  readonly handlers = new Map<string, Set<Handler>>()
  readonly log: string[] = []
  readonly identities = new Map<string, { user?: Record<string, string> }>()
  receiver: unknown = null
  sender: number | null = null
  disconnected = false
  stats: RTCStatsReport | null = null
  connection = { disconnect: () => { this.disconnected = true } }
  on(event: string, handler: Handler) {
    const set = this.handlers.get(event) ?? new Set()
    set.add(handler)
    this.handlers.set(event, set)
  }
  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler)
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
  }
  async addTrack(track: JitsiLocalTrack) {
    this.log.push(`add:${track.getType()}:${(track as FakeLocal).info.sourceType}`)
  }
  async removeTrack(track: JitsiLocalTrack) {
    this.log.push(`remove:${(track as FakeLocal).info.sourceType}`)
  }
  async replaceTrack(oldTrack: JitsiLocalTrack | null, newTrack: JitsiLocalTrack | null) {
    this.log.push(`replace:${(oldTrack as FakeLocal | null)?.info.sourceType}->${(newTrack as FakeLocal | null)?.info.sourceType}`)
  }
  async leave() {
    this.log.push('leave')
  }
  myUserId = () => 'me'
  getParticipantById = (id: string) => ({ getIdentity: () => this.identities.get(id) })
  setReceiverConstraints(constraints: unknown) {
    this.receiver = constraints
  }
  async setSenderVideoConstraint(height: number) {
    this.sender = height
  }
  getActivePeerConnection = () => (this.stats ? { getStats: async () => this.stats as RTCStatsReport } : null)
}

function remoteTrack(options: { participant: string; type: 'audio' | 'video'; videoType?: 'camera' | 'desktop'; name: string; local?: boolean; muted?: boolean }): JitsiRemoteTrack {
  const track = fakeTrack(options.type, `mst-${options.name}`)
  return {
    getTrack: () => track,
    getType: () => options.type,
    getVideoType: () => options.videoType,
    isLocal: () => options.local ?? false,
    isMuted: () => options.muted ?? false,
    getParticipantId: () => options.participant,
    getSourceName: () => options.name,
  }
}

let conference: FakeConference
let joinArgs: Parameters<JitsiMeetJS['joinConference']> | null
let joinRejects: string | null
let locals: FakeLocal[]

function api(): JitsiMeetJS {
  return {
    init: vi.fn(),
    setLogLevel: vi.fn(),
    logLevels: { ERROR: 'error' },
    events: { conference: EVENTS },
    joinConference: async (...args) => {
      joinArgs = args
      if (joinRejects) throw joinRejects
      // The real library resolves first; the join completes after a round
      // trip to the server.
      setTimeout(() => conference.emit(EVENTS.CONFERENCE_JOINED), 0)
      return conference
    },
    createLocalTracksFromMediaStreams: (infos) =>
      infos.map((info) => {
        const local = new FakeLocal(info)
        locals.push(local)
        return local
      }),
  }
}

function makeLink(options: { joinTimeoutMs?: number } = {}) {
  const states: string[] = []
  const failures: string[] = []
  const added: LinkRemoteTrack[] = []
  const removed: string[] = []
  const link = new JitsiLink({ load: async () => api(), ...options })
  link.on('state', (state) => states.push(state))
  link.on('failed', (message) => failures.push(message))
  link.on('trackAdded', (track) => added.push(track))
  link.on('trackRemoved', (id) => removed.push(id))
  return { link, states, failures, added, removed }
}

beforeEach(() => {
  conference = new FakeConference()
  joinArgs = null
  joinRejects = null
  locals = []
  vi.stubGlobal('MediaStream', class {
    tracks: MediaStreamTrack[]
    constructor(tracks: MediaStreamTrack[]) {
      this.tracks = tracks
    }
  })
})

describe('joining', () => {
  it('joins a self-hosted conference with its XMPP hosts, through the bridge only', async () => {
    const { link, states } = makeLink()
    await link.join(fakeGrant())
    expect(joinArgs?.[0]).toBe('livedeck-room')
    expect(joinArgs?.[2]).toBe('header.payload.signature')
    expect(joinArgs?.[3]).toEqual({
      connectionOptions: {
        hosts: { domain: 'meet.jitsi', muc: 'muc.meet.jitsi' },
        serviceUrl: 'wss://jitsi.test/xmpp-websocket?room=livedeck-room',
      },
      conferenceOptions: { p2p: { enabled: false } },
    })
    expect(states).toEqual(['connecting', 'connected'])
    expect(conference.receiver).toEqual({ lastN: -1, defaultConstraints: { maxHeight: 720 } })
  })

  it('joins JaaS with the app id and lets the library pick the hosts', async () => {
    const { link } = makeLink()
    await link.join(fakeGrant({ provider: 'jaas', appId: 'vpaas-magic-cookie-x', domain: '8x8.vc', serviceUrl: undefined }))
    expect(joinArgs?.[1]).toBe('vpaas-magic-cookie-x')
    expect(joinArgs?.[3].connectionOptions).toBeUndefined()
  })

  it('explains a refused token in words', async () => {
    joinRejects = 'conference.connectionError.notAllowed'
    const { link, states } = makeLink()
    await expect(link.join(fakeGrant())).rejects.toThrow('The media server refused this participant’s token.')
    expect(states.at(-1)).toBe('failed')
  })

  it('reports an unknown connection error with its code', async () => {
    joinRejects = 'connection.otherError'
    await expect(makeLink().link.join(fakeGrant())).rejects.toThrow('The media server connection failed (connection.otherError).')
  })

  it('fails when the conference never answers, or answers with a failure', async () => {
    vi.useFakeTimers()
    const slow = makeLink({ joinTimeoutMs: 1000 })
    const api_ = api()
    api_.joinConference = async () => conference
    const quiet = new JitsiLink({ load: async () => api_, joinTimeoutMs: 1000 })
    const pending = quiet.join(fakeGrant())
    const assertion = expect(pending).rejects.toThrow(/did not answer/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    vi.useRealTimers()
    void slow

    const refused = api()
    refused.joinConference = async () => {
      setTimeout(() => conference.emit(EVENTS.CONFERENCE_FAILED, 'conference.max_users'), 0)
      return conference
    }
    await expect(new JitsiLink({ load: async () => refused }).join(fakeGrant())).rejects.toThrow('The media server’s conference is full.')
  })

  it('refuses to join once left', async () => {
    const { link } = makeLink()
    await link.leave()
    await expect(link.join(fakeGrant())).rejects.toThrow(/closed/)
  })
})

describe('sending', () => {
  it('sends clones of the studio’s tracks, so disposing never ends a capture', async () => {
    const { link } = makeLink()
    const camera = fakeTrack('video')
    await link.setSlot('camera', camera)
    expect(locals).toHaveLength(0)
    await link.join(fakeGrant())
    expect(conference.log).toEqual(['add:video:camera'])
    const sent = locals[0]
    expect(sent?.info).toMatchObject({
      mediaType: 'video',
      sourceType: 'camera',
      videoType: 'camera',
      // Sized for the library even when the track cannot say yet.
      constraints: { height: { ideal: 720 }, width: { ideal: 1280 } },
    })
    expect(sent?.info.track).not.toBe(camera)

    const next = fakeTrack('video')
    await link.setSlot('camera', next)
    await link.setSlot('camera', next)
    expect(conference.log).toEqual(['add:video:camera', 'replace:camera->camera'])
    expect(sent?.disposed).toBe(true)
    expect(camera.readyState).toBe('live')

    await link.setSlot('camera', null)
    expect(conference.log.at(-1)).toBe('remove:camera')
    expect(next.readyState).toBe('live')
    await link.setSlot('camera', null)
  })

  it('labels screen and audio slots as Jitsi expects', async () => {
    const { link } = makeLink()
    await link.join(fakeGrant())
    await Promise.all([link.setSlot('screen', fakeTrack('video')), link.setSlot('audio', fakeTrack('audio'))])
    expect(locals.map((local) => [local.info.mediaType, local.info.sourceType, local.info.videoType])).toEqual([
      ['video', 'desktop', 'desktop'],
      ['audio', 'microphone', undefined],
    ])
    expect(conference.log).toEqual(['add:video:desktop', 'add:audio:microphone'])
  })

  it('stops the clone if the library cannot wrap it', async () => {
    const { link } = makeLink()
    const failing = api()
    failing.createLocalTracksFromMediaStreams = () => []
    const bare = new JitsiLink({ load: async () => failing })
    await bare.join(fakeGrant())
    await expect(bare.setSlot('camera', fakeTrack('video'))).rejects.toThrow(/could not wrap/)
    void link
  })

  it('passes quality limits to the conference', async () => {
    const { link } = makeLink()
    link.setReceiveMaxHeight(360)
    await link.setSendMaxHeight(180)
    expect(await link.getStats()).toBeNull()
    await link.join(fakeGrant())
    link.setReceiveMaxHeight(180)
    await link.setSendMaxHeight(360)
    expect(conference.receiver).toEqual({ lastN: -1, defaultConstraints: { maxHeight: 180 } })
    expect(conference.sender).toBe(360)
    conference.stats = new Map() as unknown as RTCStatsReport
    expect(await link.getStats()).toBe(conference.stats)
  })
})

describe('receiving', () => {
  it('reports remote tracks with the sender’s token identity and source', async () => {
    const { link, added, removed } = makeLink()
    await link.join(fakeGrant())
    conference.identities.set('ep1', { user: { id: 'ld-1', name: 'Ada' } })
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'ep1', type: 'video', videoType: 'camera', name: 'ep1-v0' }))
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'ep1', type: 'video', videoType: 'desktop', name: 'ep1-v1' }))
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'ep1', type: 'audio', name: 'ep1-a0' }))
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'ep2', type: 'audio', name: 'ep2-a0' }))
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'me', type: 'audio', name: 'mine', local: true }))
    expect(added.map((t) => [t.id, t.ownerId, t.kind, t.source])).toEqual([
      ['ep1-v0', 'ld-1', 'video', 'camera'],
      ['ep1-v1', 'ld-1', 'video', 'screen'],
      ['ep1-a0', 'ld-1', 'audio', 'mic'],
      ['ep2-a0', null, 'audio', 'mic'],
    ])
    expect(added[0]?.track.id).toBe('mst-ep1-v0')
    conference.emit(EVENTS.TRACK_REMOVED, remoteTrack({ participant: 'ep1', type: 'video', name: 'ep1-v0' }))
    conference.emit(EVENTS.TRACK_REMOVED, remoteTrack({ participant: 'me', type: 'audio', name: 'mine', local: true }))
    expect(removed).toEqual(['ep1-v0'])
  })

  it('treats a muted source as gone and an unmuted one as back', async () => {
    const { link, added, removed } = makeLink()
    await link.join(fakeGrant())
    conference.identities.set('ep1', { user: { id: 'ld-1' } })
    // Arrives muted: nothing until it carries media.
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'ep1', type: 'video', videoType: 'desktop', name: 'ep1-v1', muted: true }))
    expect(added).toEqual([])
    conference.emit(EVENTS.TRACK_MUTE_CHANGED, remoteTrack({ participant: 'ep1', type: 'video', videoType: 'desktop', name: 'ep1-v1' }))
    expect(added.map((t) => [t.id, t.ownerId, t.source])).toEqual([['ep1-v1', 'ld-1', 'screen']])
    // The sender stops sharing: the library mutes the source.
    conference.emit(EVENTS.TRACK_MUTE_CHANGED, remoteTrack({ participant: 'ep1', type: 'video', videoType: 'desktop', name: 'ep1-v1', muted: true }))
    expect(removed).toEqual(['ep1-v1'])
    conference.emit(EVENTS.TRACK_MUTE_CHANGED, remoteTrack({ participant: 'me', type: 'audio', name: 'mine', local: true }))
    expect(added).toHaveLength(1)
  })

  it('reports interruptions, failures and kicks', async () => {
    const { link, states, failures } = makeLink()
    await link.join(fakeGrant())
    conference.emit(EVENTS.CONNECTION_INTERRUPTED)
    conference.emit(EVENTS.CONNECTION_RESTORED)
    conference.emit(EVENTS.CONFERENCE_FAILED, 'conference.iceFailed')
    conference.emit(EVENTS.KICKED)
    expect(states.slice(2)).toEqual(['disconnected', 'connected', 'failed', 'failed'])
    expect(failures).toEqual([
      'Audio and video could not get through this network.',
      'You were removed from the media conference.',
    ])
  })
})

describe('leaving', () => {
  it('stops sending, leaves, disconnects and stops listening, once', async () => {
    const { link, states, added } = makeLink()
    await link.join(fakeGrant())
    await link.setSlot('camera', fakeTrack('video'))
    await link.leave()
    await link.leave()
    expect(conference.log.slice(-2)).toEqual(['remove:camera', 'leave'])
    expect(conference.disconnected).toBe(true)
    expect(locals[0]?.disposed).toBe(true)
    expect(states.at(-1)).toBe('closed')
    conference.emit(EVENTS.TRACK_ADDED, remoteTrack({ participant: 'ep1', type: 'audio', name: 'late' }))
    expect(added).toEqual([])
    await link.setSlot('camera', fakeTrack('video'))
  })

  it('a link left while joining leaves the conference it gets', async () => {
    let release: () => void = () => undefined
    const slow = api()
    slow.joinConference = () => new Promise((resolve) => { release = () => resolve(conference) })
    const link = new JitsiLink({ load: async () => slow })
    const joining = link.join(fakeGrant())
    await Promise.resolve()
    await link.leave()
    release()
    await joining
    expect(conference.log).toEqual(['leave'])
  })
})
