import { useEffect, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { streamRegistry } from '@/services/media/stream-registry'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useSourceStore } from '@/stores/sourceStore'

/**
 * `/solo/:room/:sourceId` — one source, clean.
 *
 * The companion to the scene view: where `/scene` captures the whole composed
 * program, this captures a single feed with no composition at all. Useful when
 * a downstream tool wants to lay out the guests itself, which is exactly what
 * VDO.Ninja's solo links are for.
 *
 * No interface, no cursor, no compositor — the stream is bound straight to a
 * `<video>`, so there is no re-encode and no scene geometry involved.
 */
export function SoloPage() {
  const { room: rawRoom, sourceId } = useParams<{ room: string; sourceId: string }>()
  const session = useStudioSession()
  useUrlParameters()

  const room = normalizeRoomName(rawRoom ?? '')
  const source = useSourceStore((state) => (sourceId ? state.sources[sourceId] : undefined))
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room)
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  /**
   * Bind the source's stream to the element.
   *
   * A viewer, never an owner: the StreamRegistry's refcount governs the
   * tracks' lifetime, so this detaches on cleanup but never stops them.
   */
  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const key = source?.streamKey
    const stream = key ? streamRegistry.getStream(key) : null
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) {
      void element.play().catch(() => {
        // Autoplay refused; the frame stays static rather than throwing.
      })
    }
    return () => {
      element.srcObject = null
    }
  }, [source?.streamKey])

  if (!rawRoom || !room || !sourceId) return <Navigate to="/" replace />

  const stream = source?.streamKey ? streamRegistry.getStream(source.streamKey) : null

  return (
    <main
      className="flex h-full w-full items-center justify-center bg-black"
      style={{ cursor: 'none' }}
    >
      {stream ? (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label={`Solo feed: ${source?.name ?? sourceId}`}
          className="h-full w-full object-contain"
        />
      ) : (
        <p className="px-4 text-center text-xs text-white/40">
          {!ready
            ? 'Opening room…'
            : !source
              ? `No source “${sourceId}” in room ${room}. Solo links are generated from the control room.`
              : 'This source has no live stream. Start it in the control room.'}
        </p>
      )}
    </main>
  )
}
