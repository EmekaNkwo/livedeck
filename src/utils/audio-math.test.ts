import { describe, expect, it } from 'vitest'
import { METER_FLOOR_DB } from '@/types/audio'
import {
  analyseTimeDomain,
  dbToLinear,
  dbToMeterFill,
  linearToDb,
  resolveGain,
  smoothMeter,
} from './audio-math'

describe('dB conversion', () => {
  it('maps 0 dB to unity gain', () => {
    expect(dbToLinear(0)).toBeCloseTo(1)
    expect(linearToDb(1)).toBeCloseTo(0)
  })

  it('maps -6 dB to roughly half amplitude', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2)
  })

  it('floors silence rather than returning -Infinity', () => {
    // -Infinity would propagate into the meter fill and the UI.
    expect(linearToDb(0)).toBe(METER_FLOOR_DB)
    expect(linearToDb(-1)).toBe(METER_FLOOR_DB)
  })

  it('round-trips', () => {
    for (const db of [-40, -20, -6, 0, 6]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 5)
    }
  })
})

describe('analyseTimeDomain', () => {
  it('reports silence for an empty signal', () => {
    const level = analyseTimeDomain(new Float32Array(128))
    expect(level.rms).toBe(0)
    expect(level.peak).toBe(0)
    expect(level.db).toBe(METER_FLOOR_DB)
    expect(level.clipping).toBe(false)
  })

  it('computes RMS of a full-scale square wave as 1', () => {
    const buffer = new Float32Array(100).fill(1)
    const level = analyseTimeDomain(buffer)
    expect(level.rms).toBeCloseTo(1)
    expect(level.peak).toBeCloseTo(1)
    expect(level.clipping).toBe(true)
  })

  it('computes RMS of a sine wave as about 0.707 of its peak', () => {
    const buffer = new Float32Array(1024)
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = Math.sin((i / buffer.length) * Math.PI * 2 * 4)
    }
    const level = analyseTimeDomain(buffer)
    expect(level.rms).toBeCloseTo(Math.SQRT1_2, 2)
    expect(level.peak).toBeCloseTo(1, 1)
  })

  it('takes the magnitude of negative peaks', () => {
    const buffer = new Float32Array([0, -0.8, 0.2, -0.3])
    expect(analyseTimeDomain(buffer).peak).toBeCloseTo(0.8)
  })

  it('does not flag clipping below full scale', () => {
    const buffer = new Float32Array(64).fill(0.5)
    expect(analyseTimeDomain(buffer).clipping).toBe(false)
  })

  it('clamps out-of-range samples', () => {
    const buffer = new Float32Array([5, -5])
    const level = analyseTimeDomain(buffer)
    expect(level.rms).toBeLessThanOrEqual(1)
    expect(level.peak).toBeLessThanOrEqual(1)
  })
})

describe('dbToMeterFill', () => {
  it('is empty at the floor and full at 0 dBFS', () => {
    expect(dbToMeterFill(METER_FLOOR_DB)).toBe(0)
    expect(dbToMeterFill(-100)).toBe(0)
    expect(dbToMeterFill(0)).toBeCloseTo(1)
  })

  it('increases monotonically', () => {
    let previous = -1
    for (const db of [-60, -48, -36, -24, -18, -12, -6, 0]) {
      const fill = dbToMeterFill(db)
      expect(fill).toBeGreaterThan(previous)
      previous = fill
    }
  })

  it('gives usable resolution in the normal speech range', () => {
    // A linear dB mapping would squash -18 dB down near 0.3; the broadcast
    // curve has to leave the useful range readable.
    expect(dbToMeterFill(-18)).toBeGreaterThan(0.4)
  })

  it('stays within bounds above full scale', () => {
    expect(dbToMeterFill(12)).toBeLessThanOrEqual(1)
  })
})

describe('smoothMeter', () => {
  it('rises instantly so transients are visible', () => {
    expect(smoothMeter(0.1, 0.9)).toBe(0.9)
  })

  it('falls gradually like a physical meter', () => {
    const next = smoothMeter(0.9, 0.1)
    expect(next).toBeLessThan(0.9)
    expect(next).toBeGreaterThan(0.1)
  })

  it('converges towards the target over repeated falls', () => {
    let value = 1
    for (let i = 0; i < 60; i += 1) value = smoothMeter(value, 0)
    expect(value).toBeLessThan(0.01)
  })
})

describe('resolveGain', () => {
  it('returns zero when muted, regardless of fader and trim', () => {
    // Mute has to be absolute: this is what keeps a muted channel out of the
    // recording even with makeup gain applied.
    expect(resolveGain(1.5, 12, true)).toBe(0)
  })

  it('passes unity through', () => {
    expect(resolveGain(1, 0, false)).toBeCloseTo(1)
  })

  it('applies the fader linearly and the trim in dB', () => {
    expect(resolveGain(0.5, 0, false)).toBeCloseTo(0.5)
    expect(resolveGain(1, 6, false)).toBeCloseTo(dbToLinear(6))
  })

  it('clamps the combined gain so it cannot blow out the mix', () => {
    expect(resolveGain(10, 48, false)).toBeLessThanOrEqual(4)
  })

  it('clamps a negative fader to silence', () => {
    expect(resolveGain(-1, 0, false)).toBe(0)
  })
})
