import { useEffect, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { useProgramCompositor } from '@/hooks/useProgramCompositor'
import { useProgramMirror } from '@/hooks/useProgramMirror'
import { useSceneManager } from '@/hooks/useSceneManager'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useSceneStore } from '@/stores/sceneStore'
import { useStudioStore } from '@/stores/studioStore'

/**
 * `/scene/:room` — the clean program output.
 *
 * This is the OBS integration point, and the reason the role exists: a window
 * containing nothing but the composed program at the logical canvas size,
 * which you point a window- or browser-capture source at.
 *
 * Consequently there is **no interface at all** — no header, no controls, no
 * focus ring, no cursor. Any chrome here would be captured. The only thing ever
 * drawn over the canvas is a short-lived hint for the operator who opened the
 * window directly, and it is removed from the DOM rather than merely hidden.
 *
 * WHERE THE PIXELS COME FROM
 * --------------------------
 * The control room *mirrors* its program output to this window over a loopback
 * peer connection (see `services/composition/program-link.ts`). That is not an
 * optimisation: a `MediaStream` belongs to the context that created it, so this
 * window cannot draw the director's camera, screen share or guests itself. It
 * used to try, from the room's saved scenes, and the result was a black window
 * — every live source was simply missing.
 *
 * With no control room open there is nothing to mirror, so the local
 * compositor runs as a fallback. It can still draw everything that *is*
 * serializable — colour backgrounds, text, the scene layout — and the hint says
 * plainly that live sources need the control room.
 */
export function ScenePage() {
  const { room: rawRoom } = useParams<{ room: string }>()
  const session = useStudioSession()
  const parameters = useUrlParameters()
  const { canvasRef, canvasSize, canvasAspect } = useProgramCompositor()
  const sceneManager = useSceneManager()
  const sceneOrder = useSceneStore((state) => state.order)
  const currentId = useStudioStore((state) => state.session?.id ?? null)

  const room = normalizeRoomName(rawRoom ?? '')
  const [ready, setReady] = useState(false)
  const [showHint, setShowHint] = useState(true)

  const mirror = useProgramMirror(room || null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const mirrored = Boolean(mirror.stream)

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room)
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  /** `?scene=N` selects a scene by position, for a fixed capture source. */
  const appliedScene = useRef<number | null>(null)
  useEffect(() => {
    if (!ready || parameters.scene === null) return
    if (appliedScene.current === parameters.scene) return
    const target = sceneOrder[parameters.scene]
    if (!target) return
    appliedScene.current = parameters.scene
    sceneManager.activateScene(target, { immediate: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, parameters.scene, sceneOrder])

  /** Bind the mirrored program to the video element. */
  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (element.srcObject !== mirror.stream) element.srcObject = mirror.stream
    if (mirror.stream) {
      void element.play().catch(() => {
        // Autoplay refused. The element is muted, so this is unexpected, but a
        // frozen first frame is still better than an exception here.
      })
    }
    return () => {
      // A viewer, not an owner — the publisher owns these tracks.
      element.srcObject = null
    }
  }, [mirror.stream])

  /** Retire the hint entirely, so it can never appear in a capture. */
  useEffect(() => {
    const timer = setTimeout(() => setShowHint(false), 6000)
    return () => clearTimeout(timer)
  }, [])

  if (!rawRoom || !room) return <Navigate to="/" replace />

  return (
    <main
      className="flex h-full w-full items-center justify-center bg-black"
      // No cursor: it would be captured along with the output.
      style={{ cursor: 'none' }}
    >
      <div
        className="relative max-h-full max-w-full"
        style={{ aspectRatio: String(canvasAspect), width: '100%' }}
      >
        {mirrored ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            /*
             * Muted deliberately. The program's audio is already monitored (or
             * deliberately not) in the control room, and a second unmuted
             * playout of a live microphone in another window is an acoustic
             * feedback loop. The audio track is still carried on the stream, so
             * a browser-source capture of this window can take it.
             */
            muted
            aria-label={`Program output for room ${room}`}
            className="block h-full w-full bg-black object-contain"
          />
        ) : (
          <canvas
            ref={canvasRef}
            // `width`/`height` are owned exclusively by the compositor — setting
            // them here would reset the backing store and blank the output.
            role="img"
            aria-label={`Program output for room ${room}`}
            className="block h-full w-full bg-black object-contain"
          />
        )}

        {showHint && ready && currentId === room ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2">
            <p className="text-[11px] leading-snug text-white/70">
              Clean scene output · {canvasSize.width}×{canvasSize.height} · room{' '}
              <strong className="text-white/90">{room}</strong>.{' '}
              {mirrored
                ? 'Mirroring the control room. Capture this window in OBS.'
                : mirror.state === 'unsupported'
                  ? 'This browser cannot mirror the control room, so only saved sources are drawn.'
                  : 'No control room is open for this room, so live sources (camera, screen share, guests) cannot appear here — open the director view in another window. Capture this window in OBS.'}{' '}
              This hint disappears in a few seconds and is never part of the output.
            </p>
          </div>
        ) : null}
      </div>
    </main>
  )
}
