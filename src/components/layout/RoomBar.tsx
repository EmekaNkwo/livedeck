import { Check, Copy, Keyboard, LogOut, Radio, RotateCcw, Settings, Terminal } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { useInviteLink } from '@/hooks/useInviteLink'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useRecordingStore } from '@/stores/recordingStore'
import { useStudioStore } from '@/stores/studioStore'
import { useGuestStore, countConnectedPeers } from '@/stores/guestStore'
import { Button } from '@/components/shared/Button'
import { StatusDot } from '@/components/shared/Status'

/**
 * The control-room header.
 *
 * Room-centric rather than session-centric: the room name *is* the identity,
 * and it is shown as the path it appears at, because that path is what gets
 * shared. The ON AIR tally is driven by the recorder's real status, so it
 * cannot light while nothing is being recorded.
 */
export function RoomBar({ room }: { room: string }) {
  const navigate = useNavigate()
  const session = useStudioSession()
  const invite = useInviteLink()

  const openDialog = useStudioStore((state) => state.openDialog)
  const recordingStatus = useRecordingStore((state) => state.status)
  const connectedPeers = useGuestStore(countConnectedPeers)

  const [copied, setCopied] = useState(false)

  const recording = recordingStatus === 'recording' || recordingStatus === 'paused'
  const directorUrl = invite.roleLink('director', room)

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-deck-700 bg-deck-900 px-3">
      <div className="flex items-center gap-2">
        <Radio aria-hidden="true" className="h-4 w-4 text-accent-400" />
        <span className="text-sm font-semibold tracking-tight text-ink-100">
          LiveDeck<span className="text-accent-400"> Studio</span>
        </span>
      </div>

      <div className="h-5 w-px bg-deck-700" aria-hidden="true" />

      {/* The room, shown as the path it lives at. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <code className="url-box truncate text-ink-300">/director/</code>
        <code className="url-box font-semibold text-accent-400">{room}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void invite.copy(directorUrl).then((ok) => {
              setCopied(ok)
              if (ok) setTimeout(() => setCopied(false), 2000)
            })
          }}
          aria-label="Copy the director link for this room"
          title="Copy director link"
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5 text-ok-400" />
          ) : (
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {connectedPeers > 0 ? (
          <span className="bg-ok-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ok-400 uppercase">
            {connectedPeers} connected
          </span>
        ) : null}

        <div
          className={cn(
            'flex items-center gap-2 px-2 py-1',
            recording ? 'bg-live-500/15 ring-1 ring-live-500/40' : 'bg-deck-800',
          )}
        >
          {recording ? (
            <>
              <span className="h-2 w-2 animate-live-pulse rounded-full bg-live-500" />
              <span className="text-[10px] font-bold tracking-wider text-live-400 uppercase">
                {recordingStatus === 'paused' ? 'Paused' : 'On air'}
              </span>
            </>
          ) : (
            <StatusDot tone="idle" label="Ready" />
          )}
        </div>
        <span aria-live="polite" className="sr-only-live">
          {recording ? 'Recording in progress' : ''}
        </span>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => openDialog('command-palette')}
          aria-label="Open the command palette"
          title="Command palette (Ctrl/Cmd + K)"
        >
          <Terminal aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openDialog('shortcuts')}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <Keyboard aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openDialog('settings')}
          aria-label="Studio settings"
          title="Settings"
        >
          <Settings aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={session.requestResetSession}
          aria-label="Reset this room"
          title="Reset room"
        >
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => session.requestEndSession(() => navigate('/'))}
          aria-label="Leave this room"
          title="Leave room and release all devices"
          className="hover:text-live-400"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
