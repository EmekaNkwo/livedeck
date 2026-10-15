import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSession } from './media-session'
import { QualityController } from './quality-controller'
import { THRESHOLDS } from './quality-manager'

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return { forEach: (fn: (value: Record<string, unknown>) => void) => entries.forEach(fn) } as unknown as RTCStatsReport
}

type FakeSession = {
  current: { status: string }
  stats: { send: RTCStatsReport | null; recv: RTCStatsReport | null }
  consumerStats: Map<string, RTCStatsReport>
  setPreferredSpatialLayer: ReturnType<typeof vi.fn>
  setMaxSpatialLayer: ReturnType<typeof vi.fn>
  getStats: () => Promise<{ send: RTCStatsReport | null; recv: RTCStatsReport | null }>
  getConsumerStats: () => Promise<Map<string, RTCStatsReport>>
}

function makeSession(): FakeSession {
  const session: FakeSession = {
    current: { status: 'joined' },
    stats: { send: null, recv: null },
    consumerStats: new Map(),
    setPreferredSpatialLayer: vi.fn(async () => {}),
    setMaxSpatialLayer: vi.fn(async () => {}),
    getStats: async () => session.stats,
    getConsumerStats: async () => session.consumerStats,
  }
  return session
}

/** Cumulative counters that produce the given loss fraction every interval. */
function lossy(step: number, loss: number): RTCStatsReport {
  const packets = 1000 * step
  return report([
    { type: 'inbound-rtp', packetsReceived: packets, packetsLost: Math.round(packets * loss), bytesReceived: 100_000 * step, jitter: 0.005 },
    { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.05 },
  ])
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('QualityController', () => {
  it('steps the downlink layer down after sustained loss and reports it', async () => {
    const session = makeSession()
    const reports: number[] = []
    const controller = new QualityController(session as unknown as MediaSession, {
      intervalMs: 100,
      onReport: (r) => reports.push(r.downlinkTier),
    })
    controller.start()
    let step = 1
    // First sample is a baseline (no delta); then enough bad samples.
    for (let i = 0; i <= THRESHOLDS.stepDownAfter; i += 1) {
      session.stats = { send: null, recv: lossy(step++, 0.2) }
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(session.setPreferredSpatialLayer).toHaveBeenCalledWith(1)
    expect(reports.at(-1)).toBe(1)
    controller.stop()
  })

  it('caps the camera on uplink loss, and only on a tier change', async () => {
    const session = makeSession()
    const controller = new QualityController(session as unknown as MediaSession, { intervalMs: 100 })
    controller.start()
    let step = 1
    for (let i = 0; i <= THRESHOLDS.stepDownAfter + 2; i += 1) {
      session.stats = {
        send: report([
          { type: 'outbound-rtp', packetsSent: 1000 * step, bytesSent: 50_000 * step },
          { type: 'remote-inbound-rtp', packetsLost: Math.round(1000 * step * 0.3), roundTripTime: 0.05 },
        ]),
        recv: null,
      }
      step += 1
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(session.setMaxSpatialLayer).toHaveBeenCalledTimes(1)
    expect(session.setMaxSpatialLayer).toHaveBeenCalledWith('camera', 1)
    controller.stop()
  })

  it('does nothing while not joined and never overlaps samples', async () => {
    const session = makeSession()
    session.current.status = 'joining'
    const getStats = vi.spyOn(session, 'getStats')
    const controller = new QualityController(session as unknown as MediaSession, { intervalMs: 100 })
    controller.start()
    await vi.advanceTimersByTimeAsync(350)
    expect(getStats).not.toHaveBeenCalled()
    controller.stop()
  })

  it('reports per-participant consumer stats', async () => {
    const session = makeSession()
    session.consumerStats = new Map([
      ['p1', report([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, framesPerSecond: 24, packetsLost: 2, jitter: 0.01 }])],
    ])
    const seen: string[][] = []
    const controller = new QualityController(session as unknown as MediaSession, {
      intervalMs: 100,
      onReport: (_r, per) => seen.push([...per.keys()]),
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(seen).toEqual([['p1']])
    session.consumerStats = new Map()
    await vi.advanceTimersByTimeAsync(100)
    expect(seen.at(-1)).toEqual([])
    controller.stop()
  })
})
