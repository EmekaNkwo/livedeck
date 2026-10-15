import { useCallback, useEffect, useRef, useState } from 'react'
import type { StudioMode } from '@/types/peer'
import type { StudioSession } from '@/types/session'
import { createSessionId } from '@/utils/id'
import { streamRegistry } from '@/services/media/stream-registry'
import { audioMixer } from '@/services/audio/audio-mixer'
import { recordingEngine } from '@/services/recording/recording-engine'
import { useMediaSessionStore } from '@/media/session-store'
import { assetCache } from '@/services/composition/asset-cache'
import { compositor } from '@/services/composition/compositor'
import { meterBus } from '@/services/audio/meter-bus'
import { revokeAllTrackedUrls } from '@/services/persistence/object-urls'
import {
  deleteSession,
  findSession,
  listSessions,
  loadDocument,
  saveDocument,
  touchSession,
  upsertSession,
} from '@/services/persistence/document-store'
import { useStudioStore } from '@/stores/studioStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useGuestStore } from '@/stores/guestStore'
import { useAudioStore } from '@/stores/audioStore'
import { useRecordingStore } from '@/stores/recordingStore'

/**
 * Session lifecycle: create, open, persist, reset, end.
 *
 * SESSION IDS ARE NOT ACCESS CONTROL
 * ----------------------------------
 * A session id is a short, human-shareable label for coordinating a
 * production. It authenticates nothing and authorizes nothing — there is no
 * server to check it against. Knowing an id grants no access to anybody's
 * media; media only ever flows over a peer connection that both sides
 * explicitly established. The UI says this plainly wherever an id is shown.
 *
 * SAVE SCOPE
 * ----------
 * Only serializable configuration is written: sources (with live stream
 * references stripped), scenes, guests and mixer settings. Streams, audio
 * nodes and peer connections are never persisted, because they cannot be and
 * because they are meaningless after a reload.
 */

export type UseStudioSession = {
  session: StudioSession | null
  sessions: StudioSession[]
  ready: boolean

  createSession: (options?: { name?: string; mode?: StudioMode; id?: string }) => StudioSession
  openSession: (sessionId: string) => StudioSession | null
  /**
   * Open the room with this id, creating it if it does not exist yet.
   *
   * This is how every role route enters: a room is addressed by name, so
   * navigating to `/director/my-room` *is* creating `my-room`. There is no
   * separate "new project" step.
   */
  ensureRoom: (roomId: string, options?: { mode?: StudioMode }) => StudioSession
  renameSession: (name: string) => void
  setMode: (mode: StudioMode) => void
  /** Clear the production but keep the session. */
  requestResetSession: () => void
  /** Release every resource this session owns and leave. */
  endSession: () => void
  requestEndSession: (onDone: () => void) => void
  requestDeleteSession: (sessionId: string, onDone?: () => void) => void
  save: () => void
}

/** Debounce window for autosave. Long enough to coalesce a drag gesture. */
const AUTOSAVE_DEBOUNCE_MS = 600

export function useStudioSession(): UseStudioSession {
  const session = useStudioStore((state) => state.session)
  const setSession = useStudioStore((state) => state.setSession)
  const setStatus = useStudioStore((state) => state.setStatus)
  const setModeInStore = useStudioStore((state) => state.setMode)
  const renameInStore = useStudioStore((state) => state.renameSession)
  const resetEphemeral = useStudioStore((state) => state.resetEphemeral)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)
  const showToast = useStudioStore((state) => state.showToast)

  const [sessions, setSessions] = useState<StudioSession[]>(() => listSessions())
  const [ready, setReady] = useState(false)

  const refreshSessions = useCallback(() => setSessions(listSessions()), [])

  /** Collect the current production into a serializable document. */
  const buildDocument = useCallback((sessionId: string) => {
    const sourceState = useSourceStore.getState()
    const sceneState = useSceneStore.getState()
    const guestState = useGuestStore.getState()
    const audioState = useAudioStore.getState()
    return {
      sessionId,
      sources: Object.values(sourceState.sources),
      sourceOrder: sourceState.order,
      scenes: Object.values(sceneState.scenes),
      sceneOrder: sceneState.order,
      activeSceneId: sceneState.activeSceneId,
      guests: Object.values(guestState.guests),
      guestOrder: guestState.order,
      audioChannels: Object.values(audioState.channels),
      audioChannelOrder: audioState.order,
    }
  }, [])

  const save = useCallback(() => {
    const current = useStudioStore.getState().session
    if (!current) return
    saveDocument(buildDocument(current.id))
  }, [buildDocument])

  /** Load a document into the stores, or seed a default scene. */
  const hydrate = useCallback((sessionId: string) => {
    const document = loadDocument(sessionId)
    if (document) {
      useSourceStore.getState().hydrate(document.sources, document.sourceOrder)
      useSceneStore
        .getState()
        .hydrate(document.scenes, document.sceneOrder, document.activeSceneId)
      useGuestStore.getState().hydrate(document.guests, document.guestOrder)
      useAudioStore.getState().hydrate(document.audioChannels, document.audioChannelOrder)
    } else {
      useSourceStore.getState().clear()
      useSceneStore.getState().clear()
      useGuestStore.getState().clear()
      useAudioStore.getState().clear()
    }
    // The program output must always have a scene to point at.
    if (useSceneStore.getState().order.length === 0) {
      useSceneStore.getState().createScene('Main')
    }
  }, [])

  const createSession = useCallback(
    (options?: { name?: string; mode?: StudioMode; id?: string }): StudioSession => {
      const now = Date.now()
      const next: StudioSession = {
        // An explicit id lets a room be addressed by name from a URL.
        id: options?.id ?? createSessionId(),
        name: options?.name?.trim() || 'Untitled production',
        mode: options?.mode ?? 'local',
        createdAt: now,
        lastOpenedAt: now,
      }
      upsertSession(next)
      setSession(next)
      setStatus('ready')
      hydrate(next.id)
      refreshSessions()
      setReady(true)
      return next
    },
    [hydrate, refreshSessions, setSession, setStatus],
  )

  const openSession = useCallback(
    (sessionId: string): StudioSession | null => {
      const existing = findSession(sessionId)
      if (!existing) return null
      touchSession(sessionId)
      const opened = { ...existing, lastOpenedAt: Date.now() }
      setSession(opened)
      setStatus('ready')
      hydrate(sessionId)
      refreshSessions()
      setReady(true)
      return opened
    },
    [hydrate, refreshSessions, setSession, setStatus],
  )

  const ensureRoom = useCallback(
    (roomId: string, options?: { mode?: StudioMode }): StudioSession => {
      const current = useStudioStore.getState().session
      if (current?.id === roomId) return current

      const existing = openSession(roomId)
      if (existing) return existing

      return createSession({
        id: roomId,
        name: roomId,
        ...(options?.mode ? { mode: options.mode } : {}),
      })
    },
    [createSession, openSession],
  )

  const setMode = useCallback(
    (mode: StudioMode) => {
      setModeInStore(mode)
      const current = useStudioStore.getState().session
      if (current) upsertSession(current)
      // Switching out of peer mode closes live connections — they are
      // meaningless in Local Studio Mode and leaving them open would be a leak.
      if (mode === 'local') {
        useMediaSessionStore.getState().session?.leave()
        useGuestStore.getState().clearLive()
      }
      refreshSessions()
    },
    [refreshSessions, setModeInStore],
  )

  const renameSession = useCallback(
    (name: string) => {
      renameInStore(name)
      const current = useStudioStore.getState().session
      if (current) {
        upsertSession(current)
        refreshSessions()
      }
    },
    [refreshSessions, renameInStore],
  )

  /**
   * Release everything this session owns.
   *
   * Order matters: stop producing frames, then stop the recorder, then tear
   * down transports, then release media and audio. Doing it the other way
   * round can make the compositor or recorder read from a disposed stream.
   */
  const releaseSessionResources = useCallback(() => {
    compositor.stop()
    recordingEngine.dispose()
    useMediaSessionStore.getState().session?.leave()
    streamRegistry.disposeAll()
    assetCache.releaseAll()
    meterBus.clear()
    revokeAllTrackedUrls()
    void audioMixer.dispose()
  }, [])

  const endSession = useCallback(() => {
    save()
    releaseSessionResources()
    useSourceStore.getState().clear()
    useSceneStore.getState().clear()
    useGuestStore.getState().clear()
    useAudioStore.getState().clear()
    useRecordingStore.getState().reset()
    resetEphemeral()
    setSession(null)
    setStatus('ended')
    setReady(false)
  }, [releaseSessionResources, resetEphemeral, save, setSession, setStatus])

  const requestEndSession = useCallback(
    (onDone: () => void) => {
      requestConfirm({
        title: 'End this production?',
        message:
          'Camera, microphone, screen sharing and any peer connections will be released. Your ' +
          'scenes and sources are saved, and recordings already finished are kept.',
        confirmLabel: 'End production',
        destructive: true,
        onConfirm: () => {
          endSession()
          onDone()
        },
      })
    },
    [endSession, requestConfirm],
  )

  const requestResetSession = useCallback(() => {
    const current = useStudioStore.getState().session
    if (!current) return
    requestConfirm({
      title: 'Reset this production?',
      message:
        'Every source, scene and guest in this session will be removed, and capture will stop. ' +
        'Finished recordings are not affected. This cannot be undone.',
      confirmLabel: 'Reset production',
      destructive: true,
      onConfirm: () => {
        releaseSessionResources()
        useSourceStore.getState().clear()
        useSceneStore.getState().clear()
        useGuestStore.getState().clear()
        useAudioStore.getState().clear()
        resetEphemeral()
        useSceneStore.getState().createScene('Main')
        save()
        showToast('Production reset.', 'info')
      },
    })
  }, [releaseSessionResources, requestConfirm, resetEphemeral, save, showToast])

  const requestDeleteSession = useCallback(
    (sessionId: string, onDone?: () => void) => {
      const target = findSession(sessionId)
      if (!target) return
      requestConfirm({
        title: `Delete “${target.name}”?`,
        message:
          'This session’s scenes, sources and guests will be permanently removed from this device. ' +
          'Recordings are stored separately and are not deleted.',
        confirmLabel: 'Delete session',
        destructive: true,
        onConfirm: () => {
          deleteSession(sessionId)
          if (useStudioStore.getState().session?.id === sessionId) endSession()
          refreshSessions()
          onDone?.()
        },
      })
    },
    [endSession, refreshSessions, requestConfirm],
  )

  /**
   * Autosave.
   *
   * Subscribes to the four document stores and writes a debounced snapshot.
   * Debouncing matters: a drag gesture produces a transform update per frame,
   * and serializing on each one would be wasteful.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!session) return

    const schedule = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        save()
      }, AUTOSAVE_DEBOUNCE_MS)
    }

    const unsubscribers = [
      useSourceStore.subscribe(schedule),
      useSceneStore.subscribe(schedule),
      useGuestStore.subscribe(schedule),
      useAudioStore.subscribe(schedule),
    ]

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        // Flush on teardown so a pending change is never lost.
        save()
      }
    }
  }, [save, session])

  // Best-effort flush when the page goes away. `pagehide` is more reliable
  // than `beforeunload` on mobile Safari.
  useEffect(() => {
    const flush = () => save()
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [save])

  return {
    session,
    sessions,
    ready,
    createSession,
    openSession,
    ensureRoom,
    renameSession,
    setMode,
    requestResetSession,
    endSession,
    requestEndSession,
    requestDeleteSession,
    save,
  }
}
