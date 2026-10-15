import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Participant, ProducerInfo } from '@shared/protocol'
import { FakeDevice, FakeSignaling, asDevice, asSignalingClient, fakeTrack } from '@/test/fake-mediasoup'
import { MediaSession } from './media-session'
import type { RemoteTrack } from './types'

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

const producerInfo = (id: string, participantId: string, source: ProducerInfo['source'], kind: ProducerInfo['kind']): ProducerInfo => ({
  id,
  participantId,
  kind,
  source,
  paused: false,
})

let signaling: FakeSignaling
let device: FakeDevice
let session: MediaSession

function makeSession(): MediaSession {
  device = new FakeDevice()
  return new MediaSession({
    url: 'ws://test',
    operationTimeoutMs: 1000,
    createSignaling: () => asSignalingClient(signaling),
    createDevice: () => asDevice(device),
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  signaling = new FakeSignaling()
  session = makeSession()
})

describe('join sequence', () => {
  it('connects, joins, loads the device and opens both transports', async () => {
    signaling.participants = [participant('other')]
    await session.start({ room: 'studio', label: 'Me' })
    const snapshot = session.current
    expect(snapshot.status).toBe('joined')
    expect(snapshot.self?.id).toBe('self-1')
    expect(snapshot.participants.map((p) => p.id)).toEqual(['other'])
    expect(device.loaded).toBe(true)
    expect(device.transports.map((t) => t.direction)).toEqual(['send', 'recv'])
    expect(signaling.requests.map((r) => r.method)).toEqual([
      'join',
      'createWebRtcTransport',
      'createWebRtcTransport',
    ])
  })

  it('a viewer gets no send transport', async () => {
    signaling.role = 'viewer'
    await session.start({ room: 'studio', label: 'V', role: 'viewer' })
    expect(device.transports.map((t) => t.direction)).toEqual(['recv'])
  })

  it('refuses to start twice', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await expect(session.start({ room: 'studio', label: 'Me' })).rejects.toThrow(/already started/)
  })

  it('fails honestly when the join is refused', async () => {
    signaling.request = async () => {
      throw Object.assign(new Error('full'), { code: 'room-full' })
    }
    const errors: string[] = []
    session.on('error', (message) => errors.push(message))
    await expect(session.start({ room: 'studio', label: 'Me' })).rejects.toThrow('full')
    expect(session.current.status).toBe('failed')
    expect(session.current.error).toBe('full')
    expect(errors).toEqual(['full'])
  })
})

describe('producing', () => {
  it('publishes a track once per source and replaces it in place', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const camera = fakeTrack('video')
    await session.produce('camera', camera)
    const send = device.transports[0]!
    expect(send.producers).toHaveLength(1)
    expect(send.producers[0]?.appData.source).toBe('camera')
    expect(session.current.producers).toEqual([{ producerId: 'p1', source: 'camera', kind: 'video', paused: false }])

    const replacement = fakeTrack('video')
    await session.produce('camera', replacement)
    expect(send.producers).toHaveLength(1)
    expect(send.producers[0]?.track).toBe(replacement)
    // The same track again is a no-op.
    await session.produce('camera', replacement)
    expect(signaling.requests.filter((r) => r.method === 'produce')).toHaveLength(1)
  })

  it('queues a track requested before joining and publishes it after', async () => {
    const mic = fakeTrack('audio')
    const pending = session.produce('mic', mic) // before start: recorded, not sent
    await pending
    await session.start({ room: 'studio', label: 'Me' })
    expect(session.current.producers.map((p) => p.source)).toEqual(['mic'])
  })

  it('closes a producer and tells the server', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await session.produce('screen', fakeTrack('video'))
    await session.closeProducer('screen')
    expect(session.current.producers).toEqual([])
    expect(signaling.requests.at(-1)).toMatchObject({ method: 'closeProducer', params: { producerId: 'p1' } })
    // Closing again is harmless.
    await session.closeProducer('screen')
  })

  it('pauses and resumes a producer', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await session.produce('mic', fakeTrack('audio'))
    await session.pauseProducer('mic', true)
    expect(device.transports[0]?.producers[0]?.paused).toBe(true)
    expect(signaling.requests.at(-1)?.method).toBe('pauseProducer')
    await session.pauseProducer('mic', false)
    expect(signaling.requests.at(-1)?.method).toBe('resumeProducer')
  })
})

describe('producer races', () => {
  it('two concurrent produce calls for one source create one producer with the latest track', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const first = fakeTrack('video')
    const second = fakeTrack('video')
    await Promise.all([session.produce('camera', first), session.produce('camera', second)])
    const send = device.transports[0]!
    expect(send.producers).toHaveLength(1)
    expect(send.producers[0]?.track).toBe(second)
    expect(signaling.requests.filter((r) => r.method === 'produce')).toHaveLength(1)
  })

  it('closing a source while its producer is being created leaves no producer', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const creating = session.produce('camera', fakeTrack('video'))
    await session.closeProducer('camera')
    await creating
    expect(session.current.producers).toEqual([])
    expect(device.transports[0]?.producers.every((p) => p.closed)).toBe(true)
  })
})

describe('consuming', () => {
  it('drops a consumer whose producer closed while the consume call was in flight', async () => {
    signaling.participants = [participant('a')]
    await session.start({ room: 'studio', label: 'Me' })
    const info = producerInfo('pa1', 'a', 'camera', 'video')
    signaling.producers = [info]
    const realRequest = signaling.request.bind(signaling)
    signaling.request = (async (method: string, params: unknown) => {
      const result = await realRequest(method as never, params as never)
      if (method === 'consume') {
        // The server closes the producer before our consume call returns.
        signaling.notify('producerClosed', { producerId: 'pa1', participantId: 'a' })
        signaling.notify('consumerClosed', { consumerId: (result as { consumerId: string }).consumerId })
      }
      return result
    }) as typeof signaling.request
    signaling.notify('newProducer', { producer: info })
    await flush()
    await flush()
    expect(session.current.tracks).toEqual([])
    expect(device.transports[1]?.consumers.every((c) => c.closed)).toBe(true)
  })

  it('consumes every producer present at join, resumes each, and never its own', async () => {
    signaling.participants = [participant('a')]
    signaling.producers = [
      producerInfo('pa1', 'a', 'mic', 'audio'),
      producerInfo('pa2', 'a', 'camera', 'video'),
      producerInfo('pself', 'self-1', 'mic', 'audio'),
    ]
    const added: RemoteTrack[] = []
    session.on('trackAdded', (track) => added.push(track))
    await session.start({ room: 'studio', label: 'Me' })
    expect(added.map((t) => t.producerId).sort()).toEqual(['pa1', 'pa2'])
    expect(session.current.tracks).toHaveLength(2)
    expect(signaling.requests.filter((r) => r.method === 'resumeConsumer')).toHaveLength(2)
    expect(signaling.requests.filter((r) => r.method === 'consume')).toHaveLength(2)
  })

  it('consumes a producer announced later, exactly once even if announced twice', async () => {
    signaling.participants = [participant('a')]
    await session.start({ room: 'studio', label: 'Me' })
    const info = producerInfo('pa1', 'a', 'camera', 'video')
    signaling.producers = [info]
    signaling.notify('newProducer', { producer: info })
    signaling.notify('newProducer', { producer: info })
    await flush()
    await flush()
    expect(session.current.tracks).toHaveLength(1)
    expect(signaling.requests.filter((r) => r.method === 'consume')).toHaveLength(1)
  })

  it('drops the track when the producer closes or the participant leaves', async () => {
    signaling.participants = [participant('a'), participant('b')]
    signaling.producers = [producerInfo('pa1', 'a', 'mic', 'audio'), producerInfo('pb1', 'b', 'mic', 'audio')]
    const removed: string[] = []
    session.on('trackRemoved', (track) => removed.push(track.producerId))
    const left: string[] = []
    session.on('participantLeft', (id) => left.push(id))
    await session.start({ room: 'studio', label: 'Me' })

    signaling.notify('producerClosed', { producerId: 'pa1', participantId: 'a' })
    expect(session.current.tracks.map((t) => t.producerId)).toEqual(['pb1'])
    expect(removed).toEqual(['pa1'])

    signaling.notify('participantLeft', { participantId: 'b' })
    expect(session.current.tracks).toEqual([])
    expect(session.current.participants).toEqual([participant('a')])
    expect(left).toEqual(['b'])
    expect(removed).toEqual(['pa1', 'pb1'])
  })

  it('reflects pause and resume of a remote producer', async () => {
    signaling.participants = [participant('a')]
    signaling.producers = [producerInfo('pa1', 'a', 'camera', 'video')]
    await session.start({ room: 'studio', label: 'Me' })
    signaling.notify('producerPaused', { producerId: 'pa1' })
    expect(session.current.tracks[0]?.producerPaused).toBe(true)
    signaling.notify('consumerResumed', { consumerId: 'c1' })
    expect(session.current.tracks[0]?.producerPaused).toBe(false)
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

  it('delivers control commands and relays refusals', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const received: unknown[] = []
    session.on('control', (event) => received.push(event))
    signaling.notify('control', { from: 'dir', command: { action: 'mute-mic', muted: true } })
    expect(received).toEqual([{ from: 'dir', command: { action: 'mute-mic', muted: true } }])

    await session.control('a', { action: 'cue', text: 'go' })
    expect(signaling.requests.at(-1)).toMatchObject({ method: 'control', params: { target: 'a' } })
  })

  it('leaves when the server closes the session and reports why', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    const errors: string[] = []
    session.on('error', (m) => errors.push(m))
    signaling.notify('closed', { code: 'kicked', message: 'removed' })
    expect(session.current.status).toBe('closed')
    expect(session.current.closedBecause).toBe('kicked')
    expect(errors).toEqual(['removed'])
  })
})

describe('reconnection', () => {
  it('resumes: same identity, transports kept, ICE restarted, no duplicate consumers', async () => {
    signaling.participants = [participant('a')]
    signaling.producers = [producerInfo('pa1', 'a', 'mic', 'audio')]
    await session.start({ room: 'studio', label: 'Me' })
    await session.produce('camera', fakeTrack('video'))
    const [send, recv] = device.transports as [typeof device.transports[0], typeof device.transports[0]]

    signaling.resumeNext = true
    await signaling.dropAndReconnect()

    const snapshot = session.current
    expect(snapshot.status).toBe('joined')
    expect(snapshot.self?.id).toBe('self-1')
    expect(device.transports).toHaveLength(2)
    expect(send.iceRestarts).toBe(1)
    expect(recv.iceRestarts).toBe(1)
    expect(snapshot.tracks).toHaveLength(1)
    expect(snapshot.producers.map((p) => p.source)).toEqual(['camera'])
    const joins = signaling.requests.filter((r) => r.method === 'join')
    expect(joins).toHaveLength(2)
    expect((joins[1]?.params as { resumeToken?: string }).resumeToken).toBe('token-1')
  })

  it('rebuilds everything when the server forgot the session', async () => {
    signaling.participants = [participant('a')]
    signaling.producers = [producerInfo('pa1', 'a', 'mic', 'audio')]
    await session.start({ room: 'studio', label: 'Me' })
    const camera = fakeTrack('video')
    await session.produce('camera', camera)
    const removed: string[] = []
    session.on('trackRemoved', (t) => removed.push(t.producerId))

    signaling.resumeNext = false
    await signaling.dropAndReconnect()

    expect(session.current.status).toBe('joined')
    // Old transports closed, new pair created.
    expect(device.transports).toHaveLength(4)
    expect(device.transports[0]?.closed).toBe(true)
    expect(device.transports[1]?.closed).toBe(true)
    // Local camera re-published on the new send transport; remote re-consumed once.
    expect(device.transports[2]?.producers.map((p) => p.track)).toEqual([camera])
    expect(session.current.tracks).toHaveLength(1)
    expect(removed).toEqual(['pa1'])
  })

  it('restarts ICE when a transport fails', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await session.produce('mic', fakeTrack('audio'))
    const send = device.transports[0]!
    send.fail()
    await flush()
    expect(send.iceRestarts).toBe(1)
    expect(signaling.requests.some((r) => r.method === 'restartIce')).toBe(true)
  })

  it('checkHealth restarts only disconnected transports', async () => {
    await session.start({ room: 'studio', label: 'Me' })
    await session.produce('mic', fakeTrack('audio'))
    const [send, recv] = device.transports
    send!.connectionState = 'disconnected'
    await session.checkHealth()
    expect(send!.iceRestarts).toBe(1)
    expect(recv!.iceRestarts).toBe(0)
  })
})

describe('queries and knobs', () => {
  it('exposes transport and consumer stats, layer knobs and room keys', async () => {
    signaling.participants = [participant('a')]
    signaling.producers = [producerInfo('pa1', 'a', 'camera', 'video')]
    await session.start({ room: 'studio', label: 'Me' })
    await session.produce('camera', fakeTrack('video'))

    const stats = await session.getStats()
    expect(stats.send).not.toBeNull()
    expect(stats.recv).not.toBeNull()
    const perConsumer = await session.getConsumerStats()
    expect([...perConsumer.keys()]).toEqual(['a'])

    await session.setPreferredSpatialLayer(0)
    expect(signaling.requests.at(-1)).toMatchObject({ method: 'setConsumerLayers', params: { spatialLayer: 0 } })
    await session.setMaxSpatialLayer('camera', 1)
    expect(device.transports[0]?.producers[0]?.maxSpatialLayer).toBe(1)
    await session.setMaxSpatialLayer('mic', 0) // no such producer: a no-op

    await expect(session.getRoomKeys()).resolves.toEqual({ directorKey: 'dk', producerKey: 'pk' })
    await session.updateState({ micMuted: true })
    expect(signaling.requests.at(-1)).toMatchObject({ method: 'updateState', params: { micMuted: true } })
    session.reconnectNow()
  })

  it('reports support from the globals it needs', () => {
    expect(MediaSession.isSupported()).toBe(typeof RTCPeerConnection !== 'undefined' && typeof WebSocket !== 'undefined')
  })

  it('refuses control and keys before a session exists', async () => {
    await expect(session.control('a', { action: 'kick' })).rejects.toMatchObject({ code: 'not-joined' })
    await expect(session.getRoomKeys()).rejects.toMatchObject({ code: 'not-joined' })
    await session.updateState({ sharing: true }) // not joined: silently ignored
    expect(signaling.requests).toEqual([])
  })
})

describe('leave', () => {
  it('closes everything once and reports removed tracks', async () => {
    signaling.participants = [participant('a')]
    signaling.producers = [producerInfo('pa1', 'a', 'mic', 'audio')]
    await session.start({ room: 'studio', label: 'Me' })
    const removed = vi.fn()
    session.on('trackRemoved', removed)
    session.leave()
    session.leave()
    expect(session.current.status).toBe('closed')
    expect(signaling.requests.at(-1)?.method).toBe('leave')
    expect(device.transports.every((t) => t.closed)).toBe(true)
    expect(removed).toHaveBeenCalledTimes(1)
    expect(signaling.state).toBe('closed')
  })
})
