import { useCallback, useEffect, useState } from 'react'
import { requestScreenShare } from '@/services/media/capture-service'
import { streamRegistry } from '@/services/media/stream-registry'
import { isUserCancellation, toMediaError } from '@/utils/errors'
import { useStudioStore } from '@/stores/studioStore'

/**
 * A guest sharing their screen.
 *
 * Deliberately *not* the studio's screen capture, which creates a `screen`
 * source and places it in a scene. A guest has no scenes: sharing replaces
 * what their single outgoing video track carries, so the people watching see
 * the screen instead of the face — which is what every meeting tool does and
 * what the room expects.
 *
 * REPLACING, NOT ADDING
 * ---------------------
 * A second video track would mean renegotiating with every peer in the mesh,
 * and would double a guest's upload for the duration. Swapping the track on
 * the existing sender needs no renegotiation at all, and keeps the cost of
 * sharing identical to the cost of being in the call.
 *
 * The visible consequence, which is worth being deliberate about: while a
 * guest shares, their camera is not going out — to anyone, including the
 * director's program. That is the same trade every meeting tool makes.
 */

/** Registry key for the shared screen. One per guest, so a constant. */
export const GUEST_SCREEN_KEY = 'screen:self'

export type UseGuestScreenShare = {
  sharing: boolean
  busy: boolean
  /** True when the browser cannot share at all. */
  unsupported: boolean
  start: () => Promise<boolean>
  stop: () => void
  toggle: () => void
}

export function useGuestScreenShare(): UseGuestScreenShare {
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState(false)
  const showToast = useStudioStore((state) => state.showToast)

  const unsupported =
    typeof navigator === 'undefined' ||
    typeof navigator.mediaDevices?.getDisplayMedia !== 'function'

  const stop = useCallback(() => {
    // The registry owns the tracks and stops them when the last reference
    // goes, so this releases rather than reaching into the stream itself.
    streamRegistry.release(GUEST_SCREEN_KEY)
    setSharing(false)
  }, [])

  const start = useCallback(async (): Promise<boolean> => {
    if (unsupported) {
      showToast('This browser cannot share a screen.', 'error')
      return false
    }
    setBusy(true)
    try {
      /*
       * Display audio is requested but never relied on. Whether a track
       * arrives depends on the OS, the browser and which surface was picked —
       * a whole screen on macOS generally cannot provide one. The guest's
       * microphone keeps carrying their voice either way, so a missing display
       * audio track degrades the share rather than breaking it.
       */
      const stream = await requestScreenShare(true)
      streamRegistry.register(GUEST_SCREEN_KEY, stream)
      setSharing(true)
      return true
    } catch (error) {
      const mediaError = toMediaError(error)
      // Dismissing the browser's own picker is a decision, not a failure, and
      // does not deserve an error toast.
      if (!isUserCancellation(mediaError)) showToast(mediaError.message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }, [showToast, unsupported])

  const toggle = useCallback(() => {
    if (sharing) {
      stop()
      return
    }
    void start()
  }, [sharing, start, stop])

  /**
   * Follow the browser's own "Stop sharing" button.
   *
   * Every browser puts one outside the page, and a guest who uses it would
   * otherwise leave this view claiming to share a track that has ended — and
   * send a dead track to every peer in the mesh.
   */
  useEffect(() => {
    if (!sharing) return
    const stream = streamRegistry.getStream(GUEST_SCREEN_KEY)
    const track = stream?.getVideoTracks()[0]
    if (!track) return

    const onEnded = () => stop()
    track.addEventListener('ended', onEnded)
    return () => track.removeEventListener('ended', onEnded)
  }, [sharing, stop])

  // Releasing on unmount matters: leaving the page while sharing must not
  // leave the browser's "sharing your screen" indicator running.
  useEffect(() => () => streamRegistry.release(GUEST_SCREEN_KEY), [])

  return { sharing, busy, unsupported, start, stop, toggle }
}
