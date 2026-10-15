import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NotificationData, NotificationEvent } from '../../../shared/protocol'
import {
  FAKE_DTLS_PARAMETERS,
  INCOMPATIBLE_RTP_CAPABILITIES,
  audioRtpParameters,
  createTestPool,
  quietLog,
  videoRtpParameters,
} from '../test/fixtures'
import { Peer } from './peer'
import { Room, RoomError } from './room'
import type { WorkerPool } from './worker-pool'
import type { MediasoupConfig } from './config'

type Received = { event: NotificationEvent; data: unknown }

function makePeer(id: string, role: Peer['role'] = 'guest'): { peer: Peer; received: Received[] } {
  const received: Received[] = []
  const peer = new Peer({
    id,
    role,
    label: id,
    resumeToken: `token-${id}`,
    send: <E extends NotificationEvent>(event: E, data: NotificationData<E>) => {
      received.push({ event, data })
    },
  })
  return { peer, received }
}

let pool: WorkerPool
let config: MediasoupConfig

beforeAll(async () => {
  ;({ pool, config } = await createTestPool())
})
afterAll(async () => {
  await pool.close()
})

async function makeRoom(maxPeers = 12): Promise<Room> {
  return Room.create(pool, { name: 'test', config, maxPeers, log: quietLog })
}

describe('Room', () => {
  it('creates a router with the configured codecs', async () => {
    const room = await makeRoom()
    const mimeTypes = room.rtpCapabilities.codecs?.map((codec) => codec.mimeType)
    expect(mimeTypes).toContain('audio/opus')
    expect(mimeTypes).toContain('video/VP8')
    room.close('room-closed')
    expect(room.isClosed).toBe(true)
  })

  it('announces joins and leaves to everyone else', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    const b = makePeer('b')
    room.addPeer(a.peer)
    room.addPeer(b.peer)
    expect(a.received.map((r) => r.event)).toEqual(['participantJoined'])
    expect(b.received).toEqual([])
    room.removePeer('a')
    expect(b.received.map((r) => r.event)).toEqual(['participantLeft'])
    expect(a.peer.isClosed).toBe(true)
    expect(room.isEmpty).toBe(false)
    room.close('room-closed')
  })

  it('refuses a peer beyond the limit', async () => {
    const room = await makeRoom(2)
    room.addPeer(makePeer('a').peer)
    room.addPeer(makePeer('b').peer)
    expect(() => room.addPeer(makePeer('c').peer)).toThrow(RoomError)
    expect(room.peers.size).toBe(2)
    room.close('room-closed')
  })

  it('creates, connects and restarts transports per peer', async () => {
    const room = await makeRoom()
    const { peer } = makePeer('a')
    room.addPeer(peer)
    const send = await room.createTransport(peer, 'send')
    const recv = await room.createTransport(peer, 'recv')
    expect(send.id).not.toBe(recv.id)
    expect(send.iceCandidates.length).toBeGreaterThan(0)
    expect(peer.transports.size).toBe(2)

    const restarted = await room.restartIce(peer, send.id)
    expect(restarted.usernameFragment).not.toBe(send.iceParameters.usernameFragment)

    await room.connectTransport(peer, send.id, FAKE_DTLS_PARAMETERS)
    await expect(room.connectTransport(peer, 'missing', FAKE_DTLS_PARAMETERS)).rejects.toMatchObject({
      code: 'unknown-transport',
    })
    const other = makePeer('b').peer
    room.addPeer(other)
    // A peer cannot touch another peer's transport by id.
    await expect(room.restartIce(other, send.id)).rejects.toMatchObject({ code: 'unknown-transport' })
    room.close('room-closed')
  })

  it('produces, announces, and replaces a producer of the same source', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    const b = makePeer('b')
    room.addPeer(a.peer)
    room.addPeer(b.peer)
    const transport = await room.createTransport(a.peer, 'send')
    const first = await room.produce(a.peer, {
      transportId: transport.id,
      kind: 'audio',
      rtpParameters: audioRtpParameters(1001),
      source: 'mic',
    })
    expect(b.received.at(-1)).toMatchObject({
      event: 'newProducer',
      data: { producer: { id: first, participantId: 'a', kind: 'audio', source: 'mic' } },
    })
    const second = await room.produce(a.peer, {
      transportId: transport.id,
      kind: 'audio',
      rtpParameters: audioRtpParameters(1002),
      source: 'mic',
    })
    expect(a.peer.producers.size).toBe(1)
    expect(a.peer.producers.has(second)).toBe(true)
    expect(b.received.some((r) => r.event === 'producerClosed' && (r.data as { producerId: string }).producerId === first)).toBe(true)

    const recv = await room.createTransport(a.peer, 'recv')
    await expect(
      room.produce(a.peer, { transportId: recv.id, kind: 'audio', rtpParameters: audioRtpParameters(1), source: 'mic' }),
    ).rejects.toMatchObject({ code: 'media-error' })
    room.close('room-closed')
  })

  it('consumes idempotently and tears down with the producer', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    const b = makePeer('b')
    room.addPeer(a.peer)
    room.addPeer(b.peer)
    const sendA = await room.createTransport(a.peer, 'send')
    const producerId = await room.produce(a.peer, {
      transportId: sendA.id,
      kind: 'video',
      rtpParameters: videoRtpParameters(2001),
      source: 'camera',
    })

    await expect(
      room.consume(b.peer, { producerId, rtpCapabilities: room.rtpCapabilities as never }),
    ).rejects.toMatchObject({ code: 'unknown-transport' })
    await room.createTransport(b.peer, 'recv')

    const consumed = await room.consume(b.peer, { producerId, rtpCapabilities: room.rtpCapabilities as never })
    expect(consumed).toMatchObject({ producerId, participantId: 'a', kind: 'video', source: 'camera', producerPaused: false })
    const again = await room.consume(b.peer, { producerId, rtpCapabilities: room.rtpCapabilities as never })
    expect(again.consumerId).toBe(consumed.consumerId)
    expect(b.peer.consumers.size).toBe(1)

    await room.resumeConsumer(b.peer, consumed.consumerId)
    await room.pauseProducer(a.peer, producerId)
    await vi.waitFor(() => {
      expect(b.received.some((r) => r.event === 'consumerPaused')).toBe(true)
    })
    await room.resumeProducer(a.peer, producerId)
    await vi.waitFor(() => {
      expect(b.received.some((r) => r.event === 'consumerResumed')).toBe(true)
    })

    await expect(
      room.consume(b.peer, { producerId, rtpCapabilities: INCOMPATIBLE_RTP_CAPABILITIES as never }),
    ).resolves.toBeDefined() // the existing consumer is returned; no capability check
    await expect(
      room.consume(b.peer, { producerId: 'nope', rtpCapabilities: room.rtpCapabilities as never }),
    ).rejects.toMatchObject({ code: 'unknown-producer' })

    room.closeProducer(a.peer, producerId)
    await vi.waitFor(() => {
      expect(b.received.some((r) => r.event === 'consumerClosed')).toBe(true)
      expect(b.peer.consumers.size).toBe(0)
    })
    room.close('room-closed')
  })

  it('never lets a participant consume its own media (mix-minus)', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    room.addPeer(a.peer)
    const sendA = await room.createTransport(a.peer, 'send')
    await room.createTransport(a.peer, 'recv')
    const producerId = await room.produce(a.peer, {
      transportId: sendA.id,
      kind: 'audio',
      rtpParameters: audioRtpParameters(3501),
      source: 'mic',
    })
    await expect(
      room.consume(a.peer, { producerId, rtpCapabilities: room.rtpCapabilities as never }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(a.peer.consumers.size).toBe(0)
    room.close('room-closed')
  })

  it('requests keyframes for the live video consumers on one transport only', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    const b = makePeer('b')
    room.addPeer(a.peer)
    room.addPeer(b.peer)
    const sendA = await room.createTransport(a.peer, 'send')
    const video = await room.produce(a.peer, { transportId: sendA.id, kind: 'video', rtpParameters: videoRtpParameters(3601), source: 'camera' })
    const audio = await room.produce(a.peer, { transportId: sendA.id, kind: 'audio', rtpParameters: audioRtpParameters(3602), source: 'mic' })
    const recvB = await room.createTransport(b.peer, 'recv')
    const v = await room.consume(b.peer, { producerId: video, rtpCapabilities: room.rtpCapabilities as never })
    await room.consume(b.peer, { producerId: audio, rtpCapabilities: room.rtpCapabilities as never })
    // Paused consumers are skipped; the server creates them paused.
    expect(await room.requestKeyFrames(b.peer, recvB.id)).toBe(0)
    await room.resumeConsumer(b.peer, v.consumerId)
    expect(await room.requestKeyFrames(b.peer, recvB.id)).toBe(1)
    expect(await room.requestKeyFrames(b.peer, 'other-transport')).toBe(0)
    room.close('room-closed')
  })

  it('refuses a consumer the browser cannot decode', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    const b = makePeer('b')
    room.addPeer(a.peer)
    room.addPeer(b.peer)
    const sendA = await room.createTransport(a.peer, 'send')
    const producerId = await room.produce(a.peer, {
      transportId: sendA.id,
      kind: 'video',
      rtpParameters: videoRtpParameters(3001),
      source: 'camera',
    })
    await room.createTransport(b.peer, 'recv')
    await expect(
      room.consume(b.peer, { producerId, rtpCapabilities: INCOMPATIBLE_RTP_CAPABILITIES as never }),
    ).rejects.toMatchObject({ code: 'media-error' })
    room.close('room-closed')
  })

  it('closes every consumer of a departing peer and reports the departure', async () => {
    const room = await makeRoom()
    const a = makePeer('a')
    const b = makePeer('b')
    room.addPeer(a.peer)
    room.addPeer(b.peer)
    const sendA = await room.createTransport(a.peer, 'send')
    const producerId = await room.produce(a.peer, {
      transportId: sendA.id,
      kind: 'audio',
      rtpParameters: audioRtpParameters(4001),
      source: 'mic',
    })
    await room.createTransport(b.peer, 'recv')
    await room.consume(b.peer, { producerId, rtpCapabilities: room.rtpCapabilities as never })
    room.removePeer('a')
    await vi.waitFor(() => {
      expect(b.peer.consumers.size).toBe(0)
      expect(b.received.some((r) => r.event === 'participantLeft')).toBe(true)
    })
    expect(room.producers()).toEqual([])
    room.close('room-closed')
  })
})
