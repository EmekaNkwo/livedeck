import { Check, ClipboardCopy } from 'lucide-react'
import { useState } from 'react'
import type { SessionSnapshot } from '@/media/types'
import { Button } from '@/components/shared/Button'
import { Notice } from '@/components/shared/Status'

/**
 * Guest invitation.
 *
 * Both sides join a room by name and the media server introduces them, so
 * there is nothing to copy back and forth: one link for guests, one for
 * producers who may control them. The panel also shows the session's own
 * state, because the server is a dependency that can be down and an operator
 * needs to know that before sending anyone a link.
 */

export type RoomInvitePanelProps = {
  room: string
  serverUrl: string
  snapshot: SessionSnapshot
  supported: boolean
  guestLink: string
  producerLink: string | null
}

type Presentation = { tone: 'info' | 'warning' | 'error'; label: string; detail: string }

function describe(snapshot: SessionSnapshot, serverUrl: string): Presentation {
  if (snapshot.status === 'failed') {
    return {
      tone: 'error',
      label: 'Could not reach the media server',
      detail:
        snapshot.error ??
        `No connection to ${serverUrl}. Check that the server is running and that the address and allowed origins are right.`,
    }
  }
  if (snapshot.status === 'recovering' || snapshot.signaling === 'reconnecting') {
    return {
      tone: 'warning',
      label: 'Reconnecting to the media server…',
      detail: 'The connection dropped and is being retried. Guests already in the room are kept for a short grace period.',
    }
  }
  if (snapshot.status === 'joined') {
    return {
      tone: 'info',
      label: snapshot.role === 'director' ? 'In the room as director' : `In the room as ${snapshot.role ?? 'guest'}`,
      detail:
        snapshot.role === 'director'
          ? 'Guests who open the link below appear automatically. The guest list reports whether their media is arriving.'
          : 'This control room does not hold the director key for this room, so it cannot control guests. Open the room with the director link to take over.',
    }
  }
  if (snapshot.status === 'connecting' || snapshot.status === 'joining') {
    return { tone: 'warning', label: 'Connecting to the media server…', detail: `Reaching ${serverUrl}.` }
  }
  if (snapshot.status === 'closed' && snapshot.closedBecause) {
    return { tone: 'warning', label: 'The server closed this session', detail: `Reason: ${snapshot.closedBecause}. Reload to rejoin.` }
  }
  return { tone: 'warning', label: 'Not connected yet', detail: 'The room has not been joined.' }
}

function LinkBox({ id, title, url, hint }: { id: string; title: string; url: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copy = async () => {
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyFailed(true)
    }
  }
  return (
    <div className="flex flex-col gap-2 border border-accent-600 bg-accent-500/5 p-2.5">
      <p className="text-[10px] font-semibold tracking-wider text-accent-400 uppercase">{title}</p>
      <label className="sr-only" htmlFor={id}>
        {title}
      </label>
      <input
        id={id}
        type="text"
        readOnly
        value={url}
        onFocus={(event) => event.currentTarget.select()}
        className="url-box w-full border border-deck-600 bg-deck-950 px-2 py-1.5 text-ink-300"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void copy()}>
          {copied ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      {copyFailed ? (
        <p className="text-[11px] text-live-400">
          Clipboard access was refused — select the link above and copy it manually.
        </p>
      ) : null}
      <span aria-live="polite" className="sr-only-live">
        {copied ? `${title} copied to clipboard` : ''}
      </span>
      <p className="text-[10px] leading-relaxed text-ink-500">{hint}</p>
    </div>
  )
}

export function RoomInvitePanel({
  room,
  serverUrl,
  snapshot,
  supported,
  guestLink,
  producerLink,
}: RoomInvitePanelProps) {
  const status = describe(snapshot, serverUrl || 'the configured server')

  if (!supported) {
    return (
      <Notice tone="warning">
        This browser does not support WebRTC, so guests cannot connect. Everything else — capture,
        composition, the mixer and recording — still works.
      </Notice>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Notice tone={status.tone}>
        <strong className="text-ink-200">{status.label}. </strong>
        {status.detail}
      </Notice>

      <LinkBox
        id="room-join-link"
        title="Guest link"
        url={guestLink}
        hint="Send it to anyone. They set a name, click Join room, and appear in the list above. They can see and hear each other and cannot control anyone."
      />

      {producerLink ? (
        <LinkBox
          id="room-producer-link"
          title="Producer link"
          url={producerLink}
          hint="For a co-host who should be able to mute, cue and rename guests. Treat it like a password: anyone holding it has those controls."
        />
      ) : null}

      <Notice tone="warning">
        <strong className="text-ink-200">The room name is not access control. </strong>
        Anyone who reaches the media server and guesses <code className="url-box">{room}</code>{' '}
        joins as a guest. Roles are decided by the server from the key in the link, never by the
        guest&apos;s browser.
      </Notice>
    </div>
  )
}
