import { z } from 'zod'

/**
 * Schemas for everything read back from storage.
 *
 * localStorage and IndexedDB are external input: another tab, an older
 * build, a hand edit or a half-written record can all put something there
 * that the type system believes in and the runtime cannot handle. Every
 * persisted shape is validated here before it reaches a store, and a record
 * that fails is discarded with a report rather than crashing the studio on
 * open.
 *
 * Validation is deliberately *loose* where the shape is open-ended (source
 * settings carry per-kind fields) and strict where a bad value crashes a
 * renderer (numbers in a transform, ids that must be strings).
 */

const id = z.string().min(1).max(128)
const finite = z.number().finite()

export const TransformSchema = z
  .object({
    x: finite,
    y: finite,
    width: finite,
    height: finite,
    rotation: finite.optional(),
    crop: z
      .object({ top: finite, right: finite, bottom: finite, left: finite })
      .partial()
      .optional(),
  })
  .passthrough()

export const SceneItemSchema = z
  .object({
    sourceId: id,
    transform: TransformSchema,
    visible: z.boolean(),
    locked: z.boolean(),
    layer: finite,
    mirrored: z.boolean().optional().default(false),
    opacity: finite.min(0).max(1).optional().default(1),
  })
  .passthrough()

export const SceneSchema = z
  .object({
    id,
    name: z.string().max(200),
    order: finite,
    transition: z
      .object({ type: z.enum(['cut', 'fade', 'crossfade']), durationMs: finite.min(0) })
      .passthrough(),
    items: z.array(SceneItemSchema),
    createdAt: finite,
  })
  .passthrough()

const SourceSettingsSchema = z
  .object({
    kind: z.enum([
      'camera',
      'microphone',
      'screen',
      'remote-video',
      'remote-audio',
      'image',
      'video',
      'text',
      'color-background',
    ]),
  })
  .passthrough()

export const MediaSourceSchema = z
  .object({
    id,
    name: z.string().max(200),
    type: z.enum([
      'camera',
      'microphone',
      'screen',
      'remote-video',
      'remote-audio',
      'image',
      'video',
      'text',
      'color-background',
    ]),
    visible: z.boolean(),
    locked: z.boolean(),
    muted: z.boolean(),
    layer: finite,
    settings: SourceSettingsSchema,
    streamKey: z.string().nullable(),
    volume: finite.min(0).max(2),
    createdAt: finite,
  })
  .passthrough()

export const GuestSchema = z
  .object({
    id,
    name: z.string().max(200),
    videoHidden: z.boolean(),
    mutedInMix: z.boolean(),
    peerId: z.string().nullable(),
    createdAt: finite,
  })
  .passthrough()

export const AudioChannelSchema = z
  .object({
    id,
    sourceId: id,
    kind: z.enum(['host-mic', 'guest', 'display', 'media']),
    label: z.string().max(200),
    volume: finite.min(0).max(2),
    gainDb: finite.min(-60).max(60),
    mutedInMix: z.boolean(),
    monitoring: z.boolean(),
  })
  .passthrough()

export const StudioDocumentSchema = z.object({
  version: z.literal(1),
  sessionId: id,
  savedAt: finite,
  sources: z.array(MediaSourceSchema),
  sourceOrder: z.array(id),
  scenes: z.array(SceneSchema),
  sceneOrder: z.array(id),
  activeSceneId: id.nullable(),
  guests: z.array(GuestSchema),
  guestOrder: z.array(id),
  audioChannels: z.array(AudioChannelSchema),
  audioChannelOrder: z.array(id),
})

export const StudioSessionSchema = z
  .object({
    id,
    name: z.string().max(200),
    mode: z.enum(['local', 'peer']),
    createdAt: finite,
    lastOpenedAt: finite,
  })
  .passthrough()

export const OutputSettingsSchema = z.object({
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3']),
  resolution: z.enum(['480p', '720p', '1080p']),
  frameRate: z.union([z.literal(24), z.literal(30), z.literal(60)]),
})

/** Every field optional: a missing one takes its default, a bad one is dropped. */
export const StudioSettingsSchema = z
  .object({
    output: OutputSettingsSchema.partial(),
    snapToGuides: z.boolean(),
    snapThresholdPx: finite.min(0).max(100),
    showSafeAreas: z.boolean(),
    reducedMotion: z.enum(['system', 'always', 'never']),
    previewFrameRate: z.union([z.literal(24), z.literal(30), z.literal(60)]),
    monitorProgramAudio: z.boolean(),
    iceServerUrls: z.array(z.string().max(512)),
    signalingServerUrl: z.string().max(512),
  })
  .partial()

export type ValidationIssue = {
  /** Which stored record was bad. */
  record: string
  message: string
}

/**
 * Validate a value, returning either the parsed data or an issue.
 * Never throws; storage must not be able to crash the caller.
 */
export function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  record: string,
): { ok: true; data: z.infer<S> } | { ok: false; issue: ValidationIssue } {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, data: result.data as z.infer<S> }
  const first = result.error.issues[0]
  const path = first?.path.length ? ` at ${first.path.join('.')}` : ''
  return {
    ok: false,
    issue: { record, message: `${first?.message ?? 'invalid'}${path}` },
  }
}

/**
 * Settings are recovered field by field: a bad `output.frameRate` costs that
 * one field, not every preference the operator set.
 */
export function salvageSettings(value: unknown): { settings: Record<string, unknown>; dropped: string[] } {
  if (typeof value !== 'object' || value === null) return { settings: {}, dropped: ['settings'] }
  const dropped: string[] = []
  const settings: Record<string, unknown> = {}
  const shape = StudioSettingsSchema.shape
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    const field = (value as Record<string, unknown>)[key]
    if (field === undefined) continue
    const result = shape[key].safeParse(field)
    if (result.success) settings[key] = result.data
    else dropped.push(key)
  }
  return { settings, dropped }
}
