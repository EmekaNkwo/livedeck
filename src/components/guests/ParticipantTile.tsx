import { VideoOff } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import type { RemoteParticipant } from '@/hooks/useWebRTC'

/**
 * One other person in the room, as a guest sees them.
 *
 * A `figure`/`figcaption`: a thumbnail *with a caption naming who it is*,
 * which gives the name a real relationship to the video instead of being loose
 * text positioned nearby.
 *
 * NOT MUTED, UNLIKE EVERY OTHER VIDEO IN THIS APP
 * -----------------------------------------------
 * The self-view, the scene window and the solo window are all muted, because
 * each of them is a second rendering of audio that is already playing
 * somewhere — and playing a live microphone twice in one room is an acoustic
 * feedback loop. A remote participant is the opposite: this element is the
 * *only* thing playing their voice, so muting it would make a working mesh
 * look silent.
 */
export function ParticipantTile({
  participant,
  className,
}: {
  participant: RemoteParticipant
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const stream = participant.stream
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) {
      void element.play().catch(() => {
        /*
         * Autoplay with audio can be refused until the page has been
         * interacted with. Joining is a click, so by the time a participant
         * appears that has happened — but a frozen first frame still beats an
         * unhandled rejection.
         */
      })
    }
    return () => {
      // A viewer, not an owner: the peer connection owns these tracks.
      element.srcObject = null
    }
  }, [participant.stream])

  return (
    <figure
      className={cn(
        'relative m-0 flex aspect-video w-full items-center justify-center overflow-hidden border border-deck-700 bg-deck-950',
        className,
      )}
    >
      {participant.stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          aria-label={`${participant.label}'s camera`}
          // `h-full w-full`, not `max-h-full`: a max-* pair caps the element at
          // its intrinsic size, so a 1280×720 feed refuses to grow into a
          // larger tile and sits small in the middle of it.
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex flex-col items-center gap-1.5 text-ink-500">
          <VideoOff aria-hidden="true" className="h-6 w-6" />
          <p className="text-[11px]">Connecting…</p>
        </div>
      )}

      <figcaption className="absolute bottom-0 left-0 max-w-full truncate bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">
        {participant.label}
        {participant.role === 'director' ? ' · director' : ''}
      </figcaption>
    </figure>
  )
}
