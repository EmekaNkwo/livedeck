import type { MediaSession } from './media-session'
import { INITIAL_TIER, StatsReducer, decideTier, summarizeConsumerStats, type Tier, type TierState } from './quality-manager'
import type { PeerStats } from '@/types/peer'

/**
 * Drives {@link MediaSession} from the quality decisions.
 *
 * Downlink: the tier chooses the simulcast layer requested from the SFU for
 * every remote video. Uplink: the tier caps how many layers the camera
 * sends. Both are only ever changed on a tier transition, never per sample.
 */

export type QualityReport = {
  downlinkTier: Tier
  uplinkTier: Tier
  downlink: { packetLoss: number | null; roundTripTimeMs: number | null; jitterMs: number | null; bitrateKbps: number | null }
  uplink: { packetLoss: number | null; roundTripTimeMs: number | null; bitrateKbps: number | null }
  sampledAt: number
}

export type QualityControllerOptions = {
  intervalMs?: number
  onReport?: (report: QualityReport, perParticipant: Map<string, PeerStats>) => void
  now?: () => number
}

export class QualityController {
  private readonly session: MediaSession
  private readonly options: QualityControllerOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private down: TierState = INITIAL_TIER
  private up: TierState = INITIAL_TIER
  private readonly recvReducer = new StatsReducer()
  private readonly sendReducer = new StatsReducer()
  private readonly perParticipant = new Map<string, PeerStats>()
  private sampling = false

  constructor(session: MediaSession, options: QualityControllerOptions = {}) {
    this.session = session
    this.options = options
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sample(), this.options.intervalMs ?? 2000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async sample(): Promise<void> {
    if (this.sampling || this.session.current.status !== 'joined') return
    this.sampling = true
    const now = this.options.now?.() ?? Date.now()
    try {
      const { send, recv } = await this.session.getStats()
      const downSample = recv ? this.recvReducer.reduce(recv, now) : null
      const upSample = send ? this.sendReducer.reduce(send, now) : null

      if (downSample) {
        const next = decideTier(this.down, downSample)
        if (next.tier !== this.down.tier) await this.session.setPreferredSpatialLayer(next.tier)
        this.down = next
      }
      if (upSample) {
        const next = decideTier(this.up, upSample)
        if (next.tier !== this.up.tier) await this.session.setMaxSpatialLayer('camera', next.tier)
        this.up = next
      }

      const consumerStats = await this.session.getConsumerStats()
      for (const [participantId, report] of consumerStats) {
        this.perParticipant.set(participantId, summarizeConsumerStats(report, this.perParticipant.get(participantId) ?? null, now))
      }
      for (const id of [...this.perParticipant.keys()]) if (!consumerStats.has(id)) this.perParticipant.delete(id)

      this.options.onReport?.(
        {
          downlinkTier: this.down.tier,
          uplinkTier: this.up.tier,
          downlink: {
            packetLoss: downSample?.packetLoss ?? null,
            roundTripTimeMs: downSample?.roundTripTimeMs ?? null,
            jitterMs: downSample?.jitterMs ?? null,
            bitrateKbps: downSample?.bitrateBps !== null && downSample ? Math.round(downSample.bitrateBps / 1000) : null,
          },
          uplink: {
            packetLoss: upSample?.packetLoss ?? null,
            roundTripTimeMs: upSample?.roundTripTimeMs ?? null,
            bitrateKbps: upSample?.bitrateBps !== null && upSample ? Math.round(upSample.bitrateBps / 1000) : null,
          },
          sampledAt: now,
        },
        new Map(this.perParticipant),
      )
    } catch {
      // A sample that fails mid-teardown is not worth reporting.
    } finally {
      this.sampling = false
    }
  }
}
