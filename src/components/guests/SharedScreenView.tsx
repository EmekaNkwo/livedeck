import { MonitorUp } from 'lucide-react'
import { useEffect, useRef } from 'react'

/**
 * Somebody's shared screen, in its own region above the call grid.
 *
 * WHY NOT A CELL IN THE GRID
 * --------------------------
 * A screen is a different kind of thing from a face. It is a different shape
 * (a desktop is not 16:9 and a window is nothing in particular), it is read
 * rather than glanced at, and it needs to be large to be worth sharing at all.
 * Putting it in the grid meant every tile resized the instant anybody started
 * or stopped — the layout lurched, and whoever was speaking jumped somewhere
 * else on screen.
 *
 * Its own region sits above the grid and takes most of the height. Starting
 * and stopping a share then changes one thing instead of rearranging the room.
 */

export type SharedScreen = {
  label: string
  /**
   * The incoming screen, or null when *this* guest is the one sharing.
   *
   * Deliberately not rendered back to the sharer: showing somebody their own
   * screen share is how you get the hall of mirrors — sharing the tab that
   * contains this view renders it inside itself, forever — and they can see
   * their own screen anyway.
   */
  stream: MediaStream | null
  isSelf: boolean
}

export function SharedScreenView({ screen }: { screen: SharedScreen }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (element.srcObject !== screen.stream) element.srcObject = screen.stream
    if (screen.stream) {
      void element.play().catch(() => {
        // Autoplay refused; a frozen first frame beats an exception.
      })
    }
    return () => {
      // A viewer, not an owner — the peer connection owns these tracks.
      element.srcObject = null
    }
  }, [screen.stream])

  return (
    <figure className="relative m-0 flex min-h-0 flex-[3] items-center justify-center overflow-hidden border border-accent-600 bg-deck-950">
      {screen.stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          /*
           * Muted: the sharer's voice arrives on their *camera* tile, which is
           * a separate connection to the same person. Playing this stream's
           * audio as well would double every word they say.
           */
          muted
          aria-label={`${screen.label} is sharing a screen`}
          // Sized to the region, not to the video: a shared desktop can be any
          // shape, and `object-contain` letterboxes whatever it turns out to be.
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-center text-ink-400">
          <MonitorUp aria-hidden="true" className="h-8 w-8 text-accent-400" />
          <p className="text-sm text-ink-200">You are sharing your screen</p>
          <p className="max-w-sm text-[11px] leading-relaxed text-ink-500">
            Everyone else in the room sees it here. Your own copy is not shown back to you — it
            would be a mirror of this window inside itself.
          </p>
        </div>
      )}

      <figcaption className="absolute bottom-0 left-0 max-w-full truncate bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">
        {screen.label} · sharing a screen
      </figcaption>
    </figure>
  )
}
