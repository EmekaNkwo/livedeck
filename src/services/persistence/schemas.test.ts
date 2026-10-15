import { describe, expect, it } from 'vitest'
import { StudioDocumentSchema, salvageSettings, validate } from './schemas'

const validDocument = {
  version: 1,
  sessionId: 'studio-1',
  savedAt: 1,
  sources: [
    {
      id: 's1',
      name: 'Camera',
      type: 'camera',
      visible: true,
      locked: false,
      muted: false,
      layer: 0,
      settings: { kind: 'camera', deviceId: null, mirrored: false },
      streamKey: null,
      volume: 1,
      createdAt: 1,
    },
  ],
  sourceOrder: ['s1'],
  scenes: [
    {
      id: 'sc1',
      name: 'Main',
      order: 0,
      transition: { type: 'cut', durationMs: 0 },
      items: [
        {
          sourceId: 's1',
          transform: { x: 0, y: 0, width: 1, height: 1 },
          visible: true,
          locked: false,
          layer: 0,
          mirrored: false,
          opacity: 1,
        },
      ],
      createdAt: 1,
    },
  ],
  sceneOrder: ['sc1'],
  activeSceneId: 'sc1',
  guests: [],
  guestOrder: [],
  audioChannels: [],
  audioChannelOrder: [],
}

describe('StudioDocumentSchema', () => {
  it('accepts a valid document', () => {
    expect(validate(StudioDocumentSchema, validDocument, 'doc').ok).toBe(true)
  })

  it('rejects a document from an unknown version', () => {
    const result = validate(StudioDocumentSchema, { ...validDocument, version: 2 }, 'doc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.message).toContain('version')
  })

  it('rejects a transform with a non-number, naming the path', () => {
    const broken = structuredClone(validDocument) as unknown as { scenes: Array<{ items: Array<{ transform: Record<string, unknown> }> }> }
    broken.scenes[0]!.items[0]!.transform.width = 'wide'
    const result = validate(StudioDocumentSchema, broken, 'doc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.message).toContain('scenes.0.items.0.transform.width')
  })

  it('rejects garbage and non-objects without throwing', () => {
    expect(validate(StudioDocumentSchema, 'nope', 'doc').ok).toBe(false)
    expect(validate(StudioDocumentSchema, null, 'doc').ok).toBe(false)
    expect(validate(StudioDocumentSchema, { version: 1 }, 'doc').ok).toBe(false)
  })

  it('keeps unknown per-kind settings fields', () => {
    const result = validate(
      StudioDocumentSchema,
      { ...validDocument, sources: [{ ...validDocument.sources[0], settings: { kind: 'image', assetId: 'a1', fit: 'cover', extra: 1 } }] },
      'doc',
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.sources[0]?.settings).toMatchObject({ assetId: 'a1', extra: 1 })
  })
})

describe('salvageSettings', () => {
  it('keeps valid fields and drops bad ones individually', () => {
    const { settings, dropped } = salvageSettings({
      snapToGuides: true,
      previewFrameRate: 99,
      output: { resolution: '720p', frameRate: 'fast' },
      reducedMotion: 'always',
    })
    expect(settings.snapToGuides).toBe(true)
    expect(settings.reducedMotion).toBe('always')
    expect(dropped).toEqual(['output', 'previewFrameRate'])
  })

  it('drops everything for a non-object', () => {
    expect(salvageSettings('x')).toEqual({ settings: {}, dropped: ['settings'] })
  })
})
