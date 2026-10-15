/**
 * An AudioWorklet that meters a signal off the main thread.
 *
 * The processor runs on the audio rendering thread and posts one reading per
 * `intervalFrames` block: RMS, peak and whether the block clipped. The main
 * thread never touches sample data, which is what keeps twelve guest meters
 * from costing anything while the compositor is busy.
 *
 * Shipped as source text and loaded from a blob URL so the bundler needs no
 * special handling and the module works from any origin.
 */

export const METER_PROCESSOR_NAME = 'livedeck-meter'

const PROCESSOR_SOURCE = `
class LiveDeckMeter extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const params = (options && options.processorOptions) || {}
    this.intervalFrames = params.intervalFrames || 2400
    this.sumSquares = 0
    this.peak = 0
    this.count = 0
    this.clipped = false
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channels = input.length
    const frames = input[0].length
    for (let i = 0; i < frames; i += 1) {
      let sample = 0
      for (let c = 0; c < channels; c += 1) sample += input[c][i]
      sample /= channels
      const magnitude = sample < 0 ? -sample : sample
      this.sumSquares += sample * sample
      if (magnitude > this.peak) this.peak = magnitude
      if (magnitude >= 0.999) this.clipped = true
    }
    this.count += frames
    if (this.count >= this.intervalFrames) {
      const rms = Math.sqrt(this.sumSquares / this.count)
      this.port.postMessage({ rms, peak: this.peak, clipping: this.clipped })
      this.sumSquares = 0
      this.peak = 0
      this.count = 0
      this.clipped = false
    }
    return true
  }
}
registerProcessor('${METER_PROCESSOR_NAME}', LiveDeckMeter)
`

let moduleUrl: string | null = null
const loaded = new WeakSet<AudioContext>()

/** Register the processor on a context. Resolves false when unsupported. */
export async function ensureMeterWorklet(context: AudioContext): Promise<boolean> {
  if (typeof context.audioWorklet === 'undefined' || typeof AudioWorkletNode === 'undefined') return false
  if (loaded.has(context)) return true
  try {
    if (!moduleUrl) {
      moduleUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }))
    }
    await context.audioWorklet.addModule(moduleUrl)
    loaded.add(context)
    return true
  } catch {
    return false
  }
}

export type MeterReading = { rms: number; peak: number; clipping: boolean }

export function createMeterNode(
  context: AudioContext,
  onReading: (reading: MeterReading) => void,
  intervalMs = 50,
): AudioWorkletNode {
  const node = new AudioWorkletNode(context, METER_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { intervalFrames: Math.round((context.sampleRate * intervalMs) / 1000) },
  })
  node.port.onmessage = (event: MessageEvent<MeterReading>) => onReading(event.data)
  return node
}
