import { Check, ClipboardCopy } from 'lucide-react'
import { useState } from 'react'
import type { TransportState } from '@/services/signaling/types'
import { Button } from '@/components/shared/Button'
import { Notice } from '@/components/shared/Status'

/**
 * Guest invitation when a signaling server is in play.
 *
 * With a relay there is nothing to copy back and forth: both sides join a room
 * by name and the server introduces them. So this panel shows a plain join URL
 * and, more importantly, the *transport's own state* — because unlike the manual
 * flow, this one has a dependency that can be down, and the operator needs to
 * know that before they send anyone a link.
 */

export type RoomInvitePanelProps = {
  room: string
  serverUrl: string
  transportState: TransportState
  supported: boolean
}

type TransportPresentation = {
  tone: 'info' | 'warning' | 'error'
  label: string
  detail: string
}

/**
 * Describe the transport honestly.
 *
 * `connected` means connected to the *relay* — not that any guest has joined,
 * and not that media is flowing. Conflating those is exactly the false-connected
 * display this project is meant to avoid, so the wording keeps them apart.
 */
function describe(state: TransportState, serverUrl: string): TransportPresentation {
  switch (state) {
    case 'connected':
      return {
        tone: 'info',
        label: 'Connected to the signaling server',
        detail:
          'Guests who open the link below will appear automatically. This says nothing about ' +
          'whether any media has connected yet — the guest list reports that separately.',
      }
    case 'connecting':
      return {
        tone: 'warning',
        label: 'Connecting to the signaling server…',
        detail: `Reaching ${serverUrl}. Guests cannot be introduced until this succeeds.`,
      }
    case 'reconnecting':
      return {
        tone: 'warning',
        label: 'Reconnecting to the signaling server…',
        detail:
          'The socket dropped and is being retried with backoff. Guests already negotiated stay ' +
          'connected — their media is peer-to-peer and does not pass through the server. New ' +
          'guests cannot join until this recovers.',
      }
    case 'failed':
      return {
        tone: 'error',
        label: 'Could not reach the signaling server',
        detail:
          `No connection to ${serverUrl}. Check that the server in this repo is running and that ` +
          'the address and allowed origins are right. Until then, switch Signaling to Manual in ' +
          'Settings to invite guests with a link instead.',
      }
    case 'closed':
      return {
        tone: 'warning',
        label: 'Signaling connection closed',
        detail: 'The server closed the connection. Reload to rejoin the room.',
      }
    case 'idle':
    default:
      return {
        tone: 'warning',
        label: 'Not connected yet',
        detail: 'The room has not been joined.',
      }
  }
}

export function RoomInvitePanel({
  room,
  serverUrl,
  transportState,
  supported,
}: RoomInvitePanelProps) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  // Guests get the push view for this room. No fragment: the relay carries the
  // handshake, so there is nothing secret to smuggle past the server.
  const joinUrl = `${window.location.origin}/push/${encodeURIComponent(room)}`
  const status = describe(transportState, serverUrl || 'the configured server')

  const copy = async () => {
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(joinUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Permissions, an insecure context, or no user activation. The textarea
      // below stays selectable so this is recoverable.
      setCopyFailed(true)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {!supported ? (
        <Notice tone="warning">
          This browser does not support RTCPeerConnection, so guests cannot connect. Everything
          else — capture, composition, the mixer and recording — still works.
        </Notice>
      ) : (
        <>
          <Notice tone={status.tone}>
            <strong className="text-ink-200">{status.label}. </strong>
            {status.detail}
          </Notice>

          {/*
            One control, one link.
            ----------------------
            There is deliberately no guest-name field and no per-guest options.
            The link is the room, so it is reusable and the same for everybody —
            baking a name into it would be wrong the moment it is forwarded, and
            guests name themselves on the join screen anyway.
          */}
          <div className="flex flex-col gap-2 border border-accent-600 bg-accent-500/5 p-2.5">
            <p className="text-[10px] font-semibold tracking-wider text-accent-400 uppercase">
              Room link
            </p>
            <label className="sr-only" htmlFor="room-join-link">
              Guest join link
            </label>
            <input
              id="room-join-link"
              type="text"
              readOnly
              value={joinUrl}
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
                {copied ? 'Copied' : 'Copy room link'}
              </Button>
              <span className="font-mono text-[10px] text-ink-500">room · {room}</span>
            </div>
            {copyFailed ? (
              <p className="text-[11px] text-live-400">
                Clipboard access was refused — select the link above and copy it manually.
              </p>
            ) : null}
            <span aria-live="polite" className="sr-only-live">
              {copied ? 'Room link copied to clipboard' : ''}
            </span>
            <p className="text-[10px] leading-relaxed text-ink-500">
              Send it to anyone. They set a name, click <strong>Join room</strong>, and appear in
              the list above — nothing to copy back.
            </p>
          </div>

          <Notice tone="warning">
            <strong className="text-ink-200">The room link is the only access control. </strong>
            Anyone who can reach your signaling server and guesses this room name will join it and
            be offered a connection. There is no account and no token — run the server on a network
            you control if that matters.
          </Notice>

          <Notice>
            <strong className="text-ink-200">Media is still peer-to-peer. </strong>
            The server only relays the text of the handshake. Audio and video go directly between
            browsers, so the same NAT limits apply: without a TURN server, two peers behind
            symmetric NAT will still fail to connect, and the guest list will say <em>failed</em>{' '}
            rather than pretend otherwise.
          </Notice>
        </>
      )}
    </div>
  )
}
