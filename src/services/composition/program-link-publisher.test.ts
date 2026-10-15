import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeStream } from '@/test/setup'
import {
  PROGRAM_TARGET,
  ProgramLinkPublisher,
  programChannelName,
  supportsProgramLink,
  type ProgramLinkMessage,
} from './program-link'

/**
 * The loopback mirror: the publisher side. jsdom has neither RTCPeerConnection
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

describe('programChannelName / supportsProgramLink', () => {
  it('scopes the channel to the room', () => {
    expect(programChannelName('abc')).toBe('livedeck:program:abc')
  })

  it('needs both BroadcastChannel and RTCPeerConnection', () => {
    expect(supportsProgramLink()).toBe(true)
    vi.stubGlobal('RTCPeerConnection', undefined)
    expect(supportsProgramLink()).toBe(false)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('BroadcastChannel', undefined)
    expect(supportsProgramLink()).toBe(false)
  })
})

describe('ProgramLinkPublisher', () => {
  const program = createFakeStream(['video', 'audio'])
  const resolver = vi.fn((target: string) => (target === PROGRAM_TARGET ? program : null))
  let publisher: ProgramLinkPublisher

  beforeEach(() => {
    resolver.mockClear()
    publisher = new ProgramLinkPublisher(ROOM, resolver)
  })
  afterEach(() => publisher.stop())

  it('announces itself once, and does nothing where the mirror is unsupported', async () => {
    publisher.start()
    publisher.start()
    await flush()
    expect(sent('publisher-online')).toHaveLength(1)

    publisher.stop()
    vi.stubGlobal('RTCPeerConnection', undefined)
    const unsupported = new ProgramLinkPublisher('other', resolver)
    unsupported.start()
    expect([...FakeBroadcastChannel.open].map((channel) => channel.name)).toEqual([tap.name])
  })

  it('offers a loopback connection carrying the resolved program tracks', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })

    expect(resolver).toHaveBeenCalledWith(PROGRAM_TARGET)
    const [pc] = pcs()
    expect(pc!.config).toEqual({ iceServers: [] })
    expect(pc!.transceivers.map((entry) => entry.sender.track)).toEqual(program.getTracks())
    expect(pc!.local).toEqual({ type: 'offer', sdp: 'offer-0' })
    expect(sent('offer')).toEqual([{ type: 'offer', to: 'scene-a', sdp: 'offer-0' }])
  })

  it('declares empty send-only m-lines when the target has no stream yet', async () => {
    publisher.start()
    // An older subscriber that omits the target is treated as asking for the program.
    await inject({ type: 'hello', from: 'solo-1', target: 'cam-1' })
    await inject({ type: 'hello', from: 'legacy' } as unknown as ProgramLinkMessage)

    expect(pcs()[0]!.transceivers.map(({ kind, direction, sender }) => [kind, direction, sender.track])).toEqual([
      ['video', 'sendonly', null],
      ['audio', 'sendonly', null],
    ])
    expect(resolver).toHaveBeenLastCalledWith(PROGRAM_TARGET)
    expect(sent('offer').map((offer) => offer.to)).toEqual(['solo-1', 'legacy'])
  })

  it('attaches a source that goes live later with replaceTrack, without renegotiating', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'solo-1', target: 'cam-1' })
    const camera = createFakeStream(['video', 'audio'])
    publisher.refresh((target) => (target === 'cam-1' ? camera : null))
    await flush()

    const pc = pcs()[0]!
    expect(pc.transceivers.map((entry) => entry.sender.track)).toEqual(camera.getTracks())
    expect(sent('offer')).toHaveLength(1)

    // Unchanged tracks are left alone on the next refresh.
    publisher.refresh()
    expect(pc.replaced).toHaveLength(2)
  })

  it('swallows a rejected replaceTrack', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'solo-1', target: 'cam-1' })
    FakePeerConnection.fail.add('replaceTrack')
    publisher.refresh(() => program)
    await flush()
    expect(pcs()[0]!.replaced).toHaveLength(2)
    expect(pcs()[0]!.transceivers.every((entry) => entry.sender.track === null)).toBe(true)
  })

  it('applies the answer and relays ICE in both directions', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    const pc = pcs()[0]!

    await inject({ type: 'answer', from: 'scene-a', sdp: 'answer-x' })
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'answer-x' })

    await inject({ type: 'candidate', from: 'scene-a', to: 'publisher', candidate: { candidate: 'c1' } })
    expect(pc.candidates).toEqual([{ candidate: 'c1' }])

    pc.emitCandidate({ candidate: 'p1', sdpMid: '0' })
    pc.emitCandidate(null)
    await flush()
    expect(sent('candidate')).toEqual([
      { type: 'candidate', from: 'publisher', to: 'scene-a', candidate: { candidate: 'p1', sdpMid: '0' } },
    ])
  })

  it('ignores answers and candidates from unknown subscribers, and a lost candidate', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    const pc = pcs()[0]!
    await inject({ type: 'answer', from: 'stranger', sdp: 'x' })
    await inject({ type: 'candidate', from: 'stranger', to: 'publisher', candidate: { candidate: 'c' } })
    await inject({ type: 'offer', to: 'publisher', sdp: 'confused' })
    FakePeerConnection.fail.add('addIceCandidate')
    await inject({ type: 'candidate', from: 'scene-a', to: 'publisher', candidate: { candidate: 'bad' } })
    expect(pc.remote).toBeNull()
    expect(pc.candidates).toEqual([])
    expect(pc.closed).toBe(false)
  })

  it('drops a subscriber whose answer cannot be applied', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    FakePeerConnection.fail.add('setRemoteDescription')
    FakePeerConnection.fail.add('close')
    await inject({ type: 'answer', from: 'scene-a', sdp: 'stale' })
    const pc = pcs()[0]!
    expect(pc.closed).toBe(true)
    expect(pc.onicecandidate).toBeNull()

    FakePeerConnection.fail.clear()
    await inject({ type: 'candidate', from: 'scene-a', to: 'publisher', candidate: { candidate: 'late' } })
    expect(pc.candidates).toEqual([])
  })

  it('replaces the connection when a subscriber restarts and says hello again', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    const [first, second] = pcs()
    expect(first!.closed).toBe(true)
    expect(second!.closed).toBe(false)
    expect(sent('offer').map((offer) => offer.sdp)).toEqual(['offer-0', 'offer-1'])
  })

  it('forgets a peer whose connection fails or closes, but not one that is merely connecting', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    await inject({ type: 'hello', from: 'scene-b', target: PROGRAM_TARGET })
    const [a, b] = pcs()
    a!.setState('connecting')
    expect(a!.closed).toBe(false)
    a!.setState('failed')
    b!.setState('closed')
    expect(a!.closed && b!.closed).toBe(true)

    const before = [a!.replaced.length, b!.replaced.length]
    publisher.refresh(() => createFakeStream(['video', 'audio']))
    expect([a!.replaced.length, b!.replaced.length]).toEqual(before)
  })

  it('keeps video and audio in fixed slots when the first stream is audio-only', async () => {
    let stream = createFakeStream(['audio'])
    publisher.stop()
    publisher = new ProgramLinkPublisher(ROOM, () => stream)
    publisher.start()
    await inject({ type: 'hello', from: 'solo', target: PROGRAM_TARGET })
    const [pc] = pcs()
    const audio = stream.getAudioTracks()[0]
    expect(pc!.transceivers.map((entry) => [entry.kind, entry.direction])).toEqual([
      ['video', 'sendonly'],
      ['audio', 'sendonly'],
    ])
    expect(pc!.transceivers[1]!.sender.track).toBe(audio)
    expect(pc!.transceivers[0]!.sender.track).toBeNull()

    // A refresh with the same stream must not detach the audio.
    publisher.refresh()
    await flush()
    expect(pc!.transceivers[1]!.sender.track).toBe(audio)

    // A later stream with video fills the video slot, audio stays audio.
    stream = createFakeStream(['video', 'audio'])
    publisher.refresh()
    await flush()
    expect(pc!.transceivers[0]!.sender.track).toBe(stream.getVideoTracks()[0])
    expect(pc!.transceivers[1]!.sender.track).toBe(stream.getAudioTracks()[0])
  })

  it('delivers audio that appears after a video-only offer without renegotiating', async () => {
    let stream = createFakeStream(['video'])
    publisher.stop()
    publisher = new ProgramLinkPublisher(ROOM, () => stream)
    publisher.start()
    await inject({ type: 'hello', from: 'solo', target: PROGRAM_TARGET })
    const [pc] = pcs()
    // Both m-lines must be in the offer itself; this link never renegotiates.
    expect(pc!.transceivers.map((entry) => entry.kind)).toEqual(['video', 'audio'])
    const offers = sent('offer').length
    stream = createFakeStream(['video', 'audio'])
    publisher.refresh()
    await flush()
    expect(pc!.transceivers).toHaveLength(2)
    expect(pc!.transceivers[1]!.sender.track).toBe(stream.getAudioTracks()[0])
    expect(sent('offer')).toHaveLength(offers)
  })

  it('closes the peer and sends no offer when the offer cannot be created', async () => {
    FakePeerConnection.fail.add('createOffer')
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    expect(pcs()[0]!.closed).toBe(true)
    expect(sent('offer')).toEqual([])
  })

  it('says bye, closes every peer and stops listening on stop', async () => {
    publisher.start()
    await inject({ type: 'hello', from: 'scene-a', target: PROGRAM_TARGET })
    publisher.stop()
    await flush()
    expect(sent('bye')).toHaveLength(1)
    expect(pcs()[0]!.closed).toBe(true)

    await inject({ type: 'hello', from: 'scene-b', target: PROGRAM_TARGET })
    expect(pcs()).toHaveLength(1)
  })

  it('survives a channel that throws on send', async () => {
    publisher.start()
    FakeBroadcastChannel.failPost = true
    expect(() => publisher.stop()).not.toThrow()
  })
})

