import { useEffect, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { streamRegistry } from '@/services/media/stream-registry'
import { useProgramMirror } from '@/hooks/useProgramMirror'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useSourceStore } from '@/stores/sourceStore'

/**
 * `/solo/:room/:sourceId` — one source, clean.
 *
 * The companion to the scene view: where `/scene` captures the whole composed
 * program, this captures a single feed with no composition at all. Useful when
 * a downstream tool wants to lay out the guests itself, which is exactly what
 * solo links are for — and it is how you hand one guest's camera to someone
 * else without giving them the control room.
 *
 * No interface, no cursor, no compositor — the stream is bound straight to a
 * `<video>`, so there is no re-encode and no scene geometry involved.
 *
 * WHERE THE STREAM COMES FROM
 * ---------------------------
 * In another window, from the control room, over the same loopback mirror the
 * scene view uses (see `services/composition/program-link.ts`). A
 * `MediaStream` cannot cross a browsing context, so a solo window cannot read
 * the registry of the tab that owns the capture — it has to be sent the track.
 *
 * In the *same* window it can read the registry directly, which is the case
 * when the solo view is opened from the control room's own tab.
 */
export function SoloPage() {
  const { room: rawRoom, sourceId } = useParams<{ room: string; sourceId: string }>()
  const session = useStudioSession()
  useUrlParameters()

  const room = normalizeRoomName(rawRoom ?? '')
  const source = useSourceStore((state) => (sourceId ? state.sources[sourceId] : undefined))
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ready, setReady] = useState(false)

  const mirror = useProgramMirror(room || null, sourceId ?? undefined)

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room)
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  /*
   * Prefer a locally-owned capture, fall back to the mirror.
   *
   * The local registry is only populated in the window that acquired the
   * media, so in practice this picks the registry when the solo view is open
   * in the control room's tab and the mirror in every other window.
   */
  const localStream = source?.streamKey ? streamRegistry.getStream(source.streamKey) : null
  const stream = localStream ?? mirror.stream

  /**
   * Bind the stream to the element.
   *
   * A viewer, never an owner: the StreamRegistry's refcount governs a local
   * capture's lifetime and the publisher owns a mirrored track, so this
   * detaches on cleanup but never stops anything.
   */
  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) {
      void element.play().catch(() => {
        // Autoplay refused; the frame stays static rather than throwing.
      })
    }
    return () => {
      element.srcObject = null
    }
  }, [stream])

  if (!rawRoom || !room || !sourceId) return <Navigate to="/" replace />

  return (
    <main
      className="flex h-full w-full items-center justify-center bg-black"
      style={{ cursor: 'none' }}
    >
      {stream ? (
        <video
          ref={videoRef}
          /*
           * Muted, like the scene view: a second unmuted playout of a live
           * microphone in another window is an acoustic feedback loop. The
           * audio track is still on the stream for a browser-source capture.
           */
          muted
          autoPlay
          playsInline
          aria-label={`Solo feed: ${source?.name ?? sourceId}`}
          className="h-full w-full object-contain"
        />
      ) : (
        <p className="px-4 text-center text-xs text-white/40">
          {/*
            One message for both reasons there is no picture, because from
            here they are indistinguishable and the operator's next move is
            the same either way: a connected mirror carrying no media and no
            mirror at all both mean "nothing is being sent yet".
          */}
          {!ready
            ? 'Opening room…'
            : mirror.state === 'unsupported'
              ? 'This browser cannot receive a solo feed from the control room.'
              : `Waiting for a live feed for “${sourceId}”. Solo links are generated from the control room, which has to be open in another window — and the source has to be started.`}
        </p>
      )}
    </main>
  )
}
