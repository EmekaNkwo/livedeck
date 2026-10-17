import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/types/session'
import type { ValidationIssue } from '@/services/persistence/schemas'
import { onPersistenceIssue, resetPersistenceIssues } from '@/services/persistence/issues'
import { storageKey } from '@/services/persistence/local-store'
import { selectOutput, selectSnapping, useSettingsStore } from './settingsStore'

const KEY = storageKey('settings')
const store = () => useSettingsStore.getState()

function writePersisted(state: unknown, version: number): void {
  localStorage.setItem(KEY, JSON.stringify({ state, version }))
}

async function rehydrate(): Promise<void> {
  await useSettingsStore.persist.rehydrate()
}

function readPersisted(): { state: { settings: unknown }; version: number } {
  return JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
    state: { settings: unknown }
    version: number
  }
}

function collectIssues(): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  onPersistenceIssue((issue) => issues.push(issue))
  return issues
}

beforeEach(() => {
  resetPersistenceIssues()
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, revision: 0 })
  localStorage.clear()
})

afterEach(() => {
  resetPersistenceIssues()
})

describe('actions', () => {
  it('setOutput merges a patch and bumps the revision', () => {
    store().setOutput({ resolution: '1080p' })
    expect(selectOutput(store())).toEqual({ ...DEFAULT_SETTINGS.output, resolution: '1080p' })
    expect(store().revision).toBe(1)
  })

  it('setShowSafeAreas bumps the revision; other toggles do not', () => {
    store().setShowSafeAreas(true)
    store().setSnapToGuides(false)
    store().setReducedMotion('always')
    store().setPreviewFrameRate(60)
    store().setMonitorProgramAudio(true)
    store().setSignalingServerUrl('https://media.example.org')
    expect(store().revision).toBe(1)
    expect(store().settings).toMatchObject({
      showSafeAreas: true,
      snapToGuides: false,
      reducedMotion: 'always',
      previewFrameRate: 60,
      monitorProgramAudio: true,
      signalingServerUrl: 'https://media.example.org',
    })
  })

  it.each([
    [12, 12],
    [-5, 0],
    [400, 40],
  ])('setSnapThreshold(%s) clamps to %s', (input, expected) => {
    store().setSnapThreshold(input)
    expect(selectSnapping(store())).toEqual({ enabled: true, thresholdPx: expected })
  })

  it('reset restores defaults and bumps the revision', () => {
    store().setOutput({ frameRate: 60 })
    store().setSnapToGuides(false)
    store().reset()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(store().revision).toBe(2)
  })
})

describe('persistence', () => {
  it('persists only settings, at version 4', () => {
    store().setOutput({ aspectRatio: '9:16' })
    const persisted = readPersisted()
    expect(persisted.version).toBe(4)
    expect(Object.keys(persisted.state)).toEqual(['settings'])
    expect(persisted.state.settings).toMatchObject({ output: { aspectRatio: '9:16' } })
  })

  it('hydrates valid stored settings and fills keys added later with defaults', async () => {
    const issues = collectIssues()
    writePersisted(
      { settings: { snapToGuides: false, output: { frameRate: 60 } } },
      3,
    )
    await rehydrate()
    expect(store().settings).toEqual({
      ...DEFAULT_SETTINGS,
      snapToGuides: false,
      output: { ...DEFAULT_SETTINGS.output, frameRate: 60 },
    })
    expect(issues).toEqual([])
  })

  it('falls back to defaults when the stored state has no settings', async () => {
    store().setSnapToGuides(false)
    writePersisted({}, 3)
    await rehydrate()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
  })

  it('drops one corrupt field, keeps the rest, and reports it in the singular', async () => {
    const issues = collectIssues()
    writePersisted({ settings: { snapThresholdPx: 'eight', showSafeAreas: true } }, 3)
    await rehydrate()
    expect(store().settings.snapThresholdPx).toBe(DEFAULT_SETTINGS.snapThresholdPx)
    expect(store().settings.showSafeAreas).toBe(true)
    expect(issues).toEqual([
      { record: 'settings', message: 'invalid value for snapThresholdPx; default restored' },
    ])
  })

  it('reports several corrupt fields in the plural', async () => {
    const issues = collectIssues()
    writePersisted(
      { settings: { reducedMotion: 'sometimes', previewFrameRate: 25, output: { frameRate: 'fast' } } },
      3,
    )
    await rehydrate()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toBe(
      'invalid values for output, reducedMotion, previewFrameRate; defaults restored',
    )
  })

  it('treats a non-object settings value as entirely corrupt', async () => {
    const issues = collectIssues()
    writePersisted({ settings: 42 }, 3)
    await rehydrate()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(issues[0]?.message).toBe('invalid value for settings; default restored')
  })

  it('survives unparseable JSON without throwing and keeps current settings', async () => {
    store().setSnapToGuides(false)
    localStorage.setItem(KEY, '{not json')
    await expect(rehydrate()).resolves.toBeUndefined()
    expect(store().settings.snapToGuides).toBe(false)
  })
})

describe('migration to v3', () => {
  it('drops signalingTransport and any ICE list, keeping every other preference', async () => {
    writePersisted(
      {
        settings: {
          signalingTransport: 'websocket',
          iceServerUrls: ['turn:turn.example.org|u:p'],
          signalingServerUrl: 'https://relay.example.org',
          snapToGuides: false,
        },
      },
      1,
    )
    await rehydrate()
    expect(store().settings.signalingServerUrl).toBe('https://relay.example.org')
    expect(store().settings.snapToGuides).toBe(false)
    expect(store().settings).not.toHaveProperty('signalingTransport')
    expect(store().settings).not.toHaveProperty('iceServerUrls')
    // The migrated shape is written back at the current version.
    expect(readPersisted().version).toBe(4)
    expect(readPersisted().state.settings).not.toHaveProperty('iceServerUrls')
  })

  it('drops the ICE list a v3 install kept', async () => {
    writePersisted({ settings: { iceServerUrls: ['stun:stun.example.org'], showSafeAreas: true } }, 3)
    await rehydrate()
    expect(store().settings).not.toHaveProperty('iceServerUrls')
    expect(store().settings.showSafeAreas).toBe(true)
  })

  it('leaves an old state without settings for merge to default', async () => {
    store().setSnapToGuides(false)
    writePersisted({ somethingElse: true }, 1)
    await rehydrate()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
  })

  it('does not migrate state stored at the current version', async () => {
    writePersisted({ settings: { showSafeAreas: true, signalingServerUrl: 'https://x.example.org' } }, 4)
    await rehydrate()
    expect(store().settings.showSafeAreas).toBe(true)
    expect(store().settings.signalingServerUrl).toBe('https://x.example.org')
  })
})
