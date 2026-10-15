import type { MediaSource } from '@shared/protocol'

/**
 * Sender-side quality parameters per media source.
 *
 * Camera video is sent as three simulcast layers so the SFU can hand each
 * receiver the largest one its downlink affords, and so a twelve-tile grid
 * can pull the small layer for every face but the one on stage. Screen
 * content is one layer with `detail` content hint: text must stay sharp and
 * frame rate may drop.
 */

export type SourceEncoding = {
  encodings: RTCRtpEncodingParameters[]
  codecOptions?: Record<string, number | string | boolean>
  contentHint?: 'motion' | 'detail' | 'text' | ''
  maxBitrateBps: number
}

export const CAMERA_SIMULCAST: RTCRtpEncodingParameters[] = [
  { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 450_000, maxFramerate: 30 },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 30 },
]

export const PROGRAM_SIMULCAST: RTCRtpEncodingParameters[] = [
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 800_000 },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 2_500_000 },
]

export function encodingFor(source: MediaSource): SourceEncoding {
  switch (source) {
    case 'camera':
      return {
        encodings: CAMERA_SIMULCAST,
        codecOptions: { videoGoogleStartBitrate: 600 },
        contentHint: 'motion',
        maxBitrateBps: 1_200_000,
      }
    case 'screen':
      return {
        encodings: [{ maxBitrate: 2_500_000, maxFramerate: 15 }],
        codecOptions: { videoGoogleStartBitrate: 1000 },
        contentHint: 'detail',
        maxBitrateBps: 2_500_000,
      }
    case 'program':
      return {
        encodings: PROGRAM_SIMULCAST,
        codecOptions: { videoGoogleStartBitrate: 1500 },
        contentHint: 'motion',
        maxBitrateBps: 2_500_000,
      }
    case 'mic':
    case 'screen-audio':
    case 'program-audio':
      return {
        encodings: [{ maxBitrate: 96_000 }],
        codecOptions: { opusStereo: source !== 'mic', opusDtx: source === 'mic', opusFec: true },
        maxBitrateBps: 96_000,
      }
  }
}

/** Apply a content hint where the browser supports it. */
export function applyContentHint(track: MediaStreamTrack, hint: SourceEncoding['contentHint']): void {
  if (hint === undefined) return
  if ('contentHint' in track) {
    try {
      track.contentHint = hint
    } catch {
      // Older browsers expose the property read-only; the hint is advisory.
    }
  }
}
