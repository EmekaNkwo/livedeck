import type { TrackSnapshot } from '@/types/media'

/**
 * Reference-counted ownership for live MediaStreams.
 *
 * WHY THIS EXISTS
 * ---------------
 * A single capture (one camera, one screen share) can be referenced by several
 * studio sources, several scenes, a preview `<video>` element and the
 * compositor at the same time. If any one of those consumers stopped the
 * tracks on unmount, it would kill the capture for everyone else — the classic
 * "my camera went black when I closed the inspector" bug.
 *
 * So no component and no hook ever calls `track.stop()` directly. Instead,
 * every consumer `retain()`s a key and `release()`s it on cleanup, and the
 * registry stops the tracks only when the last reference goes away.
 *
 * The registry also owns one hidden `<video>` element per video stream. The
 * compositor draws from that element, which means scene rendering is decoupled
 * from whatever the UI happens to be mounting.
 */

export type StreamEndReason = 'ended' | 'released' | 'replaced' | 'disposed'

export type StreamRegistryEntry = {
  key: string
  stream: MediaStream
  /** Hidden element the compositor draws from; null for audio-only streams. */
  element: HTMLVideoElement | null
  refCount: number
  createdAt: number
}

export type StreamEndedListener = (key: string, reason: StreamEndReason) => void

type InternalEntry = StreamRegistryEntry & {
  /** Detach the `ended` listeners we attached to this stream's tracks. */
  detachTrackListeners: () => void
}

export class StreamRegistry {
  private readonly entries = new Map<string, InternalEntry>()
  private readonly endedListeners = new Set<StreamEndedListener>()

  /**
   * Register a stream under `key` with an initial reference count of 1.
   * Registering over an existing key disposes the previous stream first, which
   * is what a device switch does.
   */
  register(key: string, stream: MediaStream): StreamRegistryEntry {
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.stream === stream) {
        existing.refCount += 1
        return this.toPublic(existing)
      }
      this.dispose(key, 'replaced')
    }

    const element = stream.getVideoTracks().length > 0 ? createHiddenVideo(stream) : null
    const entry: InternalEntry = {
      key,
      stream,
      element,
      refCount: 1,
      createdAt: Date.now(),
      detachTrackListeners: () => {},
    }
    entry.detachTrackListeners = this.attachTrackListeners(key, stream)
    this.entries.set(key, entry)
    return this.toPublic(entry)
  }

  /** Add a reference. Returns null when the key is unknown. */
  retain(key: string): StreamRegistryEntry | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    entry.refCount += 1
    return this.toPublic(entry)
  }

  /**
   * Drop a reference. When the count reaches zero the tracks are stopped and
   * the entry is removed. Releasing an unknown key is a no-op, so cleanup
   * functions are always safe to call twice.
   */
  release(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    this.dispose(key, 'released')
  }

  get(key: string): StreamRegistryEntry | null {
    const entry = this.entries.get(key)
    return entry ? this.toPublic(entry) : null
  }

  getStream(key: string): MediaStream | null {
    return this.entries.get(key)?.stream ?? null
  }

  /** The element the compositor should draw, if this stream has video. */
  getElement(key: string): HTMLVideoElement | null {
    return this.entries.get(key)?.element ?? null
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  refCount(key: string): number {
    return this.entries.get(key)?.refCount ?? 0
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  /**
   * Stop and forget a stream regardless of its reference count.
   * Used when a track genuinely ended (user hit "Stop sharing") and when a
   * session is torn down.
   */
  dispose(key: string, reason: StreamEndReason = 'disposed'): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    entry.detachTrackListeners()
    if (entry.element) {
      entry.element.pause()
      entry.element.srcObject = null
      entry.element.remove()
    }
    for (const track of entry.stream.getTracks()) {
      try {
        track.stop()
      } catch {
        // A track can already be stopped by the browser (device unplugged);
        // stopping it again is harmless and must not break teardown.
      }
    }
    this.emitEnded(key, reason)
  }

  /** Tear down every stream. Called when a production session ends. */
  disposeAll(): void {
    for (const key of this.keys()) this.dispose(key, 'disposed')
  }

  onStreamEnded(listener: StreamEndedListener): () => void {
    this.endedListeners.add(listener)
    return () => {
      this.endedListeners.delete(listener)
    }
  }

  /** Observable track facts for the diagnostics panel. */
  snapshotTracks(key: string): TrackSnapshot[] {
    const entry = this.entries.get(key)
    if (!entry) return []
    return entry.stream.getTracks().map(toTrackSnapshot)
  }

  snapshotAllTracks(): Array<{ key: string; tracks: TrackSnapshot[] }> {
    return this.keys().map((key) => ({ key, tracks: this.snapshotTracks(key) }))
  }

  private attachTrackListeners(key: string, stream: MediaStream): () => void {
    const cleanups: Array<() => void> = []
    for (const track of stream.getTracks()) {
      const onEnded = () => {
        // The browser ended this track on its own: the user pressed the native
        // "Stop sharing" button, or the device was unplugged. Tear the whole
        // entry down and let listeners update application state. This is the
        // path that keeps the UI honest about what is actually live.
        this.dispose(key, 'ended')
      }
      track.addEventListener('ended', onEnded)
      cleanups.push(() => track.removeEventListener('ended', onEnded))
    }
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }

  private emitEnded(key: string, reason: StreamEndReason): void {
    for (const listener of [...this.endedListeners]) {
      try {
        listener(key, reason)
      } catch {
        // One bad listener must not abort teardown of the rest.
      }
    }
  }

  private toPublic(entry: InternalEntry): StreamRegistryEntry {
    return {
      key: entry.key,
      stream: entry.stream,
      element: entry.element,
      refCount: entry.refCount,
      createdAt: entry.createdAt,
    }
  }
}

/**
 * Create the offscreen `<video>` the compositor samples.
 *
 * It must be muted (otherwise autoplay is blocked and the element never
 * produces frames) and `playsInline` (otherwise iOS Safari takes it
 * fullscreen). It is attached to the document but kept visually hidden,
 * because some browsers refuse to decode frames for fully detached elements.
 */
function createHiddenVideo(stream: MediaStream): HTMLVideoElement {
  const element = document.createElement('video')
  element.srcObject = stream
  element.muted = true
  element.defaultMuted = true
  element.autoplay = true
  element.playsInline = true
  element.setAttribute('aria-hidden', 'true')
  element.style.position = 'fixed'
  element.style.width = '1px'
  element.style.height = '1px'
  element.style.opacity = '0'
  element.style.pointerEvents = 'none'
  element.style.left = '-10px'
  element.style.top = '-10px'
  document.body.appendChild(element)
  void element.play().catch(() => {
    // Autoplay can still be refused in exotic configurations. The compositor
    // tolerates a non-playing element by skipping its draw, and `useCamera`
    // surfaces a retry, so swallowing here is intentional.
  })
  return element
}

export function toTrackSnapshot(track: MediaStreamTrack): TrackSnapshot {
  const settings = track.getSettings()
  return {
    id: track.id,
    kind: track.kind === 'audio' ? 'audio' : 'video',
    label: track.label || `${track.kind} track`,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings: {
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      deviceId: settings.deviceId,
      sampleRate: (settings as MediaTrackSettings & { sampleRate?: number }).sampleRate,
    },
  }
}

/** Process-wide registry. One capture graph per document. */
export const streamRegistry = new StreamRegistry()
