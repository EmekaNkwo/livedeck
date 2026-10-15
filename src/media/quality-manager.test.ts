import { describe, expect, it } from 'vitest'
import {
  INITIAL_TIER,
  StatsReducer,
  THRESHOLDS,
  classify,
  decideTier,
  type QualitySample,
  type TierState,
} from './quality-manager'

const good: QualitySample = { packetLoss: 0, roundTripTimeMs: 50, jitterMs: 5, framesDropped: 0, availableBitrateBps: 2_000_000 }
const bad: QualitySample = { packetLoss: 0.2, roundTripTimeMs: 50, jitterMs: 5, framesDropped: 0, availableBitrateBps: null }
const neutral: QualitySample = { packetLoss: 0.03, roundTripTimeMs: 300, jitterMs: 40, framesDropped: 0, availableBitrateBps: null }
const unknown: QualitySample = { packetLoss: null, roundTripTimeMs: null, jitterMs: null, framesDropped: null, availableBitrateBps: null }

describe('classify', () => {
  it('flags loss, RTT or jitter beyond the bad threshold', () => {
    expect(classify(bad)).toBe('bad')
    expect(classify({ ...good, roundTripTimeMs: 500 })).toBe('bad')
    expect(classify({ ...good, jitterMs: 80 })).toBe('bad')
  })
  it('treats unknowns as good, and in-between as neutral', () => {
    expect(classify(unknown)).toBe('good')
    expect(classify(neutral)).toBe('neutral')
  })
})

describe('decideTier', () => {
  it('does not react to a single bad sample', () => {
    const next = decideTier(INITIAL_TIER, bad)
    expect(next.tier).toBe(2)
    expect(next.bad).toBe(1)
  })

  it('steps down after consecutive bad samples, one tier at a time', () => {
    let state = INITIAL_TIER
    for (let i = 0; i < THRESHOLDS.stepDownAfter; i += 1) state = decideTier(state, bad)
    expect(state.tier).toBe(1)
    for (let i = 0; i < THRESHOLDS.stepDownAfter; i += 1) state = decideTier(state, bad)
    expect(state.tier).toBe(0)
    for (let i = 0; i < THRESHOLDS.stepDownAfter; i += 1) state = decideTier(state, bad)
    expect(state.tier).toBe(0)
  })

  it('needs many good samples before stepping back up', () => {
    let state: TierState = { tier: 0, bad: 0, good: 0 }
    for (let i = 0; i < THRESHOLDS.stepUpAfter - 1; i += 1) state = decideTier(state, good)
    expect(state.tier).toBe(0)
    state = decideTier(state, good)
    expect(state.tier).toBe(1)
  })

  it('resets the opposite streak so quality cannot oscillate', () => {
    let state = INITIAL_TIER
    state = decideTier(state, bad)
    state = decideTier(state, bad)
    state = decideTier(state, good)
    expect(state.bad).toBe(0)
    state = decideTier(state, bad)
    state = decideTier(state, bad)
    expect(state.tier).toBe(2)
  })

  it('lets neutral samples slowly forgive a bad streak', () => {
    let state: TierState = { tier: 2, bad: 2, good: 0 }
    state = decideTier(state, neutral)
    expect(state.bad).toBe(1)
  })
})

describe('StatsReducer', () => {
  const report = (entries: Record<string, unknown>[]): RTCStatsReport =>
    ({
      forEach: (fn: (value: Record<string, unknown>) => void) => entries.forEach(fn),
    }) as unknown as RTCStatsReport

  it('computes per-interval loss and bitrate from cumulative counters', () => {
    const reducer = new StatsReducer()
    const first = reducer.reduce(
      report([{ type: 'inbound-rtp', packetsLost: 10, packetsReceived: 990, bytesReceived: 100_000, jitter: 0.01 }]),
      1000,
    )
    expect(first.packetLoss).toBeNull()
    expect(first.jitterMs).toBe(10)
    const second = reducer.reduce(
      report([
        { type: 'inbound-rtp', packetsLost: 20, packetsReceived: 1980, bytesReceived: 200_000, jitter: 0.01 },
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.12 },
      ]),
      2000,
    )
    expect(second.packetLoss).toBeCloseTo(10 / 1000, 5)
    expect(second.bitrateBps).toBe(800_000)
    expect(second.roundTripTimeMs).toBe(120)
  })
})
