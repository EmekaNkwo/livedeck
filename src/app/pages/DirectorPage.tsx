import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import {
  clearSignalFragment,
  readSignalFromFragment,
} from '@/services/signaling/invite-link'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useWebRTC } from '@/hooks/useWebRTC'
import { useStudioStore } from '@/stores/studioStore'
import { DirectorRoom } from '@/components/layout/DirectorRoom'

/**
 * `/director/:room` — the control room route.
 *
 * Two jobs before the room mounts:
 *  1. Resolve the room, creating it if it does not exist. A room is addressed
 *     by name, so navigating here *is* creating it.
 *  2. Consume an answer from the URL fragment, which is how a guest's reply
 *     comes back — they click a link rather than the director pasting a blob.
 */
export function DirectorPage() {
  const { room: rawRoom } = useParams<{ room: string }>()
  const location = useLocation()
  const session = useStudioSession()
  const currentId = useStudioStore((state) => state.session?.id ?? null)
  const showToast = useStudioStore((state) => state.showToast)

  const room = normalizeRoomName(rawRoom ?? '')
  const parameters = useUrlParameters()
  /*
   * Joining the signaling room is what makes a guest who opens the room link
   * simply appear. `room` is ignored by the manual transport, which has no
   * server to join, so this needs no branch — but without it the room-based
   * transport would connect to the relay and then sit outside every room,
   * which looks exactly like "guests never show up".
   */
  const webrtc = useWebRTC({
    /*
     * The control room sends nothing.
     *
     * A director works behind the scenes — it is not a participant in the
     * meeting, and guests do not see it. It used to send its composed program
     * to every guest, which meant encoding the canvas once per guest for a
     * feed nobody renders, and put a "director" tile in a call the director is
     * not in.
     *
     * The connection stays, because it carries the guests' media *to* the
     * control room and the control channel back — remote mute, cue, tally.
     */
    send: 'none',
    room,
    role: 'director',
    label: 'Director',
  })

  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room, { mode: 'peer' })
    setReady(true)
    // `session` is recreated each render; the room id is the only input that
    // should re-trigger a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  /**
   * Apply an answer carried in the fragment, once.
   *
   * The fragment is cleared immediately afterwards so a reload cannot re-apply
   * a stale answer, and so the operator is not left staring at a
   * multi-kilobyte URL.
   */
  const consumedHash = useRef<string | null>(null)
  useEffect(() => {
    if (!ready) return
    const hash = location.hash
    if (!hash || consumedHash.current === hash) return
    consumedHash.current = hash

    void (async () => {
      const result = await readSignalFromFragment(hash)
      if (result.status === 'none') return
      if (result.status === 'invalid') {
        showToast(result.error, 'error')
        clearSignalFragment()
        return
      }
      if (result.signal.kind !== 'answer') {
        showToast(
          'That link carries an offer, not an answer. Open it in a guest window instead.',
          'error',
        )
        clearSignalFragment()
        return
      }
      clearSignalFragment()
      await webrtc.acceptAnswerInput(JSON.stringify(result.signal.envelope))
    })()
    // `webrtc` is recreated each render; the hash is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, ready])

  /** An unrecognised parameter is reported rather than silently ignored. */
  useEffect(() => {
    if (parameters.unknown.length === 0) return
    showToast(
      `Unrecognised URL parameter${parameters.unknown.length === 1 ? '' : 's'}: ${parameters.unknown.join(', ')}`,
      'error',
    )
  }, [parameters.unknown, showToast])

  if (!rawRoom || !room) return <Navigate to="/" replace />

  if (!ready || currentId !== room) {
    return (
      <div className="flex h-full items-center justify-center bg-deck-950">
        <p className="text-sm text-ink-400">Opening room…</p>
      </div>
    )
  }

  return <DirectorRoom room={room} webrtc={webrtc} />
}
