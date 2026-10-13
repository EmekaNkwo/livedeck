import { VideoOff } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { SpeakingIndicator } from '@/components/audio/SpeakingIndicator'

/**
 * One cell of the call grid: a video, a caption, and nothing else.
 *
 * Used for every feed a guest sees — the director's program, another
 * participant, and their own camera — because they differ only in *what* they
 * carry, not in how they should be presented. Keeping one component means a
 * fix to how video is sized or how a name is shown lands everywhere at once.
 *
 * MUTED IS A PER-TILE DECISION, AND A LOAD-BEARING ONE
 * ----------------------------------------------------
 * A self-view must be muted: it is a second rendering of audio the microphone
 * is already capturing, and playing a live microphone back into the room is an
 * acoustic feedback loop. A remote tile must *not* be, because it is the only
 * thing playing that person's voice — muting it would make a working mesh look
 * silent. There is no sensible default, so callers say.
 */

export type VideoTileProps = {
  stream: MediaStream | null
  label: string
  /** Play this tile's audio, or not. See the note above — no default. */
  muted: boolean
  /** Mirror the image. For a self-view, which people expect to be a mirror. */
  mirrored?: boolean
  /** Show a speaking ring and glyph. */
  speaking?: boolean
  /** Show the muted glyph instead of the speaking one. */
  micMuted?: boolean
  /** Shown after the name, e.g. "director". */
  badge?: string
  /** What to say when there is no stream. */
  emptyLabel?: string
  className?: string
}

export function VideoTile({
  stream,
  label,
  muted,
  mirrored,
  speaking,
  micMuted,
  badge,
  emptyLabel = 'Camera off',
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) {
      void element.play().catch(() => {
        /*
         * Autoplay with audio can be refused until the page has been
         * interacted with. Joining is a click, so by then it has been — but a
         * frozen first frame still beats an unhandled rejection.
         */
      })
    }
    return () => {
      // A viewer, not an owner: the peer connection or the stream registry
      // owns these tracks and decides when they stop.
      element.srcObject = null
    }
  }, [stream])

  return (
    <figure
      className={cn(
        'relative m-0 flex min-h-0 min-w-0 items-center justify-center overflow-hidden border bg-deck-950 transition-colors',
        speaking && !micMuted ? 'border-accent-400' : 'border-deck-700',
        className,
      )}
    >
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          aria-label={`${label}${badge ? ` (${badge})` : ''}`}
          /*
           * `h-full w-full`, never `max-h-full max-w-full`.
           *
           * A max-* pair caps the element at its *intrinsic* size, so a 720p
           * feed refuses to grow into a larger cell and sits small in the
           * middle of it. Sizing to the cell and letting `object-contain`
           * letterbox fills the space without ever distorting the aspect.
           */
          className={cn('h-full w-full object-contain', mirrored && 'scale-x-[-1]')}
        />
      ) : (
        <div className="flex flex-col items-center gap-1.5 text-ink-500">
          <VideoOff aria-hidden="true" className="h-6 w-6" />
          <p className="px-2 text-center text-[11px] leading-tight">{emptyLabel}</p>
        </div>
      )}

      <figcaption className="absolute bottom-0 left-0 flex max-w-full items-center gap-1 truncate bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">
        {speaking !== undefined ? (
          <SpeakingIndicator speaking={Boolean(speaking)} muted={micMuted} />
        ) : null}
        <span className="truncate">{label}</span>
        {badge ? <span className="shrink-0 text-white/50">· {badge}</span> : null}
      </figcaption>
    </figure>
  )
}
