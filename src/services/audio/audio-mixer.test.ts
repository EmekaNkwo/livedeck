import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioChannelConfig, AudioContextStatus, AudioLevel } from '@/types/audio'
import { SILENT_LEVEL } from '@/types/audio'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { createFakeStream } from '@/test/setup'
import { AudioMixer } from './audio-mixer'
import { meterBus } from './meter-bus'

/**
 * The mixer's graph, gains and lifecycle, against a recording fake of the Web
 * Audio API (jsdom has none). Metering lives in audio-mixer-metering.test.ts.
 */

class FakeParam {
  value: number
  readonly setTargetAtTime = vi.fn((target: number, _start: number, _constant: number) => {
    this.value = target
    return this
  })
  constructor(value: number) {
    this.value = value
  }
}

class FakeNode {
  outputs: FakeNode[] = []
  disconnected = false
  readonly type: string
  constructor(type: string) {
    this.type = type
  }
  connect(target: FakeNode): FakeNode {
    this.outputs.push(target)
    return target
  }
  disconnect(): void {
    this.disconnected = true
    this.outputs = []
  }
}

const param = (value: number) => new FakeParam(value)
const fakeGain = () => Object.assign(new FakeNode('gain'), { gain: param(1) })
const fakeAnalyser = () =>
  Object.assign(new FakeNode('analyser'), { fftSize: 2048, smoothingTimeConstant: 0.8 })
const fakeCompressor = () =>
  Object.assign(new FakeNode('compressor'), {
    threshold: param(0),
    knee: param(0),
    ratio: param(0),
    attack: param(0),
    release: param(0),
  })
type FakeGain = ReturnType<typeof fakeGain>
type FakeAnalyser = ReturnType<typeof fakeAnalyser>
type FakeCompressor = ReturnType<typeof fakeCompressor>
type FakeStreamDestination = FakeNode & { stream: MediaStream }

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = []
  state: AudioContextState = 'suspended'
  readonly currentTime = 1.5
  readonly sampleRate: number
  readonly destination = new FakeNode('speakers')
  readonly nodes: FakeNode[] = []
  readonly resume = vi.fn(async () => {
    this.state = 'running'
  })
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })

  readonly options: AudioContextOptions
  constructor(options: AudioContextOptions) {
    super()
    this.options = options
    this.sampleRate = options.sampleRate ?? 44_100
    FakeAudioContext.instances.push(this)
  }
  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node)
    return node
  }
  createGain(): FakeGain {
    return this.track(fakeGain())
  }
  createAnalyser(): FakeAnalyser {
    return this.track(fakeAnalyser())
  }
  createDynamicsCompressor(): FakeCompressor {
    return this.track(fakeCompressor())
  }
  createMediaStreamSource(mediaStream: MediaStream) {
    return this.track(Object.assign(new FakeNode('source'), { mediaStream }))
  }
  createMediaStreamDestination(): FakeStreamDestination {
    return this.track(Object.assign(new FakeNode('stream-destination'), { stream: createFakeStream(['audio']) }))
  }
}

function lastContext(): FakeAudioContext {
  const context = FakeAudioContext.instances.at(-1)
  if (!context) throw new Error('no AudioContext was created')
  return context
}

function only<T>(items: T[], predicate: (item: T) => boolean): T {
  const found = items.filter(predicate)
  if (found.length !== 1) throw new Error(`expected exactly one match, found ${found.length}`)
  return found[0] as T
}

/** The program graph, found by walking it from the first gain the mixer built. */
function programGraph(context: FakeAudioContext) {
  const mixBus = context.nodes[0] as FakeGain
  const master = mixBus.outputs[0] as FakeGain
  const compressor = master.outputs[0] as FakeCompressor
  const limiter = compressor.outputs[0] as FakeCompressor
  const analyser = limiter.outputs[0] as FakeAnalyser
  const destination = only(context.nodes, (n) => n.type === 'stream-destination') as FakeStreamDestination
  const monitor = analyser.outputs.find((n) => n !== destination) as FakeGain
  return { mixBus, master, compressor, limiter, analyser, destination, monitor }
}

/** A channel's nodes, found by walking from the source fed by `stream`. */
function channelGraph(context: FakeAudioContext, stream: MediaStream) {
  const source = only(context.nodes, (n) => 'mediaStream' in n && n.mediaStream === stream)
  const input = source.outputs[0] as FakeGain
  const analyser = input.outputs[0] as FakeAnalyser
  const fader = analyser.outputs[0] as FakeGain
  const monitor = fader.outputs[1] as FakeGain
  return { source, input, analyser, fader, monitor }
}

function config(overrides: Partial<AudioChannelConfig> = {}): AudioChannelConfig {
  return {
    id: 'host',
    sourceId: 'host',
    kind: 'host-mic',
    label: 'Host',
    volume: 1,
    gainDb: 0,
    mutedInMix: false,
    monitoring: false,
    ...overrides,
  }
}

let mixer: AudioMixer

beforeEach(() => {
  FakeAudioContext.instances = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  resetCapabilitiesCache()
  mixer = new AudioMixer()
})

afterEach(async () => {
  await mixer.dispose()
  meterBus.clear()
  vi.unstubAllGlobals()
})

describe('AudioMixer program graph', () => {
  it('builds mixBus → master → compressor → limiter → analyser → recorder at 48 kHz', async () => {
    await expect(mixer.initialize()).resolves.toBe('running')
    await mixer.initialize()
    expect(FakeAudioContext.instances).toHaveLength(1)
    const context = lastContext()
    expect(context.options).toEqual({ latencyHint: 'interactive', sampleRate: 48_000 })

    const g = programGraph(context)
    expect(g.mixBus.gain.value).toBe(1)
    expect(g.master.gain.value).toBe(1)
    expect(g.compressor.threshold.value).toBe(-18)
    expect(g.limiter.threshold.value).toBe(-1)
    expect(g.analyser.type).toBe('analyser')
    expect(g.analyser.fftSize).toBe(1024)
    expect(g.analyser.smoothingTimeConstant).toBe(0.6)
    expect(g.analyser.outputs).toEqual([g.destination, g.monitor])
    expect(mixer.getProgramStream()).toBe(g.destination.stream)
    expect(mixer.getContext()).toBe(context)
  })

  it('keeps the program off the speakers until monitoring is enabled', async () => {
    await mixer.initialize()
    const { monitor } = programGraph(lastContext())
    expect(monitor.gain.value).toBe(0)
    expect(monitor.outputs).toEqual([lastContext().destination])

    mixer.setProgramMonitoring(true)
    expect(monitor.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 1.5, 0.02)
    mixer.setProgramMonitoring(false)
    expect(monitor.gain.value).toBe(0)
  })

  it('applies master volume through a ramp and clamps it at 1.5', async () => {
    await mixer.initialize()
    const { master } = programGraph(lastContext())
    mixer.setMasterVolume(0.25)
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.25, 1.5, 0.02)
    mixer.setMasterVolume(9)
    expect(master.gain.value).toBe(1.5)
  })

  it('does nothing before initialization', async () => {
    expect(mixer.getStatus()).toBe('uninitialized')
    expect(mixer.getProgramStream()).toBeNull()
    expect(mixer.addChannel(config(), createFakeStream(['audio']))).toBe(false)
    mixer.setMasterVolume(1)
    mixer.setProgramMonitoring(true)
    mixer.updateChannel(config())
    await mixer.resume()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })
})

describe('AudioMixer channels', () => {
  it('wires source → trim → pre-fader analyser → fader → mix bus, with a silent monitor', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio', 'video'])
    expect(mixer.addChannel(config(), stream)).toBe(true)

    const context = lastContext()
    const c = channelGraph(context, stream)
    const { mixBus } = programGraph(context)
    expect(c.analyser.fftSize).toBe(1024)
    expect(c.analyser.smoothingTimeConstant).toBe(0.5)
    expect(c.fader.outputs).toEqual([mixBus, c.monitor])
    expect(c.monitor.outputs).toEqual([context.destination])
    expect(c.monitor.gain.value).toBe(0)
    expect(c.input.gain.value).toBe(1)
    expect(c.fader.gain.value).toBe(1)
    expect(mixer.hasChannel('host')).toBe(true)
    expect(mixer.channelIds()).toEqual(['host'])
  })

  it('rejects a stream without an audio track and builds nothing', async () => {
    await mixer.initialize()
    const before = lastContext().nodes.length
    expect(mixer.addChannel(config(), createFakeStream(['video']))).toBe(false)
    expect(lastContext().nodes).toHaveLength(before)
    expect(mixer.hasChannel('host')).toBe(false)
  })

  it('applies volume to the fader and dB trim to the input, with a click-free ramp', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(config({ volume: 0.5, gainDb: 6 }), stream)
    const c = channelGraph(lastContext(), stream)

    expect(c.fader.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.5, 1.5, 0.015)
    expect(c.input.gain.value).toBeCloseTo(10 ** (6 / 20), 6)

    mixer.updateChannel(config({ volume: 3, gainDb: -12 }))
    expect(c.fader.gain.value).toBe(1.5)
    expect(c.input.gain.value).toBeCloseTo(10 ** (-12 / 20), 6)
  })

  it('mute silences the fader only; the pre-fader meter tap stays connected', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(config({ volume: 0.8 }), stream)
    const c = channelGraph(lastContext(), stream)

    mixer.updateChannel(config({ volume: 0.8, mutedInMix: true }))
    expect(c.fader.gain.value).toBe(0)
    expect(c.input.gain.value).toBe(1)
    expect(c.input.outputs).toEqual([c.analyser])
    expect(c.analyser.outputs).toEqual([c.fader])

    mixer.updateChannel(config({ volume: 0.8, mutedInMix: false }))
    expect(c.fader.gain.value).toBe(0.8)
  })

  it('routes a channel to the speakers only when monitoring is on', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(config({ monitoring: true }), stream)
    const c = channelGraph(lastContext(), stream)
    expect(c.monitor.gain.value).toBe(1)
    mixer.updateChannel(config({ monitoring: false }))
    expect(c.monitor.gain.value).toBe(0)
  })

  it('keeps channels independent', async () => {
    await mixer.initialize()
    const hostStream = createFakeStream(['audio'])
    const guestStream = createFakeStream(['audio'])
    mixer.addChannel(config(), hostStream)
    mixer.addChannel(config({ id: 'guest', kind: 'guest' }), guestStream)
    mixer.updateChannel(config({ id: 'guest', kind: 'guest', mutedInMix: true }))
    mixer.updateChannel(config({ id: 'nobody', volume: 0 }))

    expect(channelGraph(lastContext(), hostStream).fader.gain.value).toBe(1)
    expect(channelGraph(lastContext(), guestStream).fader.gain.value).toBe(0)
    expect(mixer.channelIds()).toEqual(['host', 'guest'])
  })

  it('removing a channel disconnects every node, settles its meter and leaves the tracks running', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(config(), stream)
    const c = channelGraph(lastContext(), stream)
    meterBus.publish('host', { rms: 0.5, peak: 0.6, db: -6, clipping: false })
    const seen: AudioLevel[] = []
    meterBus.subscribe('host', (level) => seen.push(level))

    mixer.removeChannel('host')

    for (const node of Object.values(c)) expect(node.disconnected).toBe(true)
    expect(seen.at(-1)).toEqual(SILENT_LEVEL)
    expect(mixer.getLevel('host')).toEqual(SILENT_LEVEL)
    expect(mixer.hasChannel('host')).toBe(false)
    expect(stream.getAudioTracks()[0]?.readyState).toBe('live')
    mixer.removeChannel('host')
  })

  it('a node that throws on disconnect does not stop the rest of the teardown', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(config(), stream)
    const c = channelGraph(lastContext(), stream)
    c.source.disconnect = () => {
      throw new Error('already disconnected')
    }
    expect(() => mixer.removeChannel('host')).not.toThrow()
    expect(c.monitor.disconnected).toBe(true)
  })

  it('re-adding an id replaces the old nodes (a device switch)', async () => {
    await mixer.initialize()
    const oldStream = createFakeStream(['audio'])
    const newStream = createFakeStream(['audio'])
    mixer.addChannel(config(), oldStream)
    const old = channelGraph(lastContext(), oldStream)
    mixer.addChannel(config({ volume: 0.3 }), newStream)

    expect(old.source.disconnected).toBe(true)
    expect(old.fader.disconnected).toBe(true)
    const fresh = channelGraph(lastContext(), newStream)
    expect(fresh.source.disconnected).toBe(false)
    expect(fresh.fader.gain.value).toBe(0.3)
    expect(mixer.channelIds()).toEqual(['host'])
  })
})

describe('AudioMixer context state', () => {
  it('reports unavailable when the browser has no Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined)
    resetCapabilitiesCache()
    await expect(mixer.initialize()).resolves.toBe('unavailable')
    expect(mixer.getStatus()).toBe('unavailable')
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('stays suspended, without throwing, when resume is refused outside a gesture', async () => {
    const statuses: AudioContextStatus[] = []
    mixer.onStatusChange((status) => statuses.push(status))
    const pending = mixer.initialize()
    lastContext().resume.mockRejectedValueOnce(new Error('NotAllowedError'))
    await expect(pending).resolves.toBe('suspended')
    expect(statuses).toEqual(['suspended'])
  })

  it('publishes state changes and resumes after an OS interruption', async () => {
    const statuses: AudioContextStatus[] = []
    const unsubscribe = mixer.onStatusChange((status) => statuses.push(status))
    await mixer.initialize()
    const context = lastContext()
    expect(statuses).toEqual(['running'])
    await mixer.resume()
    expect(context.resume).toHaveBeenCalledTimes(1) // already running: no second request

    context.state = 'suspended'
    context.dispatchEvent(new Event('statechange'))
    expect(statuses).toEqual(['running', 'suspended'])
    await vi.waitFor(() => expect(context.state).toBe('running'))
    expect(context.resume).toHaveBeenCalledTimes(2)

    unsubscribe()
    context.dispatchEvent(new Event('statechange'))
    expect(statuses).toHaveLength(2)
  })
})

describe('AudioMixer.dispose', () => {
  it('disconnects the graph, closes the context and reports uninitialized', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(config(), stream)
    const context = lastContext()
    const statuses: AudioContextStatus[] = []
    mixer.onStatusChange((status) => statuses.push(status))

    await mixer.dispose()

    expect(context.close).toHaveBeenCalledTimes(1)
    for (const node of context.nodes) expect(node.disconnected).toBe(true)
    expect(statuses).toEqual(['uninitialized'])
    expect(mixer.getContext()).toBeNull()
    expect(mixer.getProgramStream()).toBeNull()
    expect(mixer.hasChannel('host')).toBe(false)
    expect(stream.getAudioTracks()[0]?.readyState).toBe('live')
  })

  it('swallows a rejected close and can be initialized again afterwards', async () => {
    await mixer.initialize()
    lastContext().close.mockRejectedValueOnce(new Error('already closed'))
    await expect(mixer.dispose()).resolves.toBeUndefined()

    await expect(mixer.initialize()).resolves.toBe('running')
    expect(FakeAudioContext.instances).toHaveLength(2)
  })

  it('is safe before initialization', async () => {
    await expect(mixer.dispose()).resolves.toBeUndefined()
    expect(mixer.getStatus()).toBe('uninitialized')
  })
})
