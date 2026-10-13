import {
  Check,
  Copy,
  Keyboard,
  LogOut,
  Radio,
  RotateCcw,
  Settings,
  Terminal,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useRecordingStore } from '@/stores/recordingStore'
import { useStudioStore } from '@/stores/studioStore'
import { useGuestStore, countConnectedPeers } from '@/stores/guestStore'
import { Button } from '@/components/shared/Button'
import { TextField } from '@/components/shared/Field'
import { Badge, StatusDot } from '@/components/shared/Status'

/**
 * The top session bar.
 *
 * Shows mode, session identity and the on-air state. The ON AIR indicator is
 * driven by the recorder's real status, so it cannot be lit while nothing is
 * being recorded.
 */

export function SessionBar() {
  const navigate = useNavigate()
  const session = useStudioSession()
  const openDialog = useStudioStore((state) => state.openDialog)
  const showToast = useStudioStore((state) => state.showToast)
  const recordingStatus = useRecordingStore((state) => state.status)
  const connectedPeers = useGuestStore(countConnectedPeers)

  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [copied, setCopied] = useState(false)

  const current = session.session
  const recording = recordingStatus === 'recording' || recordingStatus === 'paused'

  const copySessionDetails = async () => {
    if (!current) return
    const details = `LiveDeck session “${current.name}” · ID ${current.id} · mode: ${
      current.mode === 'peer' ? 'Peer Connection' : 'Local Studio'
    }`
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast('Could not access the clipboard. Select the session ID to copy it.', 'error')
    }
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-deck-700 bg-deck-900 px-3">
      <div className="flex items-center gap-2">
        <Radio aria-hidden="true" className="h-4 w-4 text-accent-400" />
        <span className="text-sm font-semibold tracking-tight text-ink-100">
          LiveDeck<span className="text-accent-400"> Studio</span>
        </span>
      </div>

      <div className="h-5 w-px bg-deck-700" aria-hidden="true" />

      {/* Session identity. */}
      {current ? (
        <div className="flex min-w-0 items-center gap-2">
          {editingName ? (
            <>
              <TextField
                label="Session name"
                srOnlyLabel
                value={draftName}
                onChange={setDraftName}
                className="w-48"
              />
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  session.renameSession(draftName)
                  setEditingName(false)
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setDraftName(current.name)
                  setEditingName(true)
                }}
                className="max-w-56 truncate text-xs font-medium text-ink-200 hover:text-ink-100"
                title="Rename this session"
              >
                {current.name}
              </button>

              <code
                className="rounded bg-deck-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-400"
                // Stated plainly, because a short ID looks like a credential
                // and is not one.
                title="Session ID — a label for coordinating a production, not a password"
              >
                {current.id}
              </code>

              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void copySessionDetails()}
                aria-label="Copy session details"
                title="Copy session details"
              >
                {copied ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5 text-ok-400" />
                ) : (
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </Button>
            </>
          )}
        </div>
      ) : null}

      {/* Mode switch. */}
      {current ? (
        <div className="flex items-center gap-1" role="group" aria-label="Operation mode">
          <Button
            size="sm"
            variant="outline"
            active={current.mode === 'local'}
            aria-pressed={current.mode === 'local'}
            onClick={() => session.setMode('local')}
            title="All capture, composition and recording happen on this device. No signaling needed."
          >
            Local Studio
          </Button>
          <Button
            size="sm"
            variant="outline"
            active={current.mode === 'peer'}
            aria-pressed={current.mode === 'peer'}
            onClick={() => session.setMode('peer')}
            title="Connect another browser using manual signaling."
          >
            Peer Connection
          </Button>
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {connectedPeers > 0 ? (
          <Badge tone="ok">
            {connectedPeers} peer{connectedPeers === 1 ? '' : 's'} connected
          </Badge>
        ) : null}

        {/* ON AIR / READY. Also announced politely for screen readers. */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1',
            recording ? 'bg-live-500/15 ring-1 ring-live-500/40' : 'bg-deck-800',
          )}
        >
          {recording ? (
            <>
              <span className="h-2 w-2 animate-live-pulse rounded-full bg-live-500" />
              <span className="text-[11px] font-bold tracking-wider text-live-400 uppercase">
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
          aria-label="Reset this production"
          title="Reset production"
        >
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => session.requestEndSession(() => navigate('/'))}
          aria-label="End this production"
          title="End production and release all devices"
          className="hover:text-live-400"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
