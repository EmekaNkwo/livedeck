import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatDb,
  formatDuration,
  formatMetric,
  formatPercent,
  formatRelativeTime,
  truncateMiddle,
} from './format'

describe('formatDuration', () => {
  it('formats under an hour as MM:SS', () => {
    expect(formatDuration(0)).toBe('00:00')
    expect(formatDuration(5_000)).toBe('00:05')
    expect(formatDuration(272_000)).toBe('04:32')
    expect(formatDuration(3_599_000)).toBe('59:59')
  })

  it('adds hours past the hour mark', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(7_265_000)).toBe('2:01:05')
  })

  it('degrades safely on invalid input', () => {
    expect(formatDuration(-1)).toBe('00:00')
    expect(formatDuration(Number.NaN)).toBe('00:00')
  })
})

describe('formatBytes', () => {
  it('uses decimal units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1_500)).toBe('1.5 KB')
    expect(formatBytes(48_300_000)).toBe('48.3 MB')
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB')
  })

  it('drops decimals for large mantissas', () => {
    expect(formatBytes(150_000_000)).toBe('150 MB')
  })

  it('handles invalid input', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatDb', () => {
  it('marks the silence floor rather than printing -60', () => {
    expect(formatDb(-60)).toBe('-∞ dB')
    expect(formatDb(-1000)).toBe('-∞ dB')
  })

  it('signs positive values', () => {
    expect(formatDb(0)).toBe('0.0 dB')
    expect(formatDb(3.25)).toBe('+3.3 dB')
    expect(formatDb(-12.5)).toBe('-12.5 dB')
  })
})

describe('formatMetric', () => {
  it('renders a dash for anything the browser did not report', () => {
    // This is what keeps the diagnostics panel from inventing numbers.
    expect(formatMetric(null, 'ms')).toBe('—')
    expect(formatMetric(undefined, 'ms')).toBe('—')
    expect(formatMetric(Number.NaN, 'ms')).toBe('—')
    expect(formatMetric(Number.POSITIVE_INFINITY, 'ms')).toBe('—')
  })

  it('formats real values with a unit', () => {
    expect(formatMetric(42, 'kbps')).toBe('42 kbps')
    expect(formatMetric(12.345, 'ms', 2)).toBe('12.35 ms')
  })

  it('omits a trailing space for a unitless metric', () => {
    expect(formatMetric(7, '')).toBe('7')
  })

  it('renders a real zero rather than a dash', () => {
    expect(formatMetric(0, 'ms')).toBe('0 ms')
  })
})

describe('formatPercent', () => {
  it('rounds to whole percent', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(1.5)).toBe('150%')
  })
})

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000

  it('describes recent and older timestamps', () => {
    expect(formatRelativeTime(now, now)).toBe('just now')
    expect(formatRelativeTime(now - 90_000, now)).toBe('1m ago')
    expect(formatRelativeTime(now - 3_600_000 * 5, now)).toBe('5h ago')
    expect(formatRelativeTime(now - 86_400_000 * 3, now)).toBe('3d ago')
  })

  it('clamps future timestamps', () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe('just now')
  })
})

describe('truncateMiddle', () => {
  it('leaves short text alone', () => {
    expect(truncateMiddle('short', 20)).toBe('short')
  })

  it('elides the middle of long text', () => {
    const result = truncateMiddle('abcdefghijklmnopqrstuvwxyz', 11)
    expect(result).toHaveLength(11)
    expect(result).toContain('…')
    expect(result.startsWith('abcde')).toBe(true)
    expect(result.endsWith('vwxyz')).toBe(true)
  })
})
