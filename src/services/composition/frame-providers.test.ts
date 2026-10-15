import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaSource, SourceSettings, TextStyle } from '@/types/source'
import { streamRegistry } from '@/services/media/stream-registry'
import { assetCache } from './asset-cache'
import { FRAME_EMPTY_LABEL, intrinsicSize, resolveFrame, type FrameEmptyReason } from './frame-providers'

/**
 * Resolving each source kind into a frame. Media readiness is set on the
 * elements directly, because jsdom never decodes anything.
 */

const IMAGE_URL = 'data:image/png;base64,AAAA'
const VIDEO_URL = 'data:video/mp4;base64,BBBB'

const TEXT_STYLE: TextStyle = {
  fontSize: 32,
  fontFamily: 'sans-serif',
  color: '#fff',
  backgroundColor: null,
  align: 'left',
  bold: false,
}

function source(settings: SourceSettings, streamKey: string | null = null, id = 'src-1'): MediaSource {
  return {
    id,
    name: 'Source',
    type: settings.kind,
    visible: true,
    locked: false,
    muted: false,
    layer: 0,
    settings,
    streamKey,
    volume: 1,
    createdAt: 0,
  }
}

function setMedia(element: HTMLElement, props: Record<string, number>): void {
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(element, name, { configurable: true, value })
  }
}

function videoElement(width: number, height: number, readyState: number): HTMLVideoElement {
  const video = document.createElement('video')
  setMedia(video, { videoWidth: width, videoHeight: height, readyState })
  return video
}

afterEach(() => {
  assetCache.releaseAll()
})

describe('resolveFrame: sources that need no media', () => {
  it('fills a colour background', () => {
    expect(resolveFrame(source({ kind: 'color-background', color: '#123456' }))).toEqual({
      kind: 'fill',
      color: '#123456',
    })
  })

  it('hands text sources to the text painter as-is', () => {
    const text = source({ kind: 'text', text: 'Hello', style: TEXT_STYLE })
    const frame = resolveFrame(text)
    expect(frame.kind).toBe('text')
    expect(frame.kind === 'text' && frame.source).toBe(text)
  })

  it.each([
    { kind: 'microphone', deviceId: null },
    { kind: 'remote-audio', guestId: 'g1' },
  ] satisfies SourceSettings[])('contributes no pixels for $kind', (settings) => {
    expect(resolveFrame(source(settings, 'key'))).toEqual({ kind: 'empty', reason: 'unsupported' })
  })
})

describe('resolveFrame: images', () => {
  const image = () => source({ kind: 'image', fit: 'contain', dataUrl: IMAGE_URL })

  it('is loading until decoded, then drawable at its natural size', () => {
    expect(resolveFrame(image())).toEqual({ kind: 'empty', reason: 'loading' })

    const element = assetCache.get('src-1')!.element
    setMedia(element, { naturalWidth: 400, naturalHeight: 300 })
    element.dispatchEvent(new Event('load'))

    expect(resolveFrame(image())).toEqual({
      kind: 'drawable',
      drawable: element,
      intrinsic: { width: 400, height: 300 },
    })
    expect(intrinsicSize(image())).toEqual({ width: 400, height: 300 })
  })

  it('waits for dimensions when a decoded image reports none', () => {
    resolveFrame(image())
    assetCache.get('src-1')!.element.dispatchEvent(new Event('load'))
    expect(resolveFrame(image())).toEqual({ kind: 'empty', reason: 'no-dimensions' })
    expect(intrinsicSize(image())).toBeNull()
  })

  it('reports a decode error, and a missing file the same way', () => {
    resolveFrame(image())
    assetCache.get('src-1')!.element.dispatchEvent(new Event('error'))
    expect(resolveFrame(image())).toEqual({ kind: 'empty', reason: 'decode-error' })

    expect(resolveFrame(source({ kind: 'image', fit: 'cover' }, null, 'blank'))).toEqual({
      kind: 'empty',
      reason: 'decode-error',
    })
  })
})

describe('resolveFrame: local videos', () => {
  const video = (loop = true) => source({ kind: 'video', loop, fit: 'contain', dataUrl: VIDEO_URL })

  it('passes the loop setting to the decoder', () => {
    resolveFrame(video(false))
    expect((assetCache.get('src-1')!.element as HTMLVideoElement).loop).toBe(false)
  })

  it('is loading until the first frame has loaded', () => {
    expect(resolveFrame(video())).toEqual({ kind: 'empty', reason: 'loading' })
  })

  it('walks through no-dimensions and loading to drawable as the element fills in', () => {
    resolveFrame(video())
    const element = assetCache.get('src-1')!.element
    element.dispatchEvent(new Event('loadeddata'))

    setMedia(element, { videoWidth: 0, videoHeight: 0, readyState: HTMLMediaElement.HAVE_ENOUGH_DATA })
    expect(resolveFrame(video())).toEqual({ kind: 'empty', reason: 'no-dimensions' })

    setMedia(element, { videoWidth: 1920, videoHeight: 0 })
    expect(resolveFrame(video())).toEqual({ kind: 'empty', reason: 'no-dimensions' })

    setMedia(element, { videoHeight: 1080, readyState: HTMLMediaElement.HAVE_METADATA })
    expect(resolveFrame(video())).toEqual({ kind: 'empty', reason: 'loading' })

    setMedia(element, { readyState: HTMLMediaElement.HAVE_CURRENT_DATA })
    expect(resolveFrame(video())).toEqual({
      kind: 'drawable',
      drawable: element,
      intrinsic: { width: 1920, height: 1080 },
    })
    expect(intrinsicSize(video())).toEqual({ width: 1920, height: 1080 })
  })

  it('reports a decode error', () => {
    resolveFrame(video())
    assetCache.get('src-1')!.element.dispatchEvent(new Event('error'))
    expect(resolveFrame(video())).toEqual({ kind: 'empty', reason: 'decode-error' })
  })
})

describe('resolveFrame: live captures', () => {
  it.each([
    { kind: 'camera', deviceId: null, mirrored: false },
    { kind: 'screen', withSystemAudio: false },
    { kind: 'remote-video', guestId: 'g1' },
  ] satisfies SourceSettings[])('resolves $kind through the stream registry', (settings) => {
    const getElement = vi.spyOn(streamRegistry, 'getElement')

    expect(resolveFrame(source(settings, null))).toEqual({ kind: 'empty', reason: 'not-acquired' })
    expect(getElement).not.toHaveBeenCalled()

    getElement.mockReturnValue(null)
    expect(resolveFrame(source(settings, 'key-1'))).toEqual({ kind: 'empty', reason: 'ended' })
    expect(getElement).toHaveBeenCalledWith('key-1')

    getElement.mockReturnValue(videoElement(0, 0, HTMLMediaElement.HAVE_NOTHING))
    expect(resolveFrame(source(settings, 'key-1'))).toEqual({ kind: 'empty', reason: 'no-dimensions' })

    getElement.mockReturnValue(videoElement(1280, 720, HTMLMediaElement.HAVE_METADATA))
    expect(resolveFrame(source(settings, 'key-1'))).toEqual({ kind: 'empty', reason: 'loading' })

    const live = videoElement(1280, 720, HTMLMediaElement.HAVE_ENOUGH_DATA)
    getElement.mockReturnValue(live)
    expect(resolveFrame(source(settings, 'key-1'))).toEqual({
      kind: 'drawable',
      drawable: live,
      intrinsic: { width: 1280, height: 720 },
    })
  })
})

describe('FRAME_EMPTY_LABEL', () => {
  it('has a user-facing label for every empty reason', () => {
    const reasons: FrameEmptyReason[] = ['not-acquired', 'loading', 'ended', 'decode-error', 'no-dimensions', 'unsupported']
    expect(Object.keys(FRAME_EMPTY_LABEL).sort()).toEqual([...reasons].sort())
    for (const reason of reasons) expect(FRAME_EMPTY_LABEL[reason].length).toBeGreaterThan(0)
  })
})
