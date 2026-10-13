import { Check, ClipboardCopy, Link2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import type { UseWebRTC } from '@/hooks/useWebRTC'
import { useInviteLink } from '@/hooks/useInviteLink'
import { resolveRelayUrl } from '@/services/signaling/relay-url'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Notice } from '@/components/shared/Status'
import { RoomInvitePanel } from '@/components/guests/RoomInvitePanel'

/**
 * Guest invitation, link-first.
 *
 * This is the VDO.Ninja interaction: you generate a link, you send it, they
 * open it. What makes it work without a backend is that the link *carries the
 * offer* in its fragment — see `services/signaling/invite-link.ts`.
 *
 * The honest part: there is still a return step. The guest's answer has to come
 * back, because no server can carry it. That is presented as one more link to
 * click rather than a blob to paste into the right box.
 *
 * When a signaling server is configured none of that applies — there is no code
 * to copy and no answer to paste — so the whole flow is handed to
 * {@link RoomInvitePanel} rather than left on screen as dead controls.
 */

export type InvitePanelProps = {
  room: string
  webrtc: UseWebRTC
}

export function InvitePanel({ room, webrtc }: InvitePanelProps) {
  const invite = useInviteLink()
  const showToast = useStudioStore((state) => state.showToast)
  // Resolved, not raw: the setting is blank by default and the panel reports
  // the address it is actually dialling, which is what an operator needs when
  // the relay is not answering.
  const configuredUrl = useSettingsStore((state) => state.settings.signalingServerUrl)
  const serverUrl = resolveRelayUrl(configuredUrl)

  const [answerPaste, setAnswerPaste] = useState('')

  /**
   * Create an offer, then wrap it in a link.
   *
   * `createOffer` publishes through the signaling adapter, which is what makes
   * the raw code available; the link is built from the same envelope.
   */
  const createInvite = async () => {
    // `createOffer` returns the envelope directly. Reading it back off the
    // hook would see the previous render's value, since React has not
    // re-rendered by the time this resolves.
    const envelope = await webrtc.createOffer()
    if (!envelope) {
      showToast('No offer was produced, so an invite link could not be built.', 'error')
      return
    }
    // No per-guest options are baked into the link. The guest names themselves
    // on the join screen, which is both fewer fields here and the only version
    // that stays correct when one link is sent to several people.
    await invite.buildGuestInvite(envelope, room)
  }

  if (webrtc.signaling.capabilities.supportsRooms) {
    return (
      <RoomInvitePanel
        room={room}
        serverUrl={serverUrl}
        transportState={webrtc.signaling.transportState}
        supported={webrtc.supported}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {!webrtc.supported ? (
        <Notice tone="warning">
          This browser does not support RTCPeerConnection, so guests cannot connect. Everything
          else — capture, composition, the mixer and recording — still works.
        </Notice>
      ) : (
        <>
          {/* ------------------------------------------------ generate */}
          <div className="flex flex-col gap-2 border border-deck-700 bg-deck-900 p-2.5">
            <p className="text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
              Invite a guest
            </p>
            <p className="text-[11px] leading-relaxed text-ink-400">
              This room has no signaling server, so a link has to carry the connection details
              itself — which means one link per guest, and a reply to apply. Switch Signaling to{' '}
              <strong className="text-ink-200">Signaling server</strong> in Settings for a single
              reusable room link instead.
            </p>

            <Button
              variant="primary"
              size="sm"
              disabled={webrtc.busy || invite.building}
              onClick={() => void createInvite()}
            >
              <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
              {webrtc.busy || invite.building ? 'Gathering candidates…' : 'Create invite link'}
            </Button>
          </div>

          {/* ------------------------------------------------------- the link */}
          {invite.link ? (
            <div className="flex flex-col gap-2 border border-accent-600 bg-accent-500/5 p-2.5">
              <p className="text-[10px] font-semibold tracking-wider text-accent-400 uppercase">
                Step 1 · Send this link to your guest
              </p>
              <label className="sr-only" htmlFor="invite-link">
                Guest invite link
              </label>
              <textarea
                id="invite-link"
                readOnly
                rows={3}
                value={invite.link.url}
                onFocus={(event) => event.currentTarget.select()}
                className="url-box w-full resize-y border border-deck-600 bg-deck-950 px-2 py-1.5 text-ink-300"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void invite.copy()}>
                  {invite.copied ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {invite.copied ? 'Copied' : 'Copy link'}
                </Button>
                <span className="font-mono text-[10px] text-ink-500">
                  {invite.link.length} chars
                  {invite.link.compressed ? ' · compressed' : ' · uncompressed'}
                </span>
              </div>
              {invite.copyFailed ? (
                <p className="text-[11px] text-live-400">
                  Clipboard access was refused — select the link above and copy it manually.
                </p>
              ) : null}
              <span aria-live="polite" className="sr-only-live">
                {invite.copied ? 'Invite link copied to clipboard' : ''}
              </span>
              <p className="text-[10px] leading-relaxed text-ink-500">
                The connection details ride in the part after <code className="url-box">#</code>,
                which browsers never send to a server — so the offer stays between the two of you
                even on shared hosting.
              </p>
            </div>
          ) : null}

          {/* ----------------------------------------------------- step two */}
          <div className="flex flex-col gap-2 border border-deck-700 bg-deck-900 p-2.5">
            <p className="text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
              Step 2 · Paste the link they send back
            </p>
            <p className="text-[11px] leading-relaxed text-ink-400">
              With no server, their answer has to travel back by hand. They will get a
              one-click link — paste it here, or just open it.
            </p>
            <label className="sr-only" htmlFor="answer-paste">
              Guest answer link or code
            </label>
            <textarea
              id="answer-paste"
              rows={3}
              value={answerPaste}
              placeholder="https://…/director/room#a=…"
              onChange={(event) => setAnswerPaste(event.target.value)}
              aria-invalid={webrtc.signaling.inputError ? true : undefined}
              className={cn(
                'url-box w-full resize-y border bg-deck-950 px-2 py-1.5 text-ink-200',
                webrtc.signaling.inputError ? 'border-live-500' : 'border-deck-600',
              )}
            />
            {webrtc.signaling.inputError ? (
              <p role="alert" className="text-[11px] leading-snug text-live-400">
                {webrtc.signaling.inputError}
              </p>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              disabled={webrtc.busy || !answerPaste.trim()}
              onClick={() => void webrtc.acceptAnswerInput(answerPaste)}
            >
              Connect guest
            </Button>
          </div>

          {/* ------------------------------------------- ICE assessment */}
          {webrtc.connectivity ? (
            <Notice
              tone={
                webrtc.connectivity.level === 'good'
                  ? 'info'
                  : webrtc.connectivity.level === 'limited'
                    ? 'warning'
                    : 'error'
              }
            >
              <strong className="text-ink-200">ICE gathering: </strong>
              {webrtc.connectivity.message}
              {!webrtc.connectivity.gatheringComplete
                ? ' Gathering also timed out, so the link may carry fewer candidates than ideal.'
                : ''}
            </Notice>
          ) : null}

          {/*
            Two separate constraints, kept apart because only one of them is
            actually unavoidable now.

            The vanilla-ICE one is a property of *this transport* and the server
            mode removes it, so presenting it as a flat "known limitation" would
            be out of date. The NAT one is real in both modes.
          */}
          <Notice>
            <strong className="text-ink-200">Why this takes a moment. </strong>
            A link cannot deliver ICE candidates one at a time, so every candidate is gathered
            before the link is made. Switching to a signaling server in Settings lets them trickle
            instead, which connects in about a second — at the cost of running the server.
          </Notice>

          <Notice tone="warning">
            <strong className="text-ink-200">Known limitation. </strong>
            With public STUN and no TURN relay, the connection will fail if both sides sit behind
            symmetric NAT or a firewall that blocks UDP — the guest list reports <em>failed</em>{' '}
            rather than pretending otherwise. This applies with or without a signaling server,
            since media is peer-to-peer either way. Add a TURN server in Settings to traverse
            those networks.
          </Notice>
        </>
      )}
    </div>
  )
}
