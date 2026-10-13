import type { AudioLevel } from '@/types/audio'
import { METER_FLOOR_DB } from '@/types/audio'
import { clamp } from './geometry'

export function dbToLinear(db: number): number {
  return 10 ** (db / 20)
}

export function linearToDb(linear: number): number {
  if (linear <= 0) return METER_FLOOR_DB
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(linear))
}

/**
 * Compute RMS and peak from a time-domain buffer of floats in [-1, 1].
 * `AnalyserNode.getFloatTimeDomainData` fills exactly this shape.
 */
export function analyseTimeDomain(buffer: Float32Array): AudioLevel {
  let sumSquares = 0
  let peak = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i] ?? 0
    sumSquares += sample * sample
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
  }
  const rms = buffer.length > 0 ? Math.sqrt(sumSquares / buffer.length) : 0
  return {
    rms: clamp(rms, 0, 1),
    peak: clamp(peak, 0, 1),
    db: linearToDb(rms),
    // Digital full scale. Real clipping happens at 1.0; 0.99 catches it a hair
    // early, which is what a hardware meter's clip LED does too.
    clipping: peak >= 0.99,
  }
}

/**
 * Map a dBFS reading to a 0..1 meter fill.
 *
 * A linear dB mapping wastes most of the meter on inaudible levels, so this
 * uses the same convention as broadcast meters: the bottom of the scale is the
 * floor, and the curve is expanded near 0 dBFS where the user actually needs
 * resolution.
 */
export function dbToMeterFill(db: number): number {
  if (db <= METER_FLOOR_DB) return 0
  const normalized = (db - METER_FLOOR_DB) / -METER_FLOOR_DB
  return clamp(normalized ** 0.6, 0, 1)
}

/**
 * Smooth a meter value so it rises instantly but falls gradually, which is how
 * a physical VU meter behaves and keeps fast transients readable.
 */
export function smoothMeter(previous: number, next: number, fallRate = 0.22): number {
  if (next >= previous) return next
  return previous + (next - previous) * fallRate
}

/** Combined fader + gain, expressed as a linear multiplier for a GainNode. */
export function resolveGain(volume: number, gainDb: number, mutedInMix: boolean): number {
  if (mutedInMix) return 0
  // Clamp hard: an unbounded multiplier here could blow out the recording and,
  // with monitoring enabled, the user's speakers.
  return clamp(clamp(volume, 0, 1.5) * dbToLinear(clamp(gainDb, -24, 24)), 0, 4)
}
