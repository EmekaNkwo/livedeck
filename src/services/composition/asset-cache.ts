/**
 * Decoded-asset cache for `image` and `video` sources.
 *
 * Image and video sources are configured with a data URL (from a local file
 * the user picked). Decoding that URL on every frame would be ruinous, so each
 * asset is decoded once into a long-lived element that the compositor samples.
 *
 * The cache is keyed by source id, and entries are released explicitly when a
 * source is removed — the compositor never owns asset lifetime.
 */

export type AssetKind = 'image' | 'video'

export type AssetEntry =
  | { kind: 'image'; element: HTMLImageElement; ready: boolean; error: string | null }
  | { kind: 'video'; element: HTMLVideoElement; ready: boolean; error: string | null }

class AssetCache {
  private readonly entries = new Map<string, AssetEntry>()

  /**
   * Begin decoding an asset for `sourceId`. Idempotent: calling it again with
   * the same url returns the existing entry rather than re-decoding.
   */
  load(sourceId: string, kind: AssetKind, url: string, loop = true): AssetEntry {
    const existing = this.entries.get(sourceId)
    if (existing && currentUrl(existing) === url) return existing
    if (existing) this.release(sourceId)

    const entry: AssetEntry =
      kind === 'image'
        ? { kind: 'image', element: new Image(), ready: false, error: null }
        : { kind: 'video', element: document.createElement('video'), ready: false, error: null }

    if (entry.kind === 'image') {
      entry.element.decoding = 'async'
      entry.element.onload = () => {
        entry.ready = true
      }
      entry.element.onerror = () => {
        entry.error = 'The image could not be decoded.'
      }
      entry.element.src = url
    } else {
      const video = entry.element
      // Muted + playsInline is what lets the element autoplay and therefore
      // produce frames; the audio path goes through the mixer instead.
      video.muted = true
      video.defaultMuted = true
      video.loop = loop
      video.playsInline = true
      video.preload = 'auto'
      video.onloadeddata = () => {
        entry.ready = true
      }
      video.onerror = () => {
        entry.error = 'The video could not be decoded.'
      }
      video.src = url
      void video.play().catch(() => {
        entry.error = 'Playback was blocked by the browser. Interact with the page and retry.'
      })
    }

    this.entries.set(sourceId, entry)
    return entry
  }

  get(sourceId: string): AssetEntry | null {
    return this.entries.get(sourceId) ?? null
  }

  /** Tear down an asset and drop its decoder. */
  release(sourceId: string): void {
    const entry = this.entries.get(sourceId)
    if (!entry) return
    this.entries.delete(sourceId)
    if (entry.kind === 'video') {
      entry.element.pause()
      entry.element.removeAttribute('src')
      entry.element.load()
    } else {
      entry.element.onload = null
      entry.element.onerror = null
      entry.element.removeAttribute('src')
    }
  }

  releaseAll(): void {
    for (const id of [...this.entries.keys()]) this.release(id)
  }

  /** Audio tracks from a local video asset, for the mixer to pick up. */
  captureAudio(sourceId: string): MediaStream | null {
    const entry = this.entries.get(sourceId)
    if (!entry || entry.kind !== 'video') return null
    const element = entry.element as HTMLVideoElement & {
      captureStream?: () => MediaStream
      mozCaptureStream?: () => MediaStream
    }
    const capture = element.captureStream ?? element.mozCaptureStream
    if (typeof capture !== 'function') return null
    try {
      return capture.call(element)
    } catch {
      return null
    }
  }
}

function currentUrl(entry: AssetEntry): string {
  return entry.element.src
}

export const assetCache = new AssetCache()
