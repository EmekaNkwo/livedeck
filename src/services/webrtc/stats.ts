import type { PeerStats } from '@/types/peer'

/**
 * Read real statistics from `RTCPeerConnection.getStats()`.
 *
 * Every field is nullable and stays null when the browser did not report it.
 * No metric is ever estimated, interpolated or invented — a dash in the
 * diagnostics panel means "this browser did not tell us", which is more useful
 * than a plausible-looking fabrication.
 *
 * Bitrate is not reported directly by the API, so it is derived from the
 * delta between two samples; the first sample therefore yields null.
 */

export type StatsSample = {
  at: number
  videoBytes: number
  audioBytes: number
} | null

export type StatsResult = {
  stats: PeerStats
  sample: StatsSample
}

export async function collectStats(
  pc: RTCPeerConnection,
  previous: StatsSample,
): Promise<StatsResult> {
  const empty: PeerStats = {
    roundTripTimeMs: null,
    videoBitrateKbps: null,
    audioBitrateKbps: null,
    framesPerSecond: null,
    framesDropped: null,
    packetsLost: null,
    jitterMs: null,
    candidatePair: null,
    sampledAt: Date.now(),
  }

  if (typeof pc.getStats !== 'function' || pc.connectionState === 'closed') {
    return { stats: empty, sample: previous }
  }

  let report: RTCStatsReport
  try {
    report = await pc.getStats()
  } catch {
    return { stats: empty, sample: previous }
  }

  const now = performance.now()
  let videoBytes = 0
  let audioBytes = 0
  const next: PeerStats = { ...empty }

  report.forEach((entry) => {
    const stat = entry as RTCStats & Record<string, unknown>

    if (stat.type === 'inbound-rtp') {
      const kind = typeof stat.kind === 'string' ? stat.kind : null
      const bytes = numberOrNull(stat.bytesReceived)
      if (kind === 'video') {
        if (bytes !== null) videoBytes += bytes
        next.framesPerSecond = numberOrNull(stat.framesPerSecond) ?? next.framesPerSecond
        const dropped = numberOrNull(stat.framesDropped)
        if (dropped !== null) next.framesDropped = dropped
      } else if (kind === 'audio') {
        if (bytes !== null) audioBytes += bytes
      }
      const lost = numberOrNull(stat.packetsLost)
      if (lost !== null) next.packetsLost = (next.packetsLost ?? 0) + lost
      const jitter = numberOrNull(stat.jitter)
      // `jitter` is reported in seconds.
      if (jitter !== null) next.jitterMs = jitter * 1000
    }

    if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
      const rtt = numberOrNull(stat.currentRoundTripTime)
      if (rtt !== null) next.roundTripTimeMs = rtt * 1000
      const localType = typeof stat.localCandidateId === 'string' ? stat.localCandidateId : ''
      const remoteType = typeof stat.remoteCandidateId === 'string' ? stat.remoteCandidateId : ''
      next.candidatePair = describePair(report, localType, remoteType)
    }
  })

  if (previous) {
    const elapsedSeconds = (now - previous.at) / 1000
    if (elapsedSeconds > 0.2) {
      next.videoBitrateKbps = toKbps(videoBytes - previous.videoBytes, elapsedSeconds)
      next.audioBitrateKbps = toKbps(audioBytes - previous.audioBytes, elapsedSeconds)
    }
  }

  return {
    stats: next,
    sample: { at: now, videoBytes, audioBytes },
  }
}

function toKbps(byteDelta: number, seconds: number): number | null {
  if (byteDelta < 0 || seconds <= 0) return null
  return Math.round((byteDelta * 8) / seconds / 1000)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Resolve candidate ids into a readable "host → srflx (udp)" description. */
function describePair(
  report: RTCStatsReport,
  localId: string,
  remoteId: string,
): string | null {
  const local = localId ? (report.get(localId) as Record<string, unknown> | undefined) : undefined
  const remote = remoteId
    ? (report.get(remoteId) as Record<string, unknown> | undefined)
    : undefined
  if (!local && !remote) return null
  const localType = typeof local?.candidateType === 'string' ? local.candidateType : '?'
  const remoteType = typeof remote?.candidateType === 'string' ? remote.candidateType : '?'
  const protocol = typeof local?.protocol === 'string' ? local.protocol : ''
  return `${localType} → ${remoteType}${protocol ? ` (${protocol})` : ''}`
}
