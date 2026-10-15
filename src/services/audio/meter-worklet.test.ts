import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeterReading } from './meter-worklet'

/**
 * The worklet loader, the node factory, and the processor itself. The
 * processor ships as source text, so it is captured from the Blob the loader
 * builds and evaluated against a fake AudioWorkletGlobalScope.
 */

type MeterModule = typeof import('./meter-worklet')

class CapturedBlob {
  readonly parts: string[]
  readonly options: BlobPropertyBag
  constructor(parts: string[], options: BlobPropertyBag) {
    this.parts = parts
    this.options = options
  }
}

class FakeWorkletNode {
  readonly port: { onmessage: ((event: MessageEvent<MeterReading>) => void) | null } = { onmessage: null }
  readonly name: string
  readonly options: AudioWorkletNodeOptions
  constructor(_context: BaseAudioContext, name: string, options: AudioWorkletNodeOptions) {
    this.name = name
    this.options = options
  }
}

type FakeContext = { sampleRate: number; audioWorklet?: { addModule: ReturnType<typeof vi.fn> } }

function fakeContext(addModule = vi.fn(() => Promise.resolve()), sampleRate = 48_000): FakeContext {
  return { sampleRate, audioWorklet: { addModule } }
}

const asContext = (context: FakeContext) => context as unknown as AudioContext

let createObjectURL: ReturnType<typeof vi.fn>
let meterModule: MeterModule

beforeEach(async () => {
  createObjectURL = vi.fn((_blob: CapturedBlob) => 'blob:meter-1')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  vi.stubGlobal('Blob', CapturedBlob)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  // The loader memoizes its blob URL at module scope; each test starts clean.
  vi.resetModules()
  meterModule = await import('./meter-worklet')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureMeterWorklet', () => {
  it('registers the processor from a JavaScript blob URL', async () => {
    const context = fakeContext()
    await expect(meterModule.ensureMeterWorklet(asContext(context))).resolves.toBe(true)
    expect(context.audioWorklet?.addModule).toHaveBeenCalledWith('blob:meter-1')
    const blob = createObjectURL.mock.calls[0]?.[0] as CapturedBlob
    expect(blob.options).toEqual({ type: 'application/javascript' })
    expect(blob.parts.join('')).toContain(`registerProcessor('${meterModule.METER_PROCESSOR_NAME}'`)
  })

  it('loads the module once per context and builds the blob once overall', async () => {
    const first = fakeContext()
    const second = fakeContext()
    await meterModule.ensureMeterWorklet(asContext(first))
    await meterModule.ensureMeterWorklet(asContext(first))
    await meterModule.ensureMeterWorklet(asContext(second))
    expect(first.audioWorklet?.addModule).toHaveBeenCalledTimes(1)
    expect(second.audioWorklet?.addModule).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('resolves false when the context has no audioWorklet', async () => {
    await expect(meterModule.ensureMeterWorklet(asContext({ sampleRate: 48_000 }))).resolves.toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('resolves false when AudioWorkletNode is missing', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined)
    const context = fakeContext()
    await expect(meterModule.ensureMeterWorklet(asContext(context))).resolves.toBe(false)
    expect(context.audioWorklet?.addModule).not.toHaveBeenCalled()
  })

  it('resolves false when the module is refused, and retries next time', async () => {
    const addModule = vi.fn(() => Promise.resolve())
    addModule.mockRejectedValueOnce(new Error('CSP blocked blob:'))
    const context = fakeContext(addModule)
    await expect(meterModule.ensureMeterWorklet(asContext(context))).resolves.toBe(false)
    await expect(meterModule.ensureMeterWorklet(asContext(context))).resolves.toBe(true)
    expect(addModule).toHaveBeenCalledTimes(2)
  })
})

describe('createMeterNode', () => {
  it('creates an input-only node whose interval matches the context rate', () => {
    const node = meterModule.createMeterNode(asContext(fakeContext(undefined, 44_100)), () => {}, 100)
    const fake = node as unknown as FakeWorkletNode
    expect(fake.name).toBe(meterModule.METER_PROCESSOR_NAME)
    expect(fake.options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { intervalFrames: 4410 },
    })
  })

  it('defaults to a 50ms interval and forwards each posted reading', () => {
    const readings: MeterReading[] = []
    const node = meterModule.createMeterNode(asContext(fakeContext()), (reading) => readings.push(reading))
    const fake = node as unknown as FakeWorkletNode
    expect(fake.options.processorOptions).toEqual({ intervalFrames: 2400 })
    fake.port.onmessage?.({ data: { rms: 0.2, peak: 0.4, clipping: false } } as MessageEvent<MeterReading>)
    expect(readings).toEqual([{ rms: 0.2, peak: 0.4, clipping: false }])
  })
})

/* -------------------------------------------------- the processor itself */

type Processor = { process: (inputs: Float32Array[][]) => boolean }
type ProcessorClass = new (options?: { processorOptions?: { intervalFrames?: number } }) => Processor

/** Evaluate the shipped processor source against a fake worklet scope. */
async function loadProcessor(): Promise<{ Processor: ProcessorClass; posted: MeterReading[] }> {
  await meterModule.ensureMeterWorklet(asContext(fakeContext()))
  const blob = createObjectURL.mock.calls[0]?.[0] as CapturedBlob
  const posted: MeterReading[] = []
  class AudioWorkletProcessor {
    readonly port = { postMessage: (reading: MeterReading) => posted.push(reading) }
  }
  const registered: ProcessorClass[] = []
  const register = (name: string, processor: ProcessorClass) => {
    expect(name).toBe(meterModule.METER_PROCESSOR_NAME)
    registered.push(processor)
  }
  const evaluate = new Function('AudioWorkletProcessor', 'registerProcessor', blob.parts.join(''))
  evaluate(AudioWorkletProcessor, register)
  const Processor = registered[0]
  if (!Processor) throw new Error('processor was not registered')
  return { Processor, posted }
}

const block = (...samples: number[]) => Float32Array.from(samples)

describe('meter processor', () => {
  it('posts RMS and peak once the interval is reached, then starts a fresh window', async () => {
    const { Processor, posted } = await loadProcessor()
    const processor = new Processor({ processorOptions: { intervalFrames: 4 } })

    expect(processor.process([[block(0.5, -0.5)]])).toBe(true)
    expect(posted).toHaveLength(0)
    processor.process([[block(0.5, -0.5)]])
    expect(posted).toEqual([{ rms: 0.5, peak: 0.5, clipping: false }])

    processor.process([[block(0.1, 0.1, 0.1, 0.1)]])
    expect(posted[1]?.rms).toBeCloseTo(0.1, 6)
    expect(posted[1]?.peak).toBeCloseTo(0.1, 6)
  })

  it('averages channels to mono and flags samples at full scale as clipping', async () => {
    const { Processor, posted } = await loadProcessor()
    const processor = new Processor({ processorOptions: { intervalFrames: 2 } })
    processor.process([[block(1, 0.5), block(1, -0.5)]])
    expect(posted).toEqual([{ rms: Math.sqrt(0.5), peak: 1, clipping: true }])

    processor.process([[block(0.2, 0.2), block(0.2, 0.2)]])
    expect(posted[1]?.clipping).toBe(false)
  })

  it('keeps running with no input connected', async () => {
    const { Processor, posted } = await loadProcessor()
    const processor = new Processor()
    expect(processor.process([])).toBe(true)
    expect(processor.process([[]])).toBe(true)
    expect(posted).toHaveLength(0)
  })

  it('defaults to 2400 frames (50ms at 48 kHz) without options', async () => {
    const { Processor, posted } = await loadProcessor()
    const processor = new Processor()
    for (let i = 0; i < 18; i += 1) processor.process([[new Float32Array(128)]])
    expect(posted).toHaveLength(0)
    processor.process([[new Float32Array(128)]])
    expect(posted).toEqual([{ rms: 0, peak: 0, clipping: false }])
  })
})
