import type { AudioChannelConfig, AudioContextStatus, AudioLevel } from '@/types/audio'
import { SILENT_LEVEL } from '@/types/audio'
import { detectCapabilities } from '@/lib/capabilities'
import { analyseTimeDomain, resolveGain, smoothMeter } from '@/utils/audio-math'
import { createMasterChain, type MasterChain } from './master-chain'
import { PROGRAM_METER_ID, meterBus } from './meter-bus'
import { createMeterNode, ensureMeterWorklet } from './meter-worklet'

/**
 * The program audio mixer.
 *
 * GRAPH (per channel)
 * -------------------
 *   MediaStream
 *       → MediaStreamAudioSourceNode
 *       → inputGain      (the channel's dB trim)
 *       → analyser       (pre-fader tap: meters keep moving while muted)
 *       → faderGain      (volume × mute — this is what reaches the program)
 *       → mixBus
 *       └→ monitorGain   (per-channel local listen, silent by default)
 *
 * GRAPH (program)
 *   mixBus → masterGain → compressor → limiter → analyser → destination (recorder)
 *                                                        └→ programMonitorGain → speakers
 *
 * The compressor evens out levels between a loud host and a quiet guest; the
 * limiter is a brick wall at -1 dBFS so twelve open microphones summed at
 * unity cannot clip the recording. See `master-chain.ts`.
 *
 * METERING
 * --------
 * Each channel and the program bus are metered by an AudioWorklet on the
 * audio thread, which posts one reading per 50ms. Where worklets are not
 * available the analysers are polled on a timer instead; the graph is the
 * same either way.
 *
 * The analyser sits *before* the fader on purpose. A muted channel still shows
 * level, which is how an operator notices that a muted guest is talking. The
 * recorder taps the destination node, so what you hear in the file is exactly
 * what the faders and mutes produced.
 *
 * MONITORING IS OFF BY DEFAULT. Routing a live microphone to the speakers in a
 * browser tab is an acoustic feedback loop; the user has to opt in per channel.
 */

type Channel = {
  config: AudioChannelConfig
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  inputGain: GainNode
  analyser: AnalyserNode
  fader: GainNode
  monitor: GainNode
  /** The worklet meter, when the context supports one. */
  meter: AudioWorkletNode | null
  buffer: Float32Array<ArrayBuffer>
  /** Smoothed meter value, so the needle falls gradually. */
  smoothed: number
}

/** Meter refresh rate. 20Hz reads as smooth without burning a frame budget. */
const METER_INTERVAL_MS = 50

export class AudioMixer {
  private context: AudioContext | null = null
  private mixBus: GainNode | null = null
  private masterGain: GainNode | null = null
  private programAnalyser: AnalyserNode | null = null
  private programBuffer: Float32Array<ArrayBuffer> | null = null
  private programSmoothed = 0
  private destination: MediaStreamAudioDestinationNode | null = null
  private programMonitor: GainNode | null = null
  private masterChain: MasterChain | null = null
  private programMeter: AudioWorkletNode | null = null
  private workletReady = false
  /** The one in-flight or finished graph setup; cleared by dispose. */
  private graphSetup: Promise<void> | null = null

  private readonly channels = new Map<string, Channel>()
  private meterTimer: ReturnType<typeof setInterval> | null = null
  private status: AudioContextStatus = 'uninitialized'
  private readonly statusListeners = new Set<(status: AudioContextStatus) => void>()

  /** Observe context state changes (suspended by the OS, device switched). */
  onStatusChange(listener: (status: AudioContextStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private publishStatus(): void {
    const status = this.getStatus()
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  getStatus(): AudioContextStatus {
    if (!detectCapabilities().webAudio) return 'unavailable'
    if (!this.context) return 'uninitialized'
    return this.context.state === 'running' ? 'running' : 'suspended'
  }

  getContext(): AudioContext | null {
    return this.context
  }

  /**
   * Create the graph. Must be called from a user gesture handler, otherwise the
   * browser starts the AudioContext in `suspended` and no audio flows.
   */
  async initialize(): Promise<AudioContextStatus> {
    if (!detectCapabilities().webAudio) {
      this.status = 'unavailable'
      return this.status
    }
    // Concurrent calls (a double click) share one setup, so the worklet
    // and the polling fallback can never both end up metering.
    if (!this.graphSetup) this.graphSetup = this.buildGraph()
    await this.graphSetup

    await this.resume()
    this.startMetering()
    this.publishStatus()
    return this.getStatus()
  }

  private async buildGraph(): Promise<void> {
    // 48 kHz is what Opus and every WebRTC path run at; letting the context
    // follow a 44.1 kHz system default would resample every guest twice.
    this.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 })
    this.context.addEventListener('statechange', () => {
      this.publishStatus()
      // An interruption (a device switch, Safari backgrounding) suspends the
      // context without a gesture. Resuming is allowed in that case.
      if (this.context?.state === 'suspended') void this.resume()
    })

    this.mixBus = this.context.createGain()
    this.mixBus.gain.value = 1

    this.masterGain = this.context.createGain()
    this.masterGain.gain.value = 1

    this.masterChain = createMasterChain(this.context)

    this.programAnalyser = this.context.createAnalyser()
    this.programAnalyser.fftSize = 1024
    this.programAnalyser.smoothingTimeConstant = 0.6
    this.programBuffer = new Float32Array(this.programAnalyser.fftSize)

    this.destination = this.context.createMediaStreamDestination()

    this.programMonitor = this.context.createGain()
    this.programMonitor.gain.value = 0

    this.mixBus.connect(this.masterGain)
    this.masterGain.connect(this.masterChain.input)
    this.masterChain.output.connect(this.programAnalyser)
    this.programAnalyser.connect(this.destination)
    this.programAnalyser.connect(this.programMonitor)
    this.programMonitor.connect(this.context.destination)

    this.workletReady = await ensureMeterWorklet(this.context)
    if (this.workletReady) {
      this.programMeter = createMeterNode(this.context, (reading) => {
        this.programSmoothed = smoothMeter(this.programSmoothed, reading.rms)
        meterBus.publish(PROGRAM_METER_ID, {
          rms: this.programSmoothed,
          peak: reading.peak,
          db: toDb(this.programSmoothed),
          clipping: reading.clipping,
        })
      })
      this.programAnalyser.connect(this.programMeter)
    }
  }

  /** Resume a context the browser auto-suspended (tab backgrounded, etc.). */
  async resume(): Promise<void> {
    if (!this.context) return
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume()
      } catch {
        // Resume is rejected when not in a user gesture. The UI shows an
        // "enable audio" affordance in that case rather than failing silently.
      }
    }
    this.status = this.getStatus()
  }

  /**
   * The program audio track for the recorder.
   * Null when Web Audio is unavailable, in which case the recorder records
   * video only and says so.
   */
  getProgramStream(): MediaStream | null {
    return this.destination?.stream ?? null
  }

  /**
   * Add or replace a channel.
   *
   * Replacing is the normal path for a device switch: the old nodes are torn
   * down and new ones built, so no orphaned MediaStreamAudioSourceNode keeps
   * pulling from a stopped track. Streams with no audio track are rejected
   * rather than creating a silent, confusing channel.
   */
  addChannel(config: AudioChannelConfig, stream: MediaStream): boolean {
    if (!this.context || !this.mixBus) return false
    if (stream.getAudioTracks().length === 0) return false

    this.removeChannel(config.id)

    const context = this.context
    const source = context.createMediaStreamSource(stream)

    const inputGain = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.5

    const fader = context.createGain()
    const monitor = context.createGain()
    monitor.gain.value = 0

    source.connect(inputGain)
    inputGain.connect(analyser)
    analyser.connect(fader)
    fader.connect(this.mixBus)
    fader.connect(monitor)
    monitor.connect(context.destination)

    const channel: Channel = {
      config,
      stream,
      source,
      inputGain,
      analyser,
      fader,
      monitor,
      meter: null,
      buffer: new Float32Array(analyser.fftSize),
      smoothed: 0,
    }
    if (this.workletReady) {
      channel.meter = createMeterNode(context, (reading) => {
        channel.smoothed = smoothMeter(channel.smoothed, reading.rms)
        meterBus.publish(config.id, {
          rms: channel.smoothed,
          peak: reading.peak,
          db: toDb(channel.smoothed),
          clipping: reading.clipping,
        })
      })
      analyser.connect(channel.meter)
    }
    this.channels.set(config.id, channel)
    this.applyConfig(channel, config)
    this.startMetering()
    return true
  }

  /** Update gain / volume / mute / monitoring without rebuilding the graph. */
  updateChannel(config: AudioChannelConfig): void {
    const channel = this.channels.get(config.id)
    if (!channel) return
    channel.config = config
    this.applyConfig(channel, config)
  }

  private applyConfig(channel: Channel, config: AudioChannelConfig): void {
    const context = this.context
    if (!context) return
    const now = context.currentTime
    // Ramp rather than step: an abrupt gain change on a live signal is an
    // audible click, and clicks land in the recording.
    const ramp = 0.015
    const inputLinear = resolveGain(1, config.gainDb, false)
    const faderLinear = resolveGain(config.volume, 0, config.mutedInMix)

    channel.inputGain.gain.setTargetAtTime(inputLinear, now, ramp)
    channel.fader.gain.setTargetAtTime(faderLinear, now, ramp)
    channel.monitor.gain.setTargetAtTime(config.monitoring ? 1 : 0, now, ramp)
  }

  /** Disconnect and forget a channel. Does **not** stop the capture tracks — */
  /** stream lifetime belongs to the StreamRegistry, not to the mixer. */
  removeChannel(channelId: string): void {
    const channel = this.channels.get(channelId)
    if (!channel) return
    this.channels.delete(channelId)
    for (const node of [
      channel.source,
      channel.inputGain,
      channel.analyser,
      channel.fader,
      channel.monitor,
      channel.meter,
    ]) {
      try {
        node?.disconnect()
      } catch {
        // Already disconnected.
      }
    }
    if (channel.meter) channel.meter.port.onmessage = null
    meterBus.reset(channelId)
    if (this.channels.size === 0) this.stopMetering()
  }

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId)
  }

  channelIds(): string[] {
    return [...this.channels.keys()]
  }

  /** Route the program bus to the local speakers. Off by default. */
  setProgramMonitoring(enabled: boolean): void {
    if (!this.programMonitor || !this.context) return
    this.programMonitor.gain.setTargetAtTime(enabled ? 1 : 0, this.context.currentTime, 0.02)
  }

  setMasterVolume(volume: number): void {
    if (!this.masterGain || !this.context) return
    this.masterGain.gain.setTargetAtTime(
      resolveGain(volume, 0, false),
      this.context.currentTime,
      0.02,
    )
  }

  getLevel(channelId: string): AudioLevel {
    return meterBus.get(channelId)
  }

  /**
   * Poll every analyser on a timer and publish to the meter bus.
   *
   * A timer rather than rAF: metering must keep working when the tab is in the
   * background (a recording may be running), and it should not be tied to the
   * display refresh rate.
   */
  private startMetering(): void {
    // The worklet pushes readings itself; polling is the fallback.
    if (this.workletReady) return
    if (this.meterTimer !== null) return
    if (!this.context) return
    this.meterTimer = setInterval(() => this.sampleMeters(), METER_INTERVAL_MS)
  }

  private stopMetering(): void {
    if (this.meterTimer === null) return
    clearInterval(this.meterTimer)
    this.meterTimer = null
  }

  private sampleMeters(): void {
    for (const channel of this.channels.values()) {
      const level = this.readAnalyser(channel.analyser, channel.buffer, channel.smoothed)
      channel.smoothed = level.rms
      meterBus.publish(channel.config.id, level)
    }
    if (this.programAnalyser && this.programBuffer) {
      const level = this.readAnalyser(
        this.programAnalyser,
        this.programBuffer,
        this.programSmoothed,
      )
      this.programSmoothed = level.rms
      meterBus.publish(PROGRAM_METER_ID, level)
    }
  }

  private readAnalyser(
    analyser: AnalyserNode,
    buffer: Float32Array<ArrayBuffer>,
    previous: number,
  ): AudioLevel {
    try {
      analyser.getFloatTimeDomainData(buffer)
    } catch {
      return SILENT_LEVEL
    }
    const raw = analyseTimeDomain(buffer)
    const rms = smoothMeter(previous, raw.rms)
    // dB follows the smoothed level, as the worklet path does, so the two
    // never disagree while a meter falls.
    return { ...raw, rms, db: toDb(rms) }
  }

  /**
   * Tear the whole mixer down. Called when a session ends.
   * Closing the AudioContext releases the audio hardware; without it, repeated
   * start/stop cycles leak contexts and eventually hit the per-document limit.
   */
  async dispose(): Promise<void> {
    this.stopMetering()
    for (const id of [...this.channels.keys()]) this.removeChannel(id)
    meterBus.reset(PROGRAM_METER_ID)
    this.masterChain?.disconnect()
    this.masterChain = null
    if (this.programMeter) this.programMeter.port.onmessage = null
    for (const node of [
      this.mixBus,
      this.masterGain,
      this.programAnalyser,
      this.programMonitor,
      this.destination,
      this.programMeter,
    ]) {
      try {
        node?.disconnect()
      } catch {
        // Already disconnected.
      }
    }
    this.programMeter = null
    this.workletReady = false
    this.graphSetup = null
    this.mixBus = null
    this.masterGain = null
    this.programAnalyser = null
    this.programBuffer = null
    this.programMonitor = null
    this.destination = null
    if (this.context) {
      const context = this.context
      this.context = null
      try {
        await context.close()
      } catch {
        // Closing an already-closed context rejects; teardown must not throw.
      }
    }
    this.status = 'uninitialized'
    this.publishStatus()
  }
}

/** RMS (0..1) to dBFS, clamped at the meter floor. */
function toDb(rms: number): number {
  if (rms <= 0) return -60
  return Math.max(-60, 20 * Math.log10(rms))
}

export const audioMixer = new AudioMixer()
