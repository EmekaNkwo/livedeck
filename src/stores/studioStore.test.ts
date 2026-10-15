import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaError } from '@/types/media'
import type { StudioSession } from '@/types/session'
import {
  selectIsPanelCollapsed,
  selectMode,
  selectSelectedSourceId,
  selectSession,
  useStudioStore,
} from './studioStore'

const store = () => useStudioStore.getState()
const initial = useStudioStore.getState()

const session: StudioSession = {
  id: 'abc123',
  name: 'Morning show',
  mode: 'local',
  createdAt: 1,
  lastOpenedAt: 2,
}

const error: MediaError = { code: 'not-allowed', message: 'denied', technical: null, at: 1 }

beforeEach(() => {
  useStudioStore.setState(initial, true)
})

describe('session', () => {
  it('sets the session and status', () => {
    store().setSession(session)
    store().setStatus('live')
    expect(selectSession(store())).toEqual(session)
    expect(store().status).toBe('live')
  })

  it('setMode changes the mode of the current session only', () => {
    store().setMode('peer')
    expect(store().session).toBeNull()
    expect(selectMode(store())).toBe('local')

    store().setSession(session)
    store().setMode('peer')
    expect(store().session?.mode).toBe('peer')
    expect(selectMode(store())).toBe('peer')
  })

  it('renameSession trims, and ignores blank names or a missing session', () => {
    store().renameSession('Orphan')
    expect(store().session).toBeNull()

    store().setSession(session)
    store().renameSession('  Evening show ')
    expect(store().session?.name).toBe('Evening show')

    store().renameSession('   ')
    expect(store().session?.name).toBe('Evening show')
  })
})

describe('capture status', () => {
  it('records each device status, permission and the last error', () => {
    store().setCameraStatus('active')
    store().setMicrophoneStatus('denied')
    store().setScreenStatus('requesting')
    store().setCameraPermission('granted')
    store().setMicrophonePermission('denied')
    store().setMediaError(error)
    expect(store()).toMatchObject({
      cameraStatus: 'active',
      microphoneStatus: 'denied',
      screenStatus: 'requesting',
      cameraPermission: 'granted',
      microphonePermission: 'denied',
      lastMediaError: error,
    })
  })
})

describe('UI state', () => {
  it('selects a source', () => {
    store().selectSource('src_1')
    expect(selectSelectedSourceId(store())).toBe('src_1')
  })

  it('toggles and sets panel collapse without touching other panels', () => {
    expect(selectIsPanelCollapsed('diagnostics')(store())).toBe(true)
    store().togglePanel('sources')
    expect(selectIsPanelCollapsed('sources')(store())).toBe(true)
    store().togglePanel('sources')
    expect(selectIsPanelCollapsed('sources')(store())).toBe(false)
    store().setPanelCollapsed('audio', true)
    expect(store().collapsedPanels).toMatchObject({ audio: true, diagnostics: true, scenes: false })
  })

  it('opens and closes dialogs', () => {
    store().openDialog('settings')
    expect(store().dialog).toBe('settings')
    store().closeDialog()
    expect(store().dialog).toBeNull()
  })

  it('runs onConfirm exactly once when a confirm is accepted', () => {
    const onConfirm = vi.fn()
    store().requestConfirm({
      title: 'Delete',
      message: 'Sure?',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm,
    })
    expect(store().confirm?.title).toBe('Delete')
    store().resolveConfirm(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(store().confirm).toBeNull()
    // A second resolve has nothing left to confirm.
    store().resolveConfirm(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not run onConfirm when declined', () => {
    const onConfirm = vi.fn()
    store().requestConfirm({
      title: 'Delete',
      message: 'Sure?',
      confirmLabel: 'Delete',
      destructive: false,
      onConfirm,
    })
    store().resolveConfirm(false)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(store().confirm).toBeNull()
  })

  it('clears the confirm before running onConfirm, so it can chain a new one', () => {
    const seen: Array<string | undefined> = []
    store().requestConfirm({
      title: 'First',
      message: '',
      confirmLabel: 'OK',
      destructive: false,
      onConfirm: () => seen.push(store().confirm?.title),
    })
    store().resolveConfirm(true)
    expect(seen).toEqual([undefined])
  })

  it('tracks interaction and toasts with an info default tone', () => {
    store().setInteracting(true)
    expect(store().interacting).toBe(true)
    store().showToast('Saved')
    expect(store().toast).toEqual({ message: 'Saved', tone: 'info' })
    store().showToast('Failed', 'error')
    expect(store().toast).toEqual({ message: 'Failed', tone: 'error' })
    store().dismissToast()
    expect(store().toast).toBeNull()
  })
})

describe('resetEphemeral', () => {
  it('forgets live status and UI transients but keeps session, permissions and panels', () => {
    store().setSession(session)
    store().setCameraStatus('active')
    store().setMicrophoneStatus('active')
    store().setScreenStatus('active')
    store().setCameraPermission('granted')
    store().setMediaError(error)
    store().selectSource('src_1')
    store().openDialog('recordings')
    store().requestConfirm({
      title: 't',
      message: 'm',
      confirmLabel: 'c',
      destructive: false,
      onConfirm: () => {},
    })
    store().setInteracting(true)
    store().setPanelCollapsed('audio', true)
    store().showToast('kept')

    store().resetEphemeral()

    expect(store()).toMatchObject({
      cameraStatus: 'idle',
      microphoneStatus: 'idle',
      screenStatus: 'idle',
      lastMediaError: null,
      selectedSourceId: null,
      dialog: null,
      confirm: null,
      interacting: false,
      session,
      cameraPermission: 'granted',
    })
    expect(store().collapsedPanels.audio).toBe(true)
    expect(store().toast?.message).toBe('kept')
  })
})
