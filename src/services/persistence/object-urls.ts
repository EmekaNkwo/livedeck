/**
 * Tracked `createObjectURL` lifetimes.
 *
 * Each object URL pins its Blob in memory until revoked, so a preview that is
 * opened and closed a dozen times would otherwise hold a dozen video files
 * alive. Everything goes through this module so there is one place that
 * guarantees revocation.
 */

const urls = new Map<string, string>()

/**
 * Create (or reuse) an object URL for `key`. Calling it again with the same
 * key revokes the previous URL first, so a replaced blob does not leak.
 */
export function createTrackedUrl(key: string, blob: Blob): string {
  revokeTrackedUrl(key)
  const url = URL.createObjectURL(blob)
  urls.set(key, url)
  return url
}

export function getTrackedUrl(key: string): string | null {
  return urls.get(key) ?? null
}

export function revokeTrackedUrl(key: string): void {
  const url = urls.get(key)
  if (!url) return
  urls.delete(key)
  URL.revokeObjectURL(url)
}

export function revokeAllTrackedUrls(): void {
  for (const key of [...urls.keys()]) revokeTrackedUrl(key)
}

export function trackedUrlCount(): number {
  return urls.size
}

/**
 * Trigger a browser download for a blob.
 *
 * The URL is revoked on a timeout rather than immediately: revoking in the
 * same tick can cancel the download in some browsers before it has read the
 * blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Sanitize a recording name into something a filesystem will accept. */
export function toSafeFilename(name: string, extension: string): string {
  const base =
    name
      .replace(/[^a-z0-9\-_ ]/gi, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'livedeck-recording'
  return `${base}.${extension}`
}
