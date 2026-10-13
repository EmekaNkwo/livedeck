/** Format milliseconds as `MM:SS` or `H:MM:SS` for recordings and timers. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  const value = bytes / 1000 ** exponent
  const decimals = exponent === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(decimals)} ${units[exponent]}`
}

/** Render a dBFS reading, with a floor marker for silence. */
export function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -60) return '-∞ dB'
  const sign = db > 0 ? '+' : ''
  return `${sign}${db.toFixed(1)} dB`
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Format a normalized 0..1 coordinate as a pixel value on the given axis. */
export function formatPixels(normalized: number, extent: number): string {
  return String(Math.round(normalized * extent))
}

export function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatRelativeTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Null-safe metric rendering: never invent a number the browser didn't give. */
export function formatMetric(
  value: number | null | undefined,
  unit: string,
  decimals = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(decimals)} ${unit}`.trim()
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}
