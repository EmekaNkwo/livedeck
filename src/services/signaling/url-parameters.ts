import type { AspectRatioId, FrameRateId, OutputResolutionId } from '@/types/scene'

/**
 * VDO.Ninja-style URL parameters.
 *
 * Configuring a session through the link is one of VDO.Ninja's defining
 * features — you send someone `?quality=720&muted` and their page comes up
 * already set that way. This module parses a documented set and resolves it
 * into real settings; `useUrlParameters` applies them.
 *
 * Every parameter below does something. There are no decorative ones, and
 * unrecognised keys are reported back so a typo surfaces instead of silently
 * doing nothing.
 */

export type ParsedUrlParameters = {
  /** Display name for this participant. */
  label: string | null
  /** Start with the microphone track disabled. */
  startMuted: boolean
  /** Start without requesting a camera at all. */
  noVideo: boolean
  /** Start without requesting a microphone at all. */
  noAudio: boolean
  /** Preferred capture/output short edge, in pixels. */
  quality: OutputResolutionId | null
  /** Preferred frame rate. */
  fps: FrameRateId | null
  /** Program aspect ratio. */
  ratio: AspectRatioId | null
  /** Hide all interface chrome — used by the scene output view. */
  cleanOutput: boolean
  /** Mirror the local camera preview. */
  mirror: boolean
  /** Auto-start capture without waiting for a click, where permitted. */
  autoStart: boolean
  /** Index of the scene to show on load (scene views). */
  scene: number | null
  /** A room key, granting the director or producer role on join. */
  key: string | null
  /** Keys present in the URL that this build does not understand. */
  unknown: string[]
}

export const DEFAULT_URL_PARAMETERS: ParsedUrlParameters = {
  label: null,
  startMuted: false,
  noVideo: false,
  noAudio: false,
  quality: null,
  fps: null,
  ratio: null,
  cleanOutput: false,
  mirror: false,
  autoStart: false,
  scene: null,
  key: null,
  unknown: [],
}

/**
 * Documentation for the in-app cheat sheet.
 *
 * Generated from one list so the help can never drift from the parser.
 */
export type ParameterDoc = {
  keys: string[]
  value: string | null
  description: string
  roles: string
}

export const PARAMETER_DOCS: ParameterDoc[] = [
  {
    keys: ['label', 'name'],
    value: 'text',
    description: 'Display name for the participant or output.',
    roles: 'guest, director',
  },
  {
    keys: ['muted', 'mute'],
    value: null,
    description: 'Join with the microphone track disabled. Nothing is captured until unmuted.',
    roles: 'guest',
  },
  {
    keys: ['novideo'],
    value: null,
    description: 'Do not request a camera at all — audio-only guest.',
    roles: 'guest',
  },
  {
    keys: ['noaudio'],
    value: null,
    description: 'Do not request a microphone at all — video-only guest.',
    roles: 'guest',
  },
  {
    keys: ['quality'],
    value: '480 | 720 | 1080',
    description: 'Preferred short-edge resolution for capture and program output.',
    roles: 'all',
  },
  {
    keys: ['fps', 'framerate'],
    value: '24 | 30 | 60',
    description: 'Preferred frame rate for capture and recording.',
    roles: 'all',
  },
  {
    keys: ['ratio', 'aspect'],
    value: '16:9 | 9:16 | 1:1 | 4:3',
    description: 'Program canvas aspect ratio.',
    roles: 'director, scene',
  },
  {
    keys: ['cleanoutput', 'clean'],
    value: null,
    description: 'Hide every interface element. Already implied by the scene view.',
    roles: 'scene, solo',
  },
  {
    keys: ['mirror'],
    value: null,
    description: 'Mirror the local camera preview (does not affect what others see).',
    roles: 'guest',
  },
  {
    keys: ['autostart', 'autojoin'],
    value: null,
    description:
      'Request the camera immediately on load. Browsers may still require a click before audio can start.',
    roles: 'guest',
  },
  {
    keys: ['scene'],
    value: 'number',
    description: 'Which scene to show on load, by position in the scene list (0-based).',
    roles: 'scene',
  },
  {
    keys: ['key'],
    value: 'text',
    description:
      'A room key issued by the server. The producer key grants guest control; the director key grants the control room.',
    roles: 'guest, director',
  },
]

/** Every key the parser accepts, for unknown-key detection. */
const KNOWN_KEYS = new Set(PARAMETER_DOCS.flatMap((doc) => doc.keys))

/**
 * A valueless flag.
 *
 * VDO.Ninja writes flags bare (`&muted`), which `URLSearchParams` surfaces as
 * an empty string. `&muted=false` and `&muted=0` are also honoured, because
 * people reasonably expect them to work.
 */
function readFlag(params: URLSearchParams, ...keys: string[]): boolean {
  for (const key of keys) {
    if (!params.has(key)) continue
    const value = (params.get(key) ?? '').trim().toLowerCase()
    if (value === '' || value === '1' || value === 'true' || value === 'yes') return true
    if (value === '0' || value === 'false' || value === 'no') return false
    return true
  }
  return false
}

function readText(params: URLSearchParams, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params.get(key)
    if (value !== null && value.trim()) return value.trim().slice(0, 60)
  }
  return null
}

function readQuality(params: URLSearchParams): OutputResolutionId | null {
  const raw = readText(params, 'quality')
  if (!raw) return null
  // Accept both "720" and "720p".
  switch (raw.replace(/p$/i, '')) {
    case '480':
      return '480p'
    case '720':
      return '720p'
    case '1080':
      return '1080p'
    default:
      return null
  }
}

function readFps(params: URLSearchParams): FrameRateId | null {
  const raw = readText(params, 'fps', 'framerate')
  if (!raw) return null
  const value = Number(raw)
  return value === 24 || value === 30 || value === 60 ? value : null
}

function readRatio(params: URLSearchParams): AspectRatioId | null {
  const raw = readText(params, 'ratio', 'aspect')
  if (!raw) return null
  // Tolerate "16x9" and "16-9" as well as "16:9".
  const normalized = raw.replace(/[x\-_]/g, ':')
  switch (normalized) {
    case '16:9':
    case '9:16':
    case '1:1':
    case '4:3':
      return normalized
    default:
      return null
  }
}

function readScene(params: URLSearchParams): number | null {
  const raw = readText(params, 'scene')
  if (raw === null) return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : null
}

function readKey(params: URLSearchParams): string | null {
  const raw = params.get('key')
  if (raw === null) return null
  const value = raw.trim()
  return value && value.length <= 128 ? value : null
}

/** Parse a query string into resolved parameters. */
export function parseUrlParameters(search: string): ParsedUrlParameters {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)

  const unknown: string[] = []
  for (const key of params.keys()) {
    if (!KNOWN_KEYS.has(key.toLowerCase())) unknown.push(key)
  }

  return {
    label: readText(params, 'label', 'name'),
    startMuted: readFlag(params, 'muted', 'mute'),
    noVideo: readFlag(params, 'novideo'),
    noAudio: readFlag(params, 'noaudio'),
    quality: readQuality(params),
    fps: readFps(params),
    ratio: readRatio(params),
    cleanOutput: readFlag(params, 'cleanoutput', 'clean'),
    mirror: readFlag(params, 'mirror'),
    autoStart: readFlag(params, 'autostart', 'autojoin'),
    scene: readScene(params),
    key: readKey(params),
    // De-duplicated so a repeated key is reported once.
    unknown: [...new Set(unknown)],
  }
}

/** Build a query string from parameters — used when generating invite links. */
export function buildParameterQuery(options: {
  label?: string | null
  startMuted?: boolean
  noVideo?: boolean
  noAudio?: boolean
  quality?: OutputResolutionId | null
  fps?: FrameRateId | null
  key?: string | null
}): Record<string, string> {
  const query: Record<string, string> = {}
  if (options.label) query.label = options.label
  if (options.key) query.key = options.key
  // Bare flags, matching the convention people are used to reading.
  if (options.startMuted) query.muted = ''
  if (options.noVideo) query.novideo = ''
  if (options.noAudio) query.noaudio = ''
  if (options.quality) query.quality = options.quality.replace('p', '')
  if (options.fps) query.fps = String(options.fps)
  return query
}
