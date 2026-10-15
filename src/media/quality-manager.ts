import type { PeerStats } from '@/types/peer'

/**
 * Stats-driven quality adaptation.
 *
 * Samples the transports every couple of seconds and turns the numbers into
 * two decisions:
 *
 *   downlink tier   which simulcast layer to ask the SFU for on every remote
 *                   video (2 = full, 1 = half, 0 = quarter)
 *   uplink tier     how many layers this participant's camera sends
 *
 * The decision logic is pure ({@link decideTier}) so it is testable without a
 * browser. Hysteresis is explicit: a tier drops after a few consecutive bad
 * samples and rises only after many consecutive good ones, so a single lost
 * packet burst does not make the picture flicker between sizes.
 */

export type QualitySample = {
  /** Fraction of packets lost in this interval, 0..1. Null when unknown. */
  packetLoss: number | null
  roundTripTimeMs: number | null
  jitterMs: number | null
  /** Frames dropped in this interval. Null when unknown. */
  framesDropped: number | null
  /** Bits per second available (sender side), or null. */
  availableBitrateBps: number | null
}

export type Tier = 0 | 1 | 2

export type TierState = {
  tier: Tier
  bad: number
  good: number
}

export const THRESHOLDS = {
  loss: { bad: 0.05, good: 0.01 },
  rttMs: { bad: 400, good: 200 },
  jitterMs: { bad: 60, good: 30 },
  /** Consecutive bad samples before stepping down. */
  stepDownAfter: 3,
  /** Consecutive good samples before stepping up. */
  stepUpAfter: 10,
}

export function classify(sample: QualitySample): 'bad' | 'good' | 'neutral' {
  const loss = sample.packetLoss
  const rtt = sample.roundTripTimeMs
  const jitter = sample.jitterMs
  const isBad =
    (loss !== null && loss >= THRESHOLDS.loss.bad) ||
    (rtt !== null && rtt >= THRESHOLDS.rttMs.bad) ||
    (jitter !== null && jitter >= THRESHOLDS.jitterMs.bad)
  if (isBad) return 'bad'
  const isGood =
    (loss === null || loss <= THRESHOLDS.loss.good) &&
    (rtt === null || rtt <= THRESHOLDS.rttMs.good) &&
    (jitter === null || jitter <= THRESHOLDS.jitterMs.good)
  return isGood ? 'good' : 'neutral'
}

/** One step of the hysteresis machine. Pure. */
export function decideTier(state: TierState, sample: QualitySample): TierState {
  const verdict = classify(sample)
  if (verdict === 'bad') {
    const bad = state.bad + 1
    if (bad >= THRESHOLDS.stepDownAfter && state.tier > 0) {
      return { tier: (state.tier - 1) as Tier, bad: 0, good: 0 }
    }
    return { ...state, bad, good: 0 }
  }
  if (verdict === 'good') {
    const good = state.good + 1
    if (good >= THRESHOLDS.stepUpAfter && state.tier < 2) {
      return { tier: (state.tier + 1) as Tier, bad: 0, good: 0 }
    }
    return { ...state, good, bad: 0 }
  }
  // Neutral: neither streak advances, and a bad streak is forgiven slowly.
  return { ...state, bad: Math.max(0, state.bad - 1) }
}

export const INITIAL_TIER: TierState = { tier: 2, bad: 0, good: 0 }

/* ---------------------------------------------------------------- stats */

type Counters = { packetsLost: number; packetsReceived: number; packetsSent: number; framesDropped: number; bytes: number; at: number }

/**
 * Reduce an `RTCStatsReport` to one sample, as a delta against the previous
 * report so loss and bitrate are per interval rather than cumulative.
 */
export class StatsReducer {
  private previous: Counters | null = null

  reduce(report: RTCStatsReport, now: number): QualitySample & { bitrateBps: number | null } {
    let packetsLost = 0
    let packetsReceived = 0
    let packetsSent = 0
    let framesDropped = 0
    let bytes = 0
    let rtt: number | null = null
    let jitter: number | null = null
    let available: number | null = null
    report.forEach((stat: Record<string, unknown>) => {
      switch (stat.type) {
        case 'inbound-rtp':
          packetsLost += num(stat.packetsLost)
          packetsReceived += num(stat.packetsReceived)
          framesDropped += num(stat.framesDropped)
          bytes += num(stat.bytesReceived)
          if (typeof stat.jitter === 'number') jitter = Math.max(jitter ?? 0, stat.jitter * 1000)
          break
        case 'outbound-rtp':
          packetsSent += num(stat.packetsSent)
          bytes += num(stat.bytesSent)
          break
        case 'remote-inbound-rtp':
          packetsLost += num(stat.packetsLost)
          if (typeof stat.roundTripTime === 'number') rtt = Math.max(rtt ?? 0, stat.roundTripTime * 1000)
          if (typeof stat.jitter === 'number') jitter = Math.max(jitter ?? 0, stat.jitter * 1000)
          break
        case 'candidate-pair':
          if (stat.state === 'succeeded' || stat.nominated === true) {
            if (typeof stat.currentRoundTripTime === 'number') rtt = stat.currentRoundTripTime * 1000
            if (typeof stat.availableOutgoingBitrate === 'number') available = stat.availableOutgoingBitrate
          }
          break
        default:
          break
      }
    })
    const current: Counters = { packetsLost, packetsReceived, packetsSent, framesDropped, bytes, at: now }
    const previous = this.previous
    this.previous = current
    if (!previous) {
      return { packetLoss: null, roundTripTimeMs: rtt, jitterMs: jitter, framesDropped: null, availableBitrateBps: available, bitrateBps: null }
    }
    const lost = Math.max(0, packetsLost - previous.packetsLost)
    const total = Math.max(0, packetsReceived + packetsSent - previous.packetsReceived - previous.packetsSent) + lost
    const seconds = Math.max(0.001, (now - previous.at) / 1000)
    return {
      packetLoss: total > 0 ? lost / total : null,
      roundTripTimeMs: rtt,
      jitterMs: jitter,
      framesDropped: Math.max(0, framesDropped - previous.framesDropped),
      availableBitrateBps: available,
      bitrateBps: Math.max(0, bytes - previous.bytes) * 8 / seconds,
    }
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Per-participant numbers for the diagnostics panel, from a consumer report. */
export function summarizeConsumerStats(report: RTCStatsReport, previous: PeerStats | null, now: number): PeerStats {
  let bytes = 0
  let audioBytes = 0
  let fps: number | null = null
  let dropped: number | null = null
  let lost: number | null = null
  let jitter: number | null = null
  let rtt: number | null = null
  let pair: string | null = null
  report.forEach((stat: Record<string, unknown>) => {
    if (stat.type === 'inbound-rtp') {
      if (stat.kind === 'video') {
        bytes += num(stat.bytesReceived)
        if (typeof stat.framesPerSecond === 'number') fps = stat.framesPerSecond
        if (typeof stat.framesDropped === 'number') dropped = stat.framesDropped
      } else {
        audioBytes += num(stat.bytesReceived)
      }
      if (typeof stat.packetsLost === 'number') lost = (lost ?? 0) + stat.packetsLost
      if (typeof stat.jitter === 'number') jitter = Math.max(jitter ?? 0, stat.jitter * 1000)
    }
    if (stat.type === 'candidate-pair' && (stat.nominated === true || stat.state === 'succeeded')) {
      if (typeof stat.currentRoundTripTime === 'number') rtt = stat.currentRoundTripTime * 1000
      pair = `${String(stat.localCandidateId ?? '?')} → ${String(stat.remoteCandidateId ?? '?')}`
    }
  })
  const seconds = previous ? Math.max(0.001, (now - previous.sampledAt) / 1000) : null
  const prevVideo = previous?.videoBitrateKbps !== null && previous ? (previous as PeerStats & { _videoBytes?: number })._videoBytes ?? null : null
  void prevVideo
  return {
    roundTripTimeMs: rtt,
    videoBitrateKbps: seconds ? Math.round(((bytes - ((previous as { _videoBytes?: number })?._videoBytes ?? bytes)) * 8) / seconds / 1000) : null,
    audioBitrateKbps: seconds ? Math.round(((audioBytes - ((previous as { _audioBytes?: number })?._audioBytes ?? audioBytes)) * 8) / seconds / 1000) : null,
    framesPerSecond: fps,
    framesDropped: dropped,
    packetsLost: lost,
    jitterMs: jitter,
    candidatePair: pair,
    sampledAt: now,
    // Carried for the next delta; not part of the public type.
    ...({ _videoBytes: bytes, _audioBytes: audioBytes } as object),
  }
}
