import type { RecordingFormat } from '@/types/recording'

/**
 * Container / codec negotiation for MediaRecorder.
 *
 * Browser support is genuinely divergent: Chrome and Firefox prefer WebM
 * (VP9/VP8 + Opus), Safari only produces MP4 (H.264 + AAC) and rejects WebM
 * outright. Hardcoding one type would make the recorder fail on a whole
 * browser family, so the list is probed in preference order with
 * `isTypeSupported` and the first accepted entry wins.
 */

type Candidate = { mimeType: string; extension: string; label: string }

const CANDIDATES: Candidate[] = [
  // VP9 is the best quality-per-bit of the widely supported codecs.
  { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm', label: 'WebM · VP9 + Opus' },
  { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm', label: 'WebM · VP8 + Opus' },
  { mimeType: 'video/webm;codecs=h264,opus', extension: 'webm', label: 'WebM · H.264 + Opus' },
  { mimeType: 'video/webm', extension: 'webm', label: 'WebM' },
  // Safari path. avc1.42E01E = H.264 baseline, mp4a.40.2 = AAC-LC.
  {
    mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    extension: 'mp4',
    label: 'MP4 · H.264 + AAC',
  },
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4', label: 'MP4 · H.264 + AAC' },
  { mimeType: 'video/mp4', extension: 'mp4', label: 'MP4' },
]

function isSupported(mimeType: string): boolean {
  if (typeof MediaRecorder === 'undefined') return false
  // isTypeSupported itself is missing on a few older builds; assume no.
  if (typeof MediaRecorder.isTypeSupported !== 'function') return false
  try {
    return MediaRecorder.isTypeSupported(mimeType)
  } catch {
    return false
  }
}

/** The best format this browser accepts, or null if none. */
export function selectRecordingFormat(): RecordingFormat | null {
  for (const candidate of CANDIDATES) {
    if (isSupported(candidate.mimeType)) {
      return { mimeType: candidate.mimeType, extension: candidate.extension, label: candidate.label }
    }
  }
  return null
}

/** Every format this browser accepts — shown in the diagnostics panel. */
export function listSupportedFormats(): RecordingFormat[] {
  return CANDIDATES.filter((candidate) => isSupported(candidate.mimeType)).map((candidate) => ({
    mimeType: candidate.mimeType,
    extension: candidate.extension,
    label: candidate.label,
  }))
}

/**
 * Derive the file extension from whatever MIME type the recorder actually
 * produced. The recorder can report a *different* type than requested, and the
 * downloaded file has to match its real contents or players will refuse it.
 */
export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  switch (base) {
    case 'video/mp4':
      return 'mp4'
    case 'video/x-matroska':
      return 'mkv'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    default:
      return base.startsWith('video/') ? base.slice('video/'.length) : 'webm'
  }
}

/**
 * Choose a video bitrate for the output size and frame rate.
 *
 * Roughly 0.1 bits per pixel per frame, which is a reasonable quality target
 * for screen-and-camera content, clamped to a sane band so a 60fps 1080p
 * recording does not produce an unmanageable file.
 */
export function suggestVideoBitrate(width: number, height: number, frameRate: number): number {
  const raw = width * height * frameRate * 0.1
  return Math.round(Math.min(12_000_000, Math.max(1_000_000, raw)))
}

export const AUDIO_BITRATE = 128_000
