import { useCallback, useEffect, useRef } from 'react'
import type { ControlAction, MediaSource } from '@shared/protocol'
import { MediaSession } from '@/media/media-session'
import { QualityController } from '@/media/quality-controller'
import { useMediaSessionStore } from '@/media/session-store'
import { useGuestStore } from '@/stores/guestStore'
import type { JoinOptions, SessionSnapshot } from '@/media/types'
import { resolveRelayUrl } from '@/services/signaling/relay-url'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Own one {@link MediaSession} for as long as `join` is set.
 *
 * Setting `join` starts the session; clearing it, or changing the room,
 * leaves and starts over. Everything else about the session (label changes,
 * publishing) happens through the returned methods rather than through
 * re-renders, so an inline options object cannot restart a live call.
 */

export type UseMediaSessionOptions = {
  /** Null keeps the session stopped. */
  join: JoinOptions | null
}

export type UseMediaSession = {
  snapshot: SessionSnapshot
  supported: boolean
  produce: (source: MediaSource, track: MediaStreamTrack) => Promise<void>
  closeProducer: (source: MediaSource) => Promise<void>
  pauseProducer: (source: MediaSource, paused: boolean) => Promise<void>
  updateState: (state: { micMuted?: boolean; cameraMuted?: boolean; sharing?: boolean }) => Promise<void>
  control: (target: string, command: ControlAction) => Promise<void>
  getRoomKeys: () => Promise<{ directorKey: string; producerKey: string } | null>
  leave: () => void
}

export function useMediaSession({ join }: UseMediaSessionOptions): UseMediaSession {
  const serverUrl = useSettingsStore((state) => state.settings.signalingServerUrl)
  const showToast = useStudioStore((state) => state.showToast)
  const snapshot = useMediaSessionStore((state) => state.snapshot)
  const attach = useMediaSessionStore((state) => state.attach)
  const setQuality = useMediaSessionStore((state) => state.setQuality)
  const sessionRef = useRef<MediaSession | null>(null)

  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  // Identity of the join: these are what warrant a new session.
  const room = join?.room ?? null
  const label = join?.label ?? ''
  const key = join?.key
  const role = join?.role
  const claim = join?.claim ?? false
  const url = resolveRelayUrl(serverUrl)

  useEffect(() => {
    if (!room) return
    const session = new MediaSession({ url })
    sessionRef.current = session
    // A handle for the browser test suite, which drives the session directly
    // to prove the server refuses what the UI never offers.
    if (import.meta.env.DEV) (window as unknown as { __livedeckSession?: MediaSession }).__livedeckSession = session
    const detach = attach(session)
    const offError = session.on('error', (message) => showToastRef.current(message, 'error'))
    /*
     * Started on the next task, not now. React StrictMode mounts, unmounts
     * and remounts effects synchronously in development; a session started
     * immediately would connect, claim the room, and then sit in the server's
     * resume window while the real session joined behind it as a guest.
     * Deferring means the throwaway mount is cancelled before it dials.
     */
    const startTimer = setTimeout(() => {
      void session.start({ room, label, key, role, claim }).catch(() => {
        // Reported through the error event and the snapshot's `error`.
      })
    }, 0)

    const quality = new QualityController(session, {
      onReport: (report, perParticipant) => {
        setQuality(report)
        const setPeerStats = useGuestStore.getState().setPeerStats
        for (const [participantId, stats] of perParticipant) setPeerStats(participantId, stats)
      },
    })
    quality.start()

    // A laptop waking or a network coming back is the moment to check, not
    // the next heartbeat.
    const onWake = () => {
      if (document.visibilityState === 'hidden') return
      session.reconnectNow()
      void session.checkHealth()
    }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onWake)
    /*
     * Closing or reloading the tab is a deliberate leave. Leaving cleanly
     * lets the server remove the participant at once; otherwise the dropped
     * socket is held for a resume that never comes, and the reloaded page
     * joins beside its own ghost.
     */
    const onPageHide = () => session.leave()
    window.addEventListener('pagehide', onPageHide)

    return () => {
      clearTimeout(startTimer)
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('pagehide', onPageHide)
      quality.stop()
      offError()
      session.leave()
      detach()
      setQuality(null)
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [attach, claim, key, label, role, room, setQuality, url])

  const produce = useCallback(
    (source: MediaSource, track: MediaStreamTrack) => sessionRef.current?.produce(source, track) ?? Promise.resolve(),
    [],
  )
  const closeProducer = useCallback(
    (source: MediaSource) => sessionRef.current?.closeProducer(source) ?? Promise.resolve(),
    [],
  )
  const pauseProducer = useCallback(
    (source: MediaSource, paused: boolean) => sessionRef.current?.pauseProducer(source, paused) ?? Promise.resolve(),
    [],
  )
  const updateState = useCallback(
    (state: { micMuted?: boolean; cameraMuted?: boolean; sharing?: boolean }) =>
      sessionRef.current?.updateState(state) ?? Promise.resolve(),
    [],
  )
  const control = useCallback(
    (target: string, command: ControlAction) => {
      const session = sessionRef.current
      if (!session) return Promise.reject(new Error('Not in a room.'))
      return session.control(target, command)
    },
    [],
  )
  const getRoomKeys = useCallback(async () => {
    try {
      return (await sessionRef.current?.getRoomKeys()) ?? null
    } catch {
      return null
    }
  }, [])
  const leave = useCallback(() => sessionRef.current?.leave(), [])

  return {
    snapshot,
    supported: MediaSession.isSupported(),
    produce,
    closeProducer,
    pauseProducer,
    updateState,
    control,
    getRoomKeys,
    leave,
  }
}
