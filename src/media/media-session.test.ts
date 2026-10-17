import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Participant } from '@shared/protocol'
import { FakeLink, FakeSignaling, asSignalingClient, fakeTrack, settle } from '@/test/fake-media'
import { MediaSession } from './media-session'
import type { RemoteTrack } from './types'

/**
 * The session's decisions, with both connections scripted: the LiveDeck
 * server (roster, roles, grants) and the media link (Jitsi). The real Jitsi
 * link runs against a real conference in the browser suite.
 */

const participant = (id: string, role: Participant['role'] = 'guest'): Participant => ({
  id,
  role,
  label: id,
  micMuted: false,
  cameraMuted: false,
  sharing: false,
  onAir: false,
  joinedAt: 1,
})

let signaling: FakeSignaling
let session: MediaSession

function makeSession(): MediaSession {
  return new MediaSession({
    url: 'ws://test',
    operationTimeoutMs: 1000,
    rejoinDelayMs: 0,
    createSignaling: () => asSignalingClient(signaling),
    createLink: () => new FakeLink(),
  })
}

beforeEach(() => {
  FakeLink.created = []
  signaling = new FakeSignaling()
  session = makeSession()
})

afterEach(() => {
  session.leave()
  vi.unstubAllGlobals()
})

const ids = (tracks: RemoteTrack[]) => tracks.map((track) => track.consumerId).sort()

describe('join sequence', () => {
  it('joins the room, then the conference with the server’s grant', async () => {
    await session.start({ room: 'studio', label: 'Me', claim: true })
    expect(signaling.requests[0]).toMatchObject({ method: 'join', params: { room: 'studio', label: 'Me', claim: true } })
    const link = FakeLink.latest()
    expect(link.joins).toHaveLength(1)
    expect(link.joins[0]?.jwt).toBe('grant-1')
    expect(session.current).toMatchObject({
      status: 'joined',
      role: 'guest',
      room: 'studio',
      self: { id: 'self-1', label: 'Me' },
      sendTransport: 'connected',
      recvTransport: 'connected',
    })
  })

  it('refuses to start twice', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await expect(session.start({ room: 'studio', label: 'Me' })).rejects.toThrow(/already started/)
  })

  it('fails honestly when the room join is refused', async () => {
    signaling.failNext = { method: 'join', code: 'room-full' }
    await expect(session.start({ room: 'studio', label: 'Me' })).rejects.toThrow()
    expect(session.current.status).toBe('failed')
    expect(FakeLink.created).toHaveLength(0)
  })

  it('fails with the conference’s reason when media cannot join', async () => {
    const errors: string[] = []
    session.on('error', (message) => errors.push(message))
    const original = FakeLink.prototype.join
    vi.spyOn(FakeLink.prototype, 'join').mockImplementation(function (this: FakeLink, grant) {
      this.joinError = 'The media server refused this participant’s token.'
      return original.call(this, grant)
    })
    await expect(session.start({ room: 'studio', label: 'Me' })).rejects.toThrow(/refused/)
    expect(session.current).toMatchObject({ status: 'failed', error: 'The media server refused this participant’s token.' })
    expect(errors).toContain('The media server refused this participant’s token.')
  })
})

describe('sending', () => {
  it('sends the camera and screen in their own slots and replaces in place', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const link = FakeLink.latest()
    const camera = fakeTrack('video')
    const screen = fakeTrack('video')
    await session.produce('camera', camera)
    await session.produce('screen', screen)
    expect(link.slots.get('camera')).toBe(camera)
    expect(link.slots.get('screen')).toBe(screen)
    const next = fakeTrack('video')
    await session.produce('camera', next)
    await session.produce('camera', next)
    expect(link.slots.get('camera')).toBe(next)
    expect(link.slotHistory.filter(([slot]) => slot === 'camera')).toHaveLength(2)
    expect(session.current.producers.map((p) => [p.source, p.paused])).toEqual([
      ['camera', false],
      ['screen', false],
    ])
  })

  it('sends tracks requested before joining once the conference is up', async () => {
    const mic = fakeTrack('audio')
    await session.produce('mic', mic)
    expect(FakeLink.created).toHaveLength(0)
    await session.start({ room: 'studio', label: 'Me' })
    expect(FakeLink.latest().slots.get('audio')).toBe(mic)
  })

  it('pausing stops sending and resuming sends again; closing clears the slot', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const link = FakeLink.latest()
    const camera = fakeTrack('video')
    await session.produce('camera', camera)
    await session.pauseProducer('camera', true)
    expect(link.slots.get('camera') ?? null).toBeNull()
    expect(session.current.producers[0]).toMatchObject({ source: 'camera', paused: true })
    await session.pauseProducer('camera', true)
    await session.pauseProducer('camera', false)
    expect(link.slots.get('camera')).toBe(camera)
    await session.closeProducer('camera')
    await session.closeProducer('camera')
    await session.pauseProducer('camera', true)
    expect(link.slots.get('camera') ?? null).toBeNull()
    expect(session.current.producers).toEqual([])
  })

  it('mixes the microphone with a shared screen’s audio into the one audio slot', async () => {
    const destinationTrack = fakeTrack('audio', 'mixed')
    const connect = vi.fn()
    vi.stubGlobal(
      'AudioContext',
      class {
        createMediaStreamDestination() {
          return { stream: { getAudioTracks: () => [destinationTrack], getTracks: () => [destinationTrack] } }
        }
        createMediaStreamSource() {
          return { connect, disconnect: vi.fn() }
        }
        close() {
          return Promise.resolve()
        }
      },
    )
    vi.stubGlobal('MediaStream', class {
      tracks: MediaStreamTrack[]
      constructor(tracks: MediaStreamTrack[]) {
        this.tracks = tracks
      }
    })
    await session.start({ room: 'studio', label: 'Me' })
    const link = FakeLink.latest()
    const mic = fakeTrack('audio')
    await session.produce('mic', mic)
    expect(link.slots.get('audio')).toBe(mic)
    await session.produce('screen-audio', fakeTrack('audio'))
    expect(link.slots.get('audio')).toBe(destinationTrack)
    expect(connect).toHaveBeenCalledTimes(2)
    await session.closeProducer('screen-audio')
    expect(link.slots.get('audio')).toBe(mic)
  })

  it('never sends what the role may not publish', async () => {
    signaling.role = 'viewer'
    await session.start({ room: 'studio', label: 'Watcher', role: 'viewer' })
    await session.produce('camera', fakeTrack('video'))
    expect(FakeLink.latest().slots.get('camera') ?? null).toBeNull()
    expect(session.current.producers[0]).toMatchObject({ paused: true })
  })

  it('sends the program only for a director', async () => {
    await session.start({ room: 'studio', label: 'Guest' })
    await session.produce('program', fakeTrack('video'))
    expect(FakeLink.latest().slots.get('camera') ?? null).toBeNull()

    session.leave()
    signaling = new FakeSignaling()
    signaling.role = 'director'
    session = makeSession()
    await session.start({ room: 'studio', label: 'Studio' })
    const program = fakeTrack('video')
    await session.produce('program', program)
    expect(FakeLink.latest().slots.get('camera')).toBe(program)
  })

  it('skips ended tracks', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const ended = { ...fakeTrack('video'), readyState: 'ended' } as MediaStreamTrack
    await session.produce('camera', ended)
    expect(FakeLink.latest().slots.get('camera') ?? null).toBeNull()
  })
})

describe('receiving', () => {
  it('shows media only from listed participants allowed to publish it, never its own', async () => {
    signaling.participants = [participant('a'), participant('v', 'viewer')]
    await session.start({ room: 'studio', label: 'Me' })
    const added = vi.fn()
    session.on('trackAdded', added)
    const link = FakeLink.latest()
    link.deliver({ id: 'a-v0', ownerId: 'a' })
    link.deliver({ id: 'a-a0', ownerId: 'a', kind: 'audio', source: 'mic' })
    link.deliver({ id: 'v-v0', ownerId: 'v' })
    link.deliver({ id: 'me-v0', ownerId: 'self-1' })
    link.deliver({ id: 'anon-v0', ownerId: null })
    link.deliver({ id: 'a-prog', ownerId: 'a', source: 'program' })
    expect(ids(session.current.tracks)).toEqual(['a-a0', 'a-v0'])
    expect(session.current.tracks.find((t) => t.consumerId === 'a-v0')).toMatchObject({
      participantId: 'a',
      source: 'camera',
      kind: 'video',
      producerPaused: false,
    })
    expect(added).toHaveBeenCalledTimes(2)
  })

  it('holds a track until the server lists its sender, and drops it when they leave', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const removed = vi.fn()
    session.on('trackRemoved', removed)
    const left = vi.fn()
    session.on('participantLeft', left)
    const link = FakeLink.latest()
    link.deliver({ id: 'b-v0', ownerId: 'b' })
    expect(session.current.tracks).toEqual([])
    signaling.notify('participantJoined', { participant: participant('b') })
    expect(ids(session.current.tracks)).toEqual(['b-v0'])
    signaling.notify('participantLeft', { participantId: 'b' })
    expect(session.current.tracks).toEqual([])
    expect(removed).toHaveBeenCalledTimes(1)
    expect(left).toHaveBeenCalledWith('b')
  })

  it('drops a track the conference removed, once', async () => {
    signaling.participants = [participant('a')]
    await session.start({ room: 'studio', label: 'Me' })
    const link = FakeLink.latest()
    link.deliver({ id: 'a-v0', ownerId: 'a' })
    link.remove('a-v0')
    link.remove('a-v0')
    expect(session.current.tracks).toEqual([])
  })

  it('follows a participant demoted to viewer', async () => {
    signaling.participants = [participant('a')]
    await session.start({ room: 'studio', label: 'Me' })
    FakeLink.latest().deliver({ id: 'a-v0', ownerId: 'a' })
    signaling.notify('participantUpdated', { participant: participant('a', 'viewer') })
    expect(session.current.tracks).toEqual([])
  })
})

describe('roster and control', () => {
  it('tracks joins, updates and self updates', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    signaling.notify('participantJoined', { participant: participant('a') })
    signaling.notify('participantUpdated', { participant: { ...participant('a'), micMuted: true } })
    signaling.notify('participantUpdated', { participant: { ...participant('self-1'), onAir: true } })
    expect(session.current.participants[0]?.micMuted).toBe(true)
    expect(session.current.self?.onAir).toBe(true)
  })

  it('delivers control commands, sends its own, and reads keys', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const received: unknown[] = []
    session.on('control', (event) => received.push(event))
    signaling.notify('control', { from: 'dir', command: { action: 'mute-mic', muted: true } })
    expect(received).toEqual([{ from: 'dir', command: { action: 'mute-mic', muted: true } }])
    await session.control('a', { action: 'cue', text: 'go' })
    expect(signaling.requests.at(-1)).toMatchObject({ method: 'control', params: { target: 'a' } })
    await expect(session.getRoomKeys()).resolves.toEqual({ directorKey: 'dk', producerKey: 'pk' })
    await session.updateState({ sharing: true })
    expect(signaling.requests.at(-1)).toMatchObject({ method: 'updateState', params: { sharing: true } })
  })

  it('leaves when the server closes the session and reports why', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const errors: string[] = []
    session.on('error', (m) => errors.push(m))
    signaling.notify('closed', { code: 'kicked', message: 'removed' })
    expect(session.current.status).toBe('closed')
    expect(session.current.closedBecause).toBe('kicked')
    expect(errors).toEqual(['removed'])
    expect(FakeLink.latest().left).toBe(true)
  })

  it('refuses control and keys before a session exists', async () => {
    await expect(session.control('a', { action: 'kick' })).rejects.toMatchObject({ code: 'not-joined' })
    await expect(session.getRoomKeys()).rejects.toMatchObject({ code: 'not-joined' })
    await session.updateState({ sharing: true })
    expect(signaling.requests).toEqual([])
  })
})

describe('recovery', () => {
  it('keeps the conference when the server resumes the same participant', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    signaling.resumeNext = true
    await signaling.dropAndReconnect()
    expect(FakeLink.created).toHaveLength(1)
    expect(FakeLink.latest().left).toBe(false)
    expect(signaling.requests.filter((r) => r.method === 'join').at(-1)).toMatchObject({ params: { resumeToken: 'token-1' } })
    expect(session.current.status).toBe('joined')
  })

  it('rejoins the conference with the new identity when the server forgot it', async () => {
    signaling.participants = [participant('a')]
    await session.start({ room: 'studio', label: 'Me' })
    const first = FakeLink.latest()
    first.deliver({ id: 'a-v0', ownerId: 'a' })
    const camera = fakeTrack('video')
    await session.produce('camera', camera)
    signaling.selfId = 'self-2'
    await signaling.dropAndReconnect()
    const second = FakeLink.latest()
    expect(second).not.toBe(first)
    expect(first.left).toBe(true)
    expect(second.joins[0]?.jwt).toBe('grant-2')
    expect(second.slots.get('camera')).toBe(camera)
    expect(session.current.self?.id).toBe('self-2')
    // The old conference's tracks went with it.
    expect(session.current.tracks).toEqual([])
  })

  it('rejoins a dropped conference with a fresh grant', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const first = FakeLink.latest()
    const errors: string[] = []
    session.on('error', (m) => errors.push(m))
    first.fail('The media server is restarting.')
    await settle()
    expect(errors).toContain('The media server is restarting.')
    expect(signaling.count('getMediaGrant')).toBe(1)
    expect(FakeLink.latest()).not.toBe(first)
    expect(FakeLink.latest().joins[0]?.jwt).toBe('grant-2')
    expect(session.current.recvTransport).toBe('connected')
  })

  it('gives up after repeated failures and says so', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    signaling.failAlways.add('getMediaGrant')
    FakeLink.latest().fail('lost')
    await vi.waitFor(() => expect(session.current.status).toBe('failed'))
    expect(signaling.count('getMediaGrant')).toBe(3)
    expect(session.current.status).toBe('failed')
    expect(session.current.error).toMatch(/could not be restored/)
  })

  it('checkHealth rejoins a conference that failed, and leaves a healthy one alone', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await session.checkHealth()
    expect(FakeLink.created).toHaveLength(1)
    FakeLink.latest().emitState('failed')
    await session.checkHealth()
    expect(FakeLink.created).toHaveLength(2)
  })
})

describe('quality and stats', () => {
  it('maps quality tiers to video heights', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const link = FakeLink.latest()
    await session.setPreferredSpatialLayer(0)
    expect(link.receiveMaxHeight).toBe(180)
    await session.setPreferredSpatialLayer(9)
    expect(link.receiveMaxHeight).toBe(720)
    await session.setMaxSpatialLayer('camera', 1)
    expect(link.sendMaxHeight).toBe(360)
    await session.setMaxSpatialLayer('screen', 0)
    expect(link.sendMaxHeight).toBe(360)
  })

  it('splits the connection’s stats by direction and by participant', async () => {
    signaling.participants = [participant('a'), participant('b')]
    await session.start({ room: 'studio', label: 'Me' })
    const link = FakeLink.latest()
    expect(await session.getStats()).toEqual({ send: null, recv: null })
    link.deliver({ id: 'a-v0', ownerId: 'a' })
    link.deliver({ id: 'b-v0', ownerId: 'b' })
    link.stats = new Map<string, Record<string, unknown>>([
      ['out', { type: 'outbound-rtp', bytesSent: 10 }],
      ['in-a', { type: 'inbound-rtp', trackIdentifier: 'mst-a-v0', bytesReceived: 5 }],
      ['in-b', { type: 'inbound-rtp', trackIdentifier: 'mst-b-v0', bytesReceived: 7 }],
      ['pair', { type: 'candidate-pair', state: 'succeeded' }],
      ['codec', { type: 'codec' }],
    ]) as unknown as RTCStatsReport
    const { send, recv } = await session.getStats()
    expect([...(send as unknown as Map<string, unknown>).keys()]).toEqual(['out', 'pair'])
    expect([...(recv as unknown as Map<string, unknown>).keys()]).toEqual(['in-a', 'in-b', 'pair'])
    const perParticipant = await session.getConsumerStats()
    expect([...(perParticipant.get('a') as unknown as Map<string, unknown>).keys()]).toEqual(['in-a', 'pair'])
    expect([...(perParticipant.get('b') as unknown as Map<string, unknown>).keys()]).toEqual(['in-b', 'pair'])
  })

  it('reports support from the globals it needs', () => {
    expect(MediaSession.isSupported()).toBe(typeof RTCPeerConnection !== 'undefined' && typeof WebSocket !== 'undefined')
  })
})

describe('leave', () => {
  it('closes everything once and reports removed tracks', async () => {
    signaling.participants = [participant('a')]
    await session.start({ room: 'studio', label: 'Me' })
    FakeLink.latest().deliver({ id: 'a-a0', ownerId: 'a', kind: 'audio', source: 'mic' })
    const removed = vi.fn()
    session.on('trackRemoved', removed)
    session.leave()
    session.leave()
    expect(session.current.status).toBe('closed')
    expect(signaling.requests.at(-1)?.method).toBe('leave')
    expect(FakeLink.latest().left).toBe(true)
    expect(removed).toHaveBeenCalledTimes(1)
    expect(signaling.state).toBe('closed')
  })
})
