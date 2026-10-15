import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioChannelConfig } from '@/types/audio'
import { SILENT_LEVEL } from '@/types/audio'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { createFakeStream } from '@/test/setup'
import { AudioMixer } from './audio-mixer'
import { PROGRAM_METER_ID, meterBus } from './meter-bus'
import { METER_PROCESSOR_NAME, type MeterReading } from './meter-worklet'

/**
 * Metering: worklet readings when the context supports AudioWorklet, polled
 * analysers on a 50ms timer when it does not. Graph and gain behaviour are in
 * audio-mixer.test.ts.
 */

class FakeParam {
  value: number
  constructor(value: number) {
    this.value = value
  }
  setTargetAtTime(target: number): this {
    this.value = target
    return this
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

class FakeAnalyser extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  /** Every sample the next read returns; `null` makes the read throw. */
  sample: number | null = 0
  constructor() {
    super('analyser')
  }
  getFloatTimeDomainData(buffer: Float32Array): void {
    if (this.sample === null) throw new Error('detached')
    buffer.fill(this.sample)
  }
}

type WorkletMode = 'none' | 'ready' | 'rejects'
let workletMode: WorkletMode = 'none'

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = []
  state: AudioContextState = 'running'
  readonly currentTime = 0
  readonly sampleRate: number
  readonly destination = new FakeNode('speakers')
  readonly nodes: FakeNode[] = []
  readonly audioWorklet?: { addModule: (url: string) => Promise<void> }

  constructor(options: AudioContextOptions) {
    super()
    this.sampleRate = options.sampleRate ?? 44_100
    if (workletMode !== 'none') {
      const rejects = workletMode === 'rejects'
      this.audioWorklet = {
        addModule: vi.fn(() => (rejects ? Promise.reject(new Error('blocked')) : Promise.resolve())),
      }
    }
    FakeAudioContext.instances.push(this)
  }
  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node)
    return node
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  createGain() {
    return this.track(Object.assign(new FakeNode('gain'), { gain: new FakeParam(1) }))
  }
  createAnalyser(): FakeAnalyser {
    return this.track(new FakeAnalyser())
  }
  createDynamicsCompressor() {
    const param = () => new FakeParam(0)
    return this.track(
      Object.assign(new FakeNode('compressor'), {
        threshold: param(),
        knee: param(),
        ratio: param(),
        attack: param(),
        release: param(),
      }),
    )
  }
  createMediaStreamSource(stream: MediaStream) {
    return this.track(Object.assign(new FakeNode('source'), { mediaStream: stream }))
  }
  createMediaStreamDestination() {
    return this.track(Object.assign(new FakeNode('stream-destination'), { stream: createFakeStream(['audio']) }))
  }
}

class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = []
  readonly port: { onmessage: ((event: MessageEvent<MeterReading>) => void) | null } = { onmessage: null }
  readonly name: string
  readonly options: AudioWorkletNodeOptions
  constructor(_context: FakeAudioContext, name: string, options: AudioWorkletNodeOptions) {
    super('meter')
    this.name = name
    this.options = options
    FakeWorkletNode.instances.push(this)
  }
  emit(reading: MeterReading): void {
    this.port.onmessage?.({ data: reading } as MessageEvent<MeterReading>)
  }
}

function context(): FakeAudioContext {
  const found = FakeAudioContext.instances.at(-1)
  if (!found) throw new Error('no AudioContext was created')
  return found
}

function analysers(): FakeAnalyser[] {
  return context().nodes.filter((node): node is FakeAnalyser => node instanceof FakeAnalyser)
}

function meter(index: number): FakeWorkletNode {
  const found = FakeWorkletNode.instances[index]
  if (!found) throw new Error(`no meter node ${index}`)
  return found
}

const host: AudioChannelConfig = {
  id: 'host',
  sourceId: 'host',
  kind: 'host-mic',
  label: 'Host',
  volume: 1,
  gainDb: 0,
  mutedInMix: true,
  monitoring: false,
}

let mixer: AudioMixer

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => 'blob:livedeck-meter',
  })
})

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeWorkletNode.instances = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  resetCapabilitiesCache()
  mixer = new AudioMixer()
})

afterEach(async () => {
  await mixer.dispose()
  meterBus.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  workletMode = 'none'
})

describe('worklet metering', () => {
  beforeEach(() => {
    workletMode = 'ready'
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  })

  it('taps the program analyser with a meter sized for 50ms at 48 kHz, and starts no timer', async () => {
    vi.useFakeTimers()
    await mixer.initialize()
    const programMeter = meter(0)
    const [programAnalyser] = analysers()

    expect(context().audioWorklet?.addModule).toHaveBeenCalledWith('blob:livedeck-meter')
    expect(programMeter.name).toBe(METER_PROCESSOR_NAME)
    expect(programMeter.options).toMatchObject({
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { intervalFrames: 2400 },
    })
    expect(programAnalyser?.outputs).toContain(programMeter)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs one setup for concurrent initialize calls, so polling never starts beside the worklet', async () => {
    vi.useFakeTimers()
    await Promise.all([mixer.initialize(), mixer.initialize()])
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeWorkletNode.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes program readings rising instantly and falling gradually', async () => {
    await mixer.initialize()
    meter(0).emit({ rms: 0.5, peak: 0.7, clipping: true })
    const loud = meterBus.get(PROGRAM_METER_ID)
    expect(loud).toMatchObject({ rms: 0.5, peak: 0.7, clipping: true })
    expect(loud.db).toBeCloseTo(20 * Math.log10(0.5), 6)

    meter(0).emit({ rms: 0, peak: 0, clipping: false })
    expect(meterBus.get(PROGRAM_METER_ID).rms).toBeCloseTo(0.39, 6)
  })

  it('meters a muted channel pre-fader and floors silence at -60 dB', async () => {
    await mixer.initialize()
    const stream = createFakeStream(['audio'])
    mixer.addChannel(host, stream)
    const channelMeter = meter(1)
    const channelAnalyser = analysers()[1]
    expect(channelAnalyser?.outputs).toContain(channelMeter)

    channelMeter.emit({ rms: 0, peak: 0, clipping: false })
    expect(meterBus.get('host')).toEqual({ rms: 0, peak: 0, db: -60, clipping: false })
    channelMeter.emit({ rms: 0.25, peak: 0.3, clipping: false })
    expect(mixer.getLevel('host').rms).toBe(0.25)
    expect(meterBus.get(PROGRAM_METER_ID)).toEqual(SILENT_LEVEL)
  })

  it('detaches the channel meter when the channel is removed', async () => {
    await mixer.initialize()
    mixer.addChannel(host, createFakeStream(['audio']))
    const channelMeter = meter(1)
    mixer.removeChannel('host')
    expect(channelMeter.disconnected).toBe(true)
    expect(channelMeter.port.onmessage).toBeNull()
    expect(mixer.getLevel('host')).toEqual(SILENT_LEVEL)
  })

  it('detaches the program meter on dispose', async () => {
    await mixer.initialize()
    const programMeter = meter(0)
    await mixer.dispose()
    expect(programMeter.disconnected).toBe(true)
    expect(programMeter.port.onmessage).toBeNull()
  })
})

describe('polled metering (no AudioWorklet)', () => {
  it('falls back to polling when the worklet module fails to load', async () => {
    workletMode = 'rejects'
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
    vi.useFakeTimers()
    await mixer.initialize()
    expect(FakeWorkletNode.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('samples every analyser every 50ms and publishes per channel', async () => {
    vi.useFakeTimers()
    await mixer.initialize()
    mixer.addChannel(host, createFakeStream(['audio']))
    expect(vi.getTimerCount()).toBe(1)
    const [program, channel] = analysers()
    if (!program || !channel) throw new Error('analysers missing')
    expect(channel.fftSize).toBe(1024)

    channel.sample = 0.5
    program.sample = 1
    vi.advanceTimersByTime(49)
    expect(meterBus.get('host')).toEqual(SILENT_LEVEL)
    vi.advanceTimersByTime(1)

    const level = meterBus.get('host')
    expect(level.rms).toBeCloseTo(0.5, 6)
    expect(level.peak).toBeCloseTo(0.5, 6)
    expect(level.clipping).toBe(false)
    expect(meterBus.get(PROGRAM_METER_ID)).toMatchObject({ rms: 1, peak: 1, clipping: true })

    channel.sample = 0
    vi.advanceTimersByTime(50)
    const falling = meterBus.get('host')
    expect(falling.rms).toBeCloseTo(0.39, 6)
    // dB follows the smoothed level, as in worklet mode.
    expect(falling.db).toBeCloseTo(20 * Math.log10(0.39), 6)
  })

  it('publishes silence for an analyser that cannot be read', async () => {
    vi.useFakeTimers()
    await mixer.initialize()
    mixer.addChannel(host, createFakeStream(['audio']))
    const channel = analysers()[1]
    if (!channel) throw new Error('analyser missing')
    channel.sample = 0.5
    vi.advanceTimersByTime(50)
    channel.sample = null
    vi.advanceTimersByTime(50)
    expect(meterBus.get('host')).toEqual(SILENT_LEVEL)
  })

  it('stops polling when the last channel is removed and restarts on the next one', async () => {
    vi.useFakeTimers()
    await mixer.initialize()
    mixer.addChannel(host, createFakeStream(['audio']))
    mixer.addChannel({ ...host, id: 'guest' }, createFakeStream(['audio']))
    expect(vi.getTimerCount()).toBe(1)

    mixer.removeChannel('host')
    expect(vi.getTimerCount()).toBe(1)
    mixer.removeChannel('guest')
    expect(vi.getTimerCount()).toBe(0)

    mixer.addChannel(host, createFakeStream(['audio']))
    expect(vi.getTimerCount()).toBe(1)
    await mixer.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
