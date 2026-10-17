import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { useDirectorMedia } from '@/hooks/useDirectorMedia'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useStudioStore } from '@/stores/studioStore'
import { DirectorRoom } from '@/components/layout/DirectorRoom'

/**
 * `/director/:room` — the control room route.
 *
 * Resolves the room, creating it if it does not exist, then joins it on the
 * media server. The first control room to open a room claims it as its
 * director; a `?key=` in the URL grants the role explicitly.
 */
export function DirectorPage() {
  const { room: rawRoom } = useParams<{ room: string }>()
  const session = useStudioSession()
  const currentId = useStudioStore((state) => state.session?.id ?? null)
  const showToast = useStudioStore((state) => state.showToast)

  const room = normalizeRoomName(rawRoom ?? '')
  const parameters = useUrlParameters()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room, { mode: 'peer' })
    setReady(true)
    // `session` is recreated each render; the room id is the only input that
    // should re-trigger a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  const media = useDirectorMedia(ready ? room : '', parameters.key)

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

  return <DirectorRoom room={room} media={media} />
}
