import { create } from 'zustand'
import type { MediaSession } from './media-session'
import type { QualityReport } from './quality-controller'
import { INITIAL_SNAPSHOT, type SessionSnapshot } from './types'

/**
 * The one active media session, and its latest snapshot.
 *
 * A page owns at most one session. Keeping it here rather than threading it
 * through props lets the director controls, the guest-side control handler
 * and the diagnostics panel reach it without the page knowing about them.
 * The snapshot is mirrored into the store so components subscribe with
 * ordinary selectors and re-render only on the slice they read.
 */

type SessionStoreState = {
  session: MediaSession | null
  snapshot: SessionSnapshot
  quality: QualityReport | null
  attach: (session: MediaSession) => () => void
  setQuality: (quality: QualityReport | null) => void
}

export const useMediaSessionStore = create<SessionStoreState>()((set, get) => ({
  session: null,
  snapshot: INITIAL_SNAPSHOT,
  quality: null,
  setQuality: (quality) => set({ quality }),
  attach: (session) => {
    const off = session.on('snapshot', (snapshot) => {
      if (get().session === session) set({ snapshot })
    })
    set({ session, snapshot: session.current })
    return () => {
      off()
      if (get().session === session) set({ session: null, snapshot: INITIAL_SNAPSHOT, quality: null })
    }
  },
}))

export const selectSession = (state: SessionStoreState): MediaSession | null => state.session
export const selectSnapshot = (state: SessionStoreState): SessionSnapshot => state.snapshot
