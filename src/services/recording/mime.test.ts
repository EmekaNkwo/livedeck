import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extensionForMimeType,
  listSupportedFormats,
  selectRecordingFormat,
  suggestVideoBitrate,
} from './mime'

/**
 * Format negotiation.
 *
 * The point of these tests is that the recorder adapts to the browser instead
 * of hardcoding WebM — a Safari-shaped environment must still get a usable
 * format, and an environment with no MediaRecorder must report none rather
 * than throwing.
 */

function stubMediaRecorder(supported: string[]): void {
  vi.stubGlobal('MediaRecorder', {
    isTypeSupported: (mimeType: string) => supported.includes(mimeType),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('selectRecordingFormat', () => {
  it('prefers VP9 WebM when available', () => {
    stubMediaRecorder(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    expect(selectRecordingFormat()).toMatchObject({
      mimeType: 'video/webm;codecs=vp9,opus',
      extension: 'webm',
    })
  })

  it('falls back to VP8 when VP9 is unavailable', () => {
    stubMediaRecorder(['video/webm;codecs=vp8,opus', 'video/webm'])
    expect(selectRecordingFormat()?.mimeType).toBe('video/webm;codecs=vp8,opus')
  })

  it('selects MP4 in a Safari-shaped environment that rejects WebM', () => {
    stubMediaRecorder(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'])
    const format = selectRecordingFormat()
    expect(format?.extension).toBe('mp4')
    expect(format?.mimeType).toContain('mp4')
  })

  it('returns null when nothing is supported', () => {
    stubMediaRecorder([])
    expect(selectRecordingFormat()).toBeNull()
  })

  it('returns null when MediaRecorder is absent entirely', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    expect(selectRecordingFormat()).toBeNull()
  })

  it('returns null when isTypeSupported throws', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: () => {
        throw new Error('nope')
      },
    })
    expect(selectRecordingFormat()).toBeNull()
  })

  it('returns null when isTypeSupported is missing', () => {
    vi.stubGlobal('MediaRecorder', {})
    expect(selectRecordingFormat()).toBeNull()
  })
})

describe('listSupportedFormats', () => {
  it('lists every accepted candidate', () => {
    stubMediaRecorder(['video/webm;codecs=vp9,opus', 'video/mp4'])
    const formats = listSupportedFormats()
    expect(formats).toHaveLength(2)
    expect(formats.map((format) => format.extension)).toEqual(['webm', 'mp4'])
  })

  it('is empty when nothing is supported', () => {
    stubMediaRecorder([])
    expect(listSupportedFormats()).toEqual([])
  })
})

describe('extensionForMimeType', () => {
  it('maps known containers', () => {
    expect(extensionForMimeType('video/webm;codecs=vp9,opus')).toBe('webm')
    expect(extensionForMimeType('video/mp4;codecs=avc1')).toBe('mp4')
    expect(extensionForMimeType('video/x-matroska;codecs=avc1')).toBe('mkv')
    expect(extensionForMimeType('video/quicktime')).toBe('mov')
  })

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(extensionForMimeType('VIDEO/WEBM')).toBe('webm')
    expect(extensionForMimeType(' video/mp4 ; codecs=avc1')).toBe('mp4')
  })

  it('derives an extension from an unknown video subtype', () => {
    // The browser is allowed to substitute a type we did not ask for, and the
    // downloaded file must match its real contents.
    expect(extensionForMimeType('video/ogg')).toBe('ogg')
  })

  it('defaults to webm for unrecognised input', () => {
    expect(extensionForMimeType('')).toBe('webm')
    expect(extensionForMimeType('application/octet-stream')).toBe('webm')
  })
})

describe('suggestVideoBitrate', () => {
  it('scales with pixels and frame rate', () => {
    const low = suggestVideoBitrate(640, 360, 30)
    const high = suggestVideoBitrate(1920, 1080, 30)
    expect(high).toBeGreaterThan(low)
    expect(suggestVideoBitrate(1280, 720, 60)).toBeGreaterThan(
      suggestVideoBitrate(1280, 720, 30),
    )
  })

  it('stays within a sane band', () => {
    expect(suggestVideoBitrate(16, 16, 1)).toBeGreaterThanOrEqual(1_000_000)
    expect(suggestVideoBitrate(7680, 4320, 60)).toBeLessThanOrEqual(12_000_000)
  })
})
