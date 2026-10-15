import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeStream, FakeMediaStreamTrack } from '@/test/setup'
import {
  PROGRAM_TARGET,
  ProgramLinkPublisher,
  ProgramLinkSubscriber,
  programChannelName,
  type ProgramLinkMessage,
  type ProgramLinkState,
} from './program-link'

/**
 * The loopback mirror: the subscriber side, and both ends together. jsdom has neither RTCPeerConnection
 * nor a cross-context BroadcastChannel, so both are faked: the channel is an
 * in-memory bus that delivers asynchronously to every *other* open channel of
 * the same name, and the peer connection records what was asked of it.
 *
 * The fakes are repeated in the sibling program-link test file on purpose:
 * only test files may be added, and importing one test file from another
 * would run its suites twice.
 */

class FakeBroadcastChannel {
  static readonly open = new Set<FakeBroadcastChannel>()
  static failPost = false
  readonly name: string
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(name: string) {
    this.name = name
    FakeBroadcastChannel.open.add(this)
  }
  postMessage(data: unknown): void {
    if (FakeBroadcastChannel.failPost) throw new DOMException('closed', 'InvalidStateError')
    for (const peer of FakeBroadcastChannel.open) {
      if (peer === this || peer.name !== this.name) continue
      void Promise.resolve().then(() => {
        if (FakeBroadcastChannel.open.has(peer)) peer.onmessage?.(new MessageEvent('message', { data }))
      })
    }
  }
  close(): void {
    FakeBroadcastChannel.open.delete(this)
  }
}

type FakeSender = { track: MediaStreamTrack | null; replaceTrack: (track: MediaStreamTrack | null) => Promise<void> }
type Failure = 'createOffer' | 'createAnswer' | 'setRemoteDescription' | 'addIceCandidate' | 'addTrack' | 'close' | 'replaceTrack'
type IceEvent = { candidate: { toJSON(): RTCIceCandidateInit } | null }
type TrackEvent = { track: MediaStreamTrack; streams: MediaStream[] }

class FakePeerConnection {
  static readonly instances: FakePeerConnection[] = []
  static readonly fail = new Set<Failure>()
  readonly config: RTCConfiguration
  readonly transceivers: Array<{ kind: string; direction: string; sender: FakeSender }> = []
  readonly candidates: RTCIceCandidateInit[] = []
  readonly replaced: Array<MediaStreamTrack | null> = []
  remote: RTCSessionDescriptionInit | null = null
  local: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  closed = false
  onicecandidate: ((event: IceEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((event: TrackEvent) => void) | null = null
  private readonly serial = FakePeerConnection.instances.length

  constructor(config: RTCConfiguration) {
    this.config = config
    FakePeerConnection.instances.push(this)
  }
  private sender(track: MediaStreamTrack | null): FakeSender {
    const sender: FakeSender = {
      track,
      replaceTrack: (next) => {
        this.replaced.push(next)
        if (FakePeerConnection.fail.has('replaceTrack')) return Promise.reject(new Error('replace'))
        sender.track = next
        return Promise.resolve()
      },
    }
    return sender
  }
  private async step(name: Failure): Promise<void> {
    if (FakePeerConnection.fail.has(name)) throw new Error(name)
  }
  getTransceivers() {
    return [...this.transceivers]
  }
  addTransceiver(kind: string, init: RTCRtpTransceiverInit): void {
    this.transceivers.push({ kind, direction: init.direction ?? 'sendrecv', sender: this.sender(null) })
  }
  addTrack(track: MediaStreamTrack): void {
    if (FakePeerConnection.fail.has('addTrack')) throw new DOMException('closed', 'InvalidStateError')
    this.transceivers.push({ kind: track.kind, direction: 'sendrecv', sender: this.sender(track) })
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    await this.step('createOffer')
    return { type: 'offer', sdp: `offer-${this.serial}` }
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    await this.step('createAnswer')
    return { type: 'answer', sdp: `answer-${this.serial}` }
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.local = description
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.step('setRemoteDescription')
    this.remote = description
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.step('addIceCandidate')
    this.candidates.push(candidate)
  }
  close(): void {
    this.closed = true
    if (FakePeerConnection.fail.has('close')) throw new DOMException('closed', 'InvalidStateError')
  }
  emitCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({ candidate: candidate ? { toJSON: () => candidate } : null })
  }
  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

const ROOM = 'studio'
let log: ProgramLinkMessage[]
let tap: FakeBroadcastChannel

/** Let the bus and every awaited fake settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
}
function sent<T extends ProgramLinkMessage['type']>(type: T): Array<Extract<ProgramLinkMessage, { type: T }>> {
  return log.filter((message): message is Extract<ProgramLinkMessage, { type: T }> => message.type === type)
}
async function inject(message: ProgramLinkMessage): Promise<void> {
  tap.postMessage(message)
  await flush()
}
const pcs = () => FakePeerConnection.instances

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  log = []
  tap = new FakeBroadcastChannel(programChannelName(ROOM))
  tap.onmessage = (event) => log.push(event.data as ProgramLinkMessage)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeBroadcastChannel.open.clear()
  FakeBroadcastChannel.failPost = false
  FakePeerConnection.instances.length = 0
  FakePeerConnection.fail.clear()
})

describe('ProgramLinkSubscriber', () => {
  const onStream = vi.fn<(stream: MediaStream | null) => void>()
  const onState = vi.fn<(state: ProgramLinkState) => void>()
  let subscriber: ProgramLinkSubscriber

  beforeEach(() => {
    onStream.mockClear()
    onState.mockClear()
    subscriber = new ProgramLinkSubscriber(ROOM, { onStream, onState }, 'cam-1')
  })
  afterEach(() => subscriber.stop())

  async function startAndGetId(): Promise<string> {
    subscriber.start()
    await flush()
    return sent('hello')[0]!.from
  }

  it('reports unsupported without opening a channel', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    subscriber.start()
    expect(onState).toHaveBeenCalledWith('unsupported')
  })

  it('says hello for its target, and repeats it every 1.5s until offered', async () => {
    vi.useFakeTimers()
    const id = await startAndGetId()
    subscriber.start()
    expect(id).toMatch(/^scene-/)
    expect(sent('hello')).toEqual([{ type: 'hello', from: id, target: 'cam-1' }])
    // Starting in 'waiting' is not a state change.
    expect(onState).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(sent('hello')).toHaveLength(3)

    await inject({ type: 'offer', to: id, sdp: 'offer-p' })
    log.length = 0
    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(sent('hello')).toEqual([])

    subscriber.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defaults to the program target', async () => {
    subscriber = new ProgramLinkSubscriber(ROOM, { onStream, onState })
    await startAndGetId()
    expect(sent('hello')[0]!.target).toBe(PROGRAM_TARGET)
  })

  it('answers an offer addressed to it and ignores ones for others', async () => {
    const id = await startAndGetId()
    await inject({ type: 'offer', to: 'someone-else', sdp: 'x' })
    // Traffic meant for the publisher, such as another window's hello, is not ours.
    await inject({ type: 'hello', from: 'scene-other', target: PROGRAM_TARGET })
    await inject({ type: 'answer', from: 'scene-other', sdp: 'y' })
    expect(pcs()).toHaveLength(0)
    expect(onState).not.toHaveBeenCalled()

    await inject({ type: 'offer', to: id, sdp: 'offer-p' })
    const pc = pcs()[0]!
    expect(pc.config).toEqual({ iceServers: [] })
    expect(pc.remote).toEqual({ type: 'offer', sdp: 'offer-p' })
    expect(sent('answer')).toEqual([{ type: 'answer', from: id, sdp: 'answer-0' }])
    expect(onState).toHaveBeenLastCalledWith('connecting')

    pc.setState('connected')
    expect(onState).toHaveBeenLastCalledWith('live')
  })

  it('re-asks on publisher-online only while waiting or ended', async () => {
    const id = await startAndGetId()
    log.length = 0
    await inject({ type: 'publisher-online' })
    expect(sent('hello')).toHaveLength(1)

    await inject({ type: 'offer', to: id, sdp: 'o' })
    log.length = 0
    await inject({ type: 'publisher-online' })
    expect(sent('hello')).toEqual([])

    await inject({ type: 'bye' })
    await inject({ type: 'publisher-online' })
    expect(sent('hello')).toHaveLength(1)
  })

  it('relays ICE both ways and tolerates a bad candidate', async () => {
    const id = await startAndGetId()
    await inject({ type: 'candidate', from: 'publisher', to: id, candidate: { candidate: 'early' } })
    await inject({ type: 'offer', to: id, sdp: 'o' })
    const pc = pcs()[0]!

    await inject({ type: 'candidate', from: 'publisher', to: 'other', candidate: { candidate: 'x' } })
    await inject({ type: 'candidate', from: 'publisher', to: id, candidate: { candidate: 'c1' } })
    FakePeerConnection.fail.add('addIceCandidate')
    await inject({ type: 'candidate', from: 'publisher', to: id, candidate: { candidate: 'c2' } })
    expect(pc.candidates).toEqual([{ candidate: 'c1' }])

    pc.emitCandidate({ candidate: 's1' })
    pc.emitCandidate(null)
    await flush()
    expect(sent('candidate')).toEqual([{ type: 'candidate', from: id, to: 'publisher', candidate: { candidate: 's1' } }])
  })

  it('surfaces a track only while it is unmuted, and clears it when it ends', async () => {
    const id = await startAndGetId()
    await inject({ type: 'offer', to: id, sdp: 'o' })
    const pc = pcs()[0]!
    const track = new FakeMediaStreamTrack('video')
    track.muted = true
    const stream = createFakeStream([])
    pc.ontrack?.({ track: track as unknown as MediaStreamTrack, streams: [stream] })
    expect(onStream).toHaveBeenLastCalledWith(null)

    track.muted = false
    track.dispatchEvent(new Event('unmute'))
    expect(onStream).toHaveBeenLastCalledWith(stream)
    track.muted = true
    track.dispatchEvent(new Event('mute'))
    expect(onStream).toHaveBeenLastCalledWith(null)
    track.muted = false
    track.dispatchEvent(new Event('unmute'))
    track.dispatchEvent(new Event('ended'))
    expect(onStream).toHaveBeenLastCalledWith(null)
  })

  it('wraps a track that arrives without a stream', async () => {
    const id = await startAndGetId()
    await inject({ type: 'offer', to: id, sdp: 'o' })
    const track = new FakeMediaStreamTrack('video')
    pcs()[0]!.ontrack?.({ track: track as unknown as MediaStreamTrack, streams: [] })
    const surfaced = onStream.mock.lastCall?.[0]
    expect(surfaced?.getTracks()).toEqual([track])
  })

  it('goes back to waiting when the connection fails or the handshake throws', async () => {
    const id = await startAndGetId()
    await inject({ type: 'offer', to: id, sdp: 'o' })
    pcs()[0]!.setState('failed')
    expect(onStream).toHaveBeenLastCalledWith(null)
    expect(onState).toHaveBeenLastCalledWith('waiting')

    FakePeerConnection.fail.add('createAnswer')
    FakePeerConnection.fail.add('close')
    await inject({ type: 'offer', to: id, sdp: 'o2' })
    expect(pcs()[1]!.closed).toBe(true)
    expect(onState.mock.calls.map(([state]) => state)).toEqual(['connecting', 'waiting', 'connecting', 'waiting'])
    expect(sent('answer')).toHaveLength(1)
  })

  it('reports the end of the program on bye and reconnects to a new offer', async () => {
    const id = await startAndGetId()
    await inject({ type: 'offer', to: id, sdp: 'o' })
    const first = pcs()[0]!
    await inject({ type: 'bye' })
    expect(first.closed).toBe(true)
    expect(first.ontrack).toBeNull()
    expect(onStream).toHaveBeenLastCalledWith(null)
    expect(onState).toHaveBeenLastCalledWith('ended')

    await inject({ type: 'offer', to: id, sdp: 'again' })
    await inject({ type: 'offer', to: id, sdp: 'and again' })
    expect(pcs()[1]!.closed).toBe(true)
    expect(pcs()[2]!.remote?.sdp).toBe('and again')
  })

  it('closes its peer and channel on stop', async () => {
    const id = await startAndGetId()
    await inject({ type: 'offer', to: id, sdp: 'o' })
    FakeBroadcastChannel.failPost = true
    pcs()[0]!.emitCandidate({ candidate: 'swallowed' })
    FakeBroadcastChannel.failPost = false
    subscriber.stop()
    subscriber.stop()
    expect(pcs()[0]!.closed).toBe(true)
    await inject({ type: 'offer', to: id, sdp: 'after stop' })
    expect(pcs()).toHaveLength(1)
  })
})

describe('publisher and subscriber together', () => {
  it('connects, delivers the track, and recovers across a publisher restart', async () => {
    const program = createFakeStream(['video', 'audio'])
    const onStream = vi.fn<(stream: MediaStream | null) => void>()
    const onState = vi.fn<(state: ProgramLinkState) => void>()
    const subscriber = new ProgramLinkSubscriber(ROOM, { onStream, onState })
    subscriber.start()
    await flush()
    // Opened before the director: nothing answers yet.
    expect(pcs()).toHaveLength(0)

    let publisher = new ProgramLinkPublisher(ROOM, () => program)
    publisher.start()
    await flush()
    const [sending, receiving] = pcs()
    expect(receiving!.remote?.sdp).toBe(sending!.local?.sdp)
    expect(sending!.remote?.sdp).toBe(receiving!.local?.sdp)

    sending!.emitCandidate({ candidate: 'pub' })
    receiving!.emitCandidate({ candidate: 'sub' })
    await flush()
    expect(receiving!.candidates).toEqual([{ candidate: 'pub' }])
    expect(sending!.candidates).toEqual([{ candidate: 'sub' }])

    const videoTrack = sending!.transceivers[0]!.sender.track!
    receiving!.ontrack?.({ track: videoTrack, streams: [program] })
    receiving!.setState('connected')
    expect(onStream).toHaveBeenLastCalledWith(program)
    expect(onState).toHaveBeenLastCalledWith('live')

    publisher.stop()
    await flush()
    expect(onState).toHaveBeenLastCalledWith('ended')
    expect(receiving!.closed).toBe(true)

    publisher = new ProgramLinkPublisher(ROOM, () => program)
    publisher.start()
    await flush()
    expect(pcs()).toHaveLength(4)
    expect(onState).toHaveBeenLastCalledWith('connecting')
    expect(pcs()[3]!.remote?.sdp).toBe(pcs()[2]!.local?.sdp)

    publisher.stop()
    subscriber.stop()
  })
})
