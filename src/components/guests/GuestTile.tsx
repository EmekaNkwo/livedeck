import {
  Eye,
  EyeOff,
  Maximize2,
  Mic,
  MicOff,
  MonitorOff,
  Radio,
  Video,
  VideoOff,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ControlChannelState } from '@/types/room'
import type { GuestView } from '@/hooks/useGuests'
import { cn } from '@/lib/cn'
import { formatMetric } from '@/utils/format'
import { Button } from '@/components/shared/Button'
import { StatusDot } from '@/components/shared/Status'
import type { StatusTone } from '@/components/shared/Status'

/**
 * One guest in the control room.
 *
 * This is the surface a VDO.Ninja director actually works from: a live
 * thumbnail with the controls and the connection numbers on it, not a row in a
 * layer list.
 *
 * The two control kinds are visually separated and separately labelled:
 *  - **Remote** (mic / camera) travel the data channel and change the guest's
 *    own tracks. Disabled, with an explanation, when the control channel is not
 *    open — the UI never offers a command it cannot deliver.
 *  - **Local** (hide / mute in mix) affect only this machine's program output.
 */

export type GuestTileProps = {
  view: GuestView
  control: ControlChannelState | null
  canControlRemotely: boolean
  soloed: boolean
  onToggleRemoteMic: () => void
  onToggleRemoteCamera: () => void
  onToggleLocalMute: () => void
  onToggleLocalHide: () => void
  onSolo: () => void
  onRemove: () => void
  onAddToScene: () => void
  inScene: boolean
}

export function GuestTile({
  view,
  control,
  canControlRemotely,
  soloed,
  onToggleRemoteMic,
  onToggleRemoteCamera,
  onToggleLocalMute,
  onToggleLocalHide,
  onSolo,
  onRemove,
  onAddToScene,
  inScene,
}: GuestTileProps) {
  const { guest, peer, stats, stream, connected, statusLabel } = view
  const videoRef = useRef<HTMLVideoElement | null>(null)

  /**
   * Bind the stream to the preview element.
   *
   * The element is a *viewer* of a stream the StreamRegistry owns, so it
   * detaches on cleanup but never stops the tracks — unmounting a tile must not
   * kill a feed the compositor is still drawing.
   */
  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (element.srcObject !== stream) {
      element.srcObject = stream
    }
    if (stream) {
      void element.play().catch(() => {
        // Autoplay can be refused; the tile shows a static frame instead of
        // throwing, and the compositor is unaffected either way.
      })
    }
    return () => {
      element.srcObject = null
    }
  }, [stream])

  const tone: StatusTone = connected
    ? 'active'
    : peer?.status === 'failed'
      ? 'error'
      : peer
        ? 'pending'
        : 'idle'

  // Reported by the guest over the control channel — their real track state,
  // not what we last asked for.
  const micMuted = control?.reportedMicMuted
  const cameraMuted = control?.reportedCameraMuted

  return (
    <li
      className={cn(
        'flex flex-col border bg-deck-900',
        soloed
          ? 'border-accent-500 ring-1 ring-accent-500'
          : connected
            ? 'border-deck-600'
            : 'border-deck-700',
      )}
    >
      {/* ------------------------------------------------------- preview */}
      <div className="relative aspect-video bg-deck-950">
        {stream && !guest.videoHidden ? (
          <video
            ref={videoRef}
            muted
            playsInline
            // Decorative: the guest's name and status are already text below.
            aria-hidden="true"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-600">
            {guest.videoHidden ? (
              <>
                <MonitorOff aria-hidden="true" className="h-5 w-5" />
                <span className="text-[10px] text-ink-500">Hidden from program</span>
              </>
            ) : (
              <>
                <VideoOff aria-hidden="true" className="h-5 w-5" />
                <span className="text-[10px] text-ink-500">No video</span>
              </>
            )}
          </div>
        )}

        {/* Overlay badges. */}
        <div className="pointer-events-none absolute top-1 left-1 flex flex-wrap items-center gap-1">
          {soloed ? (
            <span className="flex items-center gap-1 bg-accent-500 px-1 py-px text-[9px] font-bold tracking-wide text-deck-950 uppercase">
              <Radio aria-hidden="true" className="h-2.5 w-2.5" />
              Solo
            </span>
          ) : null}
          {cameraMuted ? (
            <span className="bg-live-500 px-1 py-px text-[9px] font-bold tracking-wide text-white uppercase">
              Cam off
            </span>
          ) : null}
          {micMuted ? (
            <span className="bg-live-500 px-1 py-px text-[9px] font-bold tracking-wide text-white uppercase">
              Mic off
            </span>
          ) : null}
        </div>

        {/* Live statistics, straight from getStats(). Dashes where the
            browser reported nothing. */}
        {connected ? (
          <div className="pointer-events-none absolute right-1 bottom-1 flex flex-col items-end gap-px bg-deck-950/80 px-1 py-0.5 font-mono text-[9px] leading-tight text-ink-400">
            <span>{formatMetric(stats?.videoBitrateKbps, 'kbps')}</span>
            <span>{formatMetric(stats?.roundTripTimeMs, 'ms', 0)} rtt</span>
            {control?.latencyMs !== null && control?.latencyMs !== undefined ? (
              <span>{control.latencyMs} ms ctl</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* --------------------------------------------------------- header */}
      <div className="flex items-center gap-1.5 border-t border-deck-700 px-2 py-1.5">
        <StatusDot tone={tone} label={statusLabel} iconOnly />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-100">
          {guest.name}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={`Remove ${guest.name}`}
          className="hover:text-live-400"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>

      <p className="px-2 pb-1.5 text-[10px] leading-snug text-ink-500">{statusLabel}</p>
      {peer?.error ? (
        <p className="px-2 pb-1.5 text-[10px] leading-snug text-live-400">{peer.error}</p>
      ) : null}

      {/* ------------------------------------------------ remote controls */}
      <div className="flex flex-col gap-1 border-t border-deck-800 px-2 py-1.5">
        <p className="text-[9px] font-semibold tracking-wider text-ink-500 uppercase">
          Remote — affects the guest
        </p>
        <div className="flex gap-1">
          <Button
            variant={micMuted ? 'live' : 'secondary'}
            size="sm"
            disabled={!canControlRemotely}
            aria-pressed={micMuted === true}
            onClick={onToggleRemoteMic}
            className="flex-1"
            title={
              canControlRemotely
                ? 'Mute this guest’s microphone on their machine'
                : 'The control channel is not open, so remote commands cannot be delivered'
            }
          >
            {micMuted ? (
              <MicOff aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Mic aria-hidden="true" className="h-3 w-3" />
            )}
            Mic
          </Button>
          <Button
            variant={cameraMuted ? 'live' : 'secondary'}
            size="sm"
            disabled={!canControlRemotely}
            aria-pressed={cameraMuted === true}
            onClick={onToggleRemoteCamera}
            className="flex-1"
            title={
              canControlRemotely
                ? 'Disable this guest’s camera track on their machine'
                : 'The control channel is not open, so remote commands cannot be delivered'
            }
          >
            {cameraMuted ? (
              <VideoOff aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Video aria-hidden="true" className="h-3 w-3" />
            )}
            Cam
          </Button>
        </div>
        {!canControlRemotely ? (
          <p className="text-[10px] leading-snug text-ink-500">
            No control channel. Remote commands need a connected peer.
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------------- local controls */}
      <div className="flex flex-col gap-1 border-t border-deck-800 px-2 py-1.5">
        <p className="text-[9px] font-semibold tracking-wider text-ink-500 uppercase">
          Local — affects my program only
        </p>
        <div className="flex gap-1">
          <Button
            variant={guest.mutedInMix ? 'live' : 'ghost'}
            size="sm"
            aria-pressed={guest.mutedInMix}
            disabled={!view.audioSourceId}
            onClick={onToggleLocalMute}
            className="flex-1"
            title={
              view.audioSourceId
                ? 'Exclude from my program mix. The guest is not told and keeps sending.'
                : 'This guest has no audio track'
            }
          >
            {guest.mutedInMix ? (
              <MicOff aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Mic aria-hidden="true" className="h-3 w-3" />
            )}
            Mix
          </Button>
          <Button
            variant="ghost"
            size="sm"
            active={guest.videoHidden}
            aria-pressed={guest.videoHidden}
            disabled={!view.videoSourceId}
            onClick={onToggleLocalHide}
            className="flex-1"
            title="Hide this guest's video in every scene"
          >
            {guest.videoHidden ? (
              <EyeOff aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Eye aria-hidden="true" className="h-3 w-3" />
            )}
            Show
          </Button>
          <Button
            variant="ghost"
            size="sm"
            active={soloed}
            aria-pressed={soloed}
            disabled={!view.videoSourceId}
            onClick={onSolo}
            title="Fill the program output with this guest"
          >
            <Maximize2 aria-hidden="true" className="h-3 w-3" />
            Solo
          </Button>
        </div>
        {!inScene && view.videoSourceId ? (
          <Button variant="outline" size="sm" onClick={onAddToScene}>
            Add to current scene
          </Button>
        ) : null}
      </div>
    </li>
  )
}
