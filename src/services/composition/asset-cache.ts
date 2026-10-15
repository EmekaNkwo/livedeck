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

import type { AssetRef } from '@/types/source'

export type AssetKind = 'image' | 'video'

/** Identity of what an entry was loaded from, for the idempotence check. */
function refKey(ref: AssetRef): string {
  if (ref.assetId) return `asset:${ref.assetId}`
  if (ref.dataUrl) return ref.dataUrl
  return ''
}

export type AssetEntry =
  | { kind: 'image'; element: HTMLImageElement; ready: boolean; error: string | null; key: string; objectUrl: string | null }
  | {
      kind: 'video'
      element: HTMLVideoElement
      ready: boolean
      error: string | null
      key: string
      objectUrl: string | null
      /**
       * The element's captured audio, created once.
       *
       * `captureStream()` returns a *new* stream on every call, so handing a
       * fresh one to the mixer on each reconcile rebuilt the channel's nodes
       * on every fader move (a click, and a leaked capture each time). One
       * capture per decoded asset, reused for its lifetime.
       */
      audioStream: MediaStream | null
    }

class AssetCache {
  private readonly entries = new Map<string, AssetEntry>()
  private readonly readyListeners = new Set<() => void>()

  /** Called whenever an asset finishes decoding. The compositor repaints on it. */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  private notifyReady(): void {
    for (const listener of this.readyListeners) listener()
  }

  /**
   * Begin decoding an asset for `sourceId`. Idempotent: calling it again with
   * the same url returns the existing entry rather than re-decoding.
   */
  load(sourceId: string, kind: AssetKind, ref: AssetRef, loop = true): AssetEntry {
    const key = refKey(ref)
    const existing = this.entries.get(sourceId)
    if (existing && existing.key === key) return existing
    if (existing) this.release(sourceId)

    const entry: AssetEntry =
      kind === 'image'
        ? { kind: 'image', element: new Image(), ready: false, error: null, key, objectUrl: null }
        : {
            kind: 'video',
            element: document.createElement('video'),
            ready: false,
            error: null,
            key,
            objectUrl: null,
            audioStream: null,
          }
    this.entries.set(sourceId, entry)

    if (!key) {
      entry.error = 'This source has no media file.'
      return entry
    }
    if (ref.dataUrl && !ref.assetId) {
      this.attach(entry, ref.dataUrl, loop)
      return entry
    }
    // An asset id resolves asynchronously; the entry reports `loading` until
    // the blob is read and an object URL exists for it.
    const assetId = ref.assetId as string
    void import('@/services/persistence/asset-store')
      .then(({ getAsset }) => getAsset(assetId))
      .then((asset) => {
        if (this.entries.get(sourceId) !== entry) return
        if (!asset) {
          entry.error = 'The media file is missing from this browser’s storage.'
          return
        }
        entry.objectUrl = URL.createObjectURL(asset.blob)
        this.attach(entry, entry.objectUrl, loop)
      })
      .catch(() => {
        if (this.entries.get(sourceId) === entry) entry.error = 'The media file could not be read.'
      })
    return entry
  }

  private attach(entry: AssetEntry, url: string, loop: boolean): void {
    if (entry.kind === 'image') {
      entry.element.decoding = 'async'
      entry.element.onload = () => {
        entry.ready = true
        this.notifyReady()
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
        this.notifyReady()
      }
      video.onerror = () => {
        entry.error = 'The video could not be decoded.'
      }
      video.src = url
      void video.play().catch(() => {
        entry.error = 'Playback was blocked by the browser. Interact with the page and retry.'
      })
    }
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
      for (const track of entry.audioStream?.getTracks() ?? []) track.stop()
      entry.audioStream = null
    } else {
      entry.element.onload = null
      entry.element.onerror = null
      entry.element.removeAttribute('src')
    }
    if (entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl)
      entry.objectUrl = null
    }
  }

  releaseAll(): void {
    for (const id of [...this.entries.keys()]) this.release(id)
  }

  /** Audio tracks from a local video asset, for the mixer to pick up. Stable per asset. */
  captureAudio(sourceId: string): MediaStream | null {
    const entry = this.entries.get(sourceId)
    if (!entry || entry.kind !== 'video') return null
    if (entry.audioStream) return entry.audioStream
    const element = entry.element as HTMLVideoElement & {
      captureStream?: () => MediaStream
      mozCaptureStream?: () => MediaStream
    }
    const capture = element.captureStream ?? element.mozCaptureStream
    if (typeof capture !== 'function') return null
    try {
      entry.audioStream = capture.call(element)
      return entry.audioStream
    } catch {
      return null
    }
  }
}


export const assetCache = new AssetCache()
