import { ArrowRight, Check, ClipboardCopy, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { useWebRTC } from '@/hooks/useWebRTC'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Dialog } from '@/components/shared/Dialog'
import { Badge, Notice } from '@/components/shared/Status'

/**
 * The guest connection workflow.
 *
 * This is where the honesty requirements concentrate. There is **no magic
 * invite link**, because there is no server to coordinate through. What the
 * dialog offers is exactly what the implementation does: generate a session
 * description, let the user carry it to the other browser by hand, and accept
 * the reply.
 *
 * It also states the real limitation up front — with STUN only, two peers
 * behind symmetric NAT or a UDP-blocking firewall will not connect, and that
 * needs a TURN relay the project deliberately does not run.
 */

type Role = 'host' | 'guest'

export function InviteDialog() {
  const dialog = useStudioStore((state) => state.dialog)
  const closeDialog = useStudioStore((state) => state.closeDialog)
  const session = useStudioStore((state) => state.session)
  const showToast = useStudioStore((state) => state.showToast)

  const { setMode } = useStudioSession()
  const webrtc = useWebRTC()

  const [role, setRole] = useState<Role>('host')
  const [pastedOffer, setPastedOffer] = useState('')
  const [pastedAnswer, setPastedAnswer] = useState('')

  const open = dialog === 'invite'
  const mode = session?.mode ?? 'local'

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title="Connect a guest"
      description="Peer-to-peer, with no backend. Connection details are exchanged by hand."
      size="lg"
      dismissOnBackdrop={false}
    >
      <div className="flex flex-col gap-4">
        {!webrtc.supported ? (
          <Notice tone="warning">
            This browser does not support RTCPeerConnection, so Peer Connection Mode is
            unavailable. Local Studio Mode, including simulated guests, is unaffected.
          </Notice>
        ) : (
          <>
            {mode !== 'peer' ? (
              <div className="flex flex-col gap-2 rounded-lg border border-warn-500/40 bg-warn-500/5 p-3">
                <p className="text-xs leading-relaxed text-warn-400">
                  This session is in Local Studio Mode. Switch to Peer Connection Mode to connect a
                  real remote participant.
                </p>
                <Button variant="outline" size="sm" onClick={() => setMode('peer')}>
                  Switch to Peer Connection Mode
                </Button>
              </div>
            ) : null}

            {/* Session identity — explicitly not a credential. */}
            <section className="flex flex-col gap-1.5 rounded-lg border border-deck-600 bg-deck-900 p-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                  Session
                </span>
                <code className="rounded bg-deck-800 px-1.5 py-0.5 font-mono text-xs text-accent-400">
                  {session?.id ?? '—'}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(session?.id ?? '')
                      .then(() => showToast('Session ID copied.', 'success'))
                      .catch(() => showToast('Could not copy — select the ID manually.', 'error'))
                  }}
                  aria-label="Copy session ID"
                >
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-ink-500">
                The session ID is a label for keeping track of a production. It is{' '}
                <strong className="text-ink-300">not a password and grants no access</strong> —
                there is no server for it to authenticate against. Media only flows over a peer
                connection that both sides explicitly complete below.
              </p>
            </section>

            {/* Role selector. */}
            <div role="tablist" aria-label="Your role" className="flex gap-1.5">
              <Button
                role="tab"
                aria-selected={role === 'host'}
                variant="outline"
                size="sm"
                active={role === 'host'}
                onClick={() => setRole('host')}
                className="flex-1"
              >
                I am the host
              </Button>
              <Button
                role="tab"
                aria-selected={role === 'guest'}
                variant="outline"
                size="sm"
                active={role === 'guest'}
                onClick={() => setRole('guest')}
                className="flex-1"
              >
                I am joining as a guest
              </Button>
            </div>

            {role === 'host' ? (
              <HostFlow
                webrtc={webrtc}
                pastedAnswer={pastedAnswer}
                onPastedAnswerChange={setPastedAnswer}
              />
            ) : (
              <GuestFlow
                webrtc={webrtc}
                pastedOffer={pastedOffer}
                onPastedOfferChange={setPastedOffer}
              />
            )}

            {/* Real connectivity assessment of the gathered candidates. */}
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
                {!webrtc.connectivity.gatheringComplete ? (
                  <>
                    {' '}
                    Gathering timed out before completing, so the code may contain fewer candidates
                    than ideal.
                  </>
                ) : null}
              </Notice>
            ) : null}

            <Notice tone="warning">
              <strong className="text-ink-200">Known limitation. </strong>
              LiveDeck gathers all ICE candidates before producing a code (vanilla ICE), because
              manual exchange has no channel for incremental candidates. With public STUN servers
              and no TURN relay, a connection will fail if both peers sit behind symmetric NAT or a
              firewall that blocks UDP. When that happens the studio reports{' '}
              <em>failed</em> rather than showing a connected state it cannot justify. Add a TURN
              server in Settings if you need to traverse restrictive networks.
            </Notice>
          </>
        )}
      </div>
    </Dialog>
  )
}

function HostFlow({
  webrtc,
  pastedAnswer,
  onPastedAnswerChange,
}: {
  webrtc: ReturnType<typeof useWebRTC>
  pastedAnswer: string
  onPastedAnswerChange: (value: string) => void
}) {
  const offerReady = webrtc.signaling.localKind === 'offer' && webrtc.signaling.localCode

  return (
    <div className="flex flex-col gap-3">
      <Step
        number={1}
        title="Create an offer"
        description="LiveDeck gathers network candidates, which takes a second or two."
      >
        <Button
          variant="primary"
          size="sm"
          disabled={webrtc.busy}
          onClick={() => void webrtc.createOffer()}
        >
          {webrtc.busy ? 'Gathering candidates…' : 'Create offer'}
        </Button>
      </Step>

      <Step
        number={2}
        title="Send the code to your guest"
        description="Any channel works — chat, email, a message. It is not secret, but it is long."
      >
        <CodeBox
          code={offerReady ? webrtc.signaling.localCode : null}
          emptyLabel="Create an offer first."
          copyState={webrtc.signaling.copyState}
          onCopy={() => void webrtc.signaling.copyLocalCode()}
          label="Host offer code"
        />
      </Step>

      <Step
        number={3}
        title="Paste the guest's answer"
        description="Your guest will send back an answer code. Paste the whole thing."
      >
        <PasteBox
          value={pastedAnswer}
          onChange={onPastedAnswerChange}
          label="Guest answer code"
          placeholder="LD1:…"
          error={webrtc.signaling.inputError}
          actionLabel="Apply answer"
          disabled={webrtc.busy}
          onSubmit={() => void webrtc.acceptAnswerCode(pastedAnswer)}
        />
      </Step>
    </div>
  )
}

function GuestFlow({
  webrtc,
  pastedOffer,
  onPastedOfferChange,
}: {
  webrtc: ReturnType<typeof useWebRTC>
  pastedOffer: string
  onPastedOfferChange: (value: string) => void
}) {
  const answerReady = webrtc.signaling.localKind === 'answer' && webrtc.signaling.localCode

  return (
    <div className="flex flex-col gap-3">
      <Step
        number={1}
        title="Paste the host's offer"
        description="The host will send you an offer code."
      >
        <PasteBox
          value={pastedOffer}
          onChange={onPastedOfferChange}
          label="Host offer code"
          placeholder="LD1:…"
          error={webrtc.signaling.inputError}
          actionLabel="Apply offer and create answer"
          disabled={webrtc.busy}
          onSubmit={() => void webrtc.acceptOfferCode(pastedOffer)}
        />
      </Step>

      <Step
        number={2}
        title="Send your answer back"
        description="The host pastes this into their studio to complete the connection."
      >
        <CodeBox
          code={answerReady ? webrtc.signaling.localCode : null}
          emptyLabel="Apply the host's offer first."
          copyState={webrtc.signaling.copyState}
          onCopy={() => void webrtc.signaling.copyLocalCode()}
          label="Guest answer code"
        />
      </Step>

      <Notice>
        Once the host applies your answer, both sides run ICE connectivity checks. The guest list
        shows the real connection state throughout.
      </Notice>
    </div>
  )
}

function Step({
  number,
  title,
  description,
  children,
}: {
  number: number
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-deck-700 font-mono text-[10px] text-ink-300"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="text-xs font-semibold text-ink-100">
          <span className="sr-only">Step {number}: </span>
          {title}
        </h3>
        <p className="text-[11px] leading-relaxed text-ink-500">{description}</p>
        {children}
      </div>
    </section>
  )
}

/**
 * A copyable code.
 *
 * The textarea is always present and selectable, so there is a manual fallback
 * when the Clipboard API is unavailable or refuses — and the copy button
 * reports failure honestly instead of claiming success.
 */
function CodeBox({
  code,
  emptyLabel,
  copyState,
  onCopy,
  label,
}: {
  code: string | null
  emptyLabel: string
  copyState: 'idle' | 'copied' | 'failed'
  onCopy: () => void
  label: string
}) {
  if (!code) {
    return <p className="text-[11px] text-ink-500 italic">{emptyLabel}</p>
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="sr-only" htmlFor={`code-${label}`}>
        {label}
      </label>
      <textarea
        id={`code-${label}`}
        readOnly
        value={code}
        rows={3}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full resize-y rounded-md border border-deck-600 bg-deck-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-300"
      />
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onCopy}>
          {copyState === 'copied' ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {copyState === 'copied' ? 'Copied' : 'Copy code'}
        </Button>
        {copyState === 'failed' ? (
          <span className="text-[11px] text-live-400">
            Clipboard access was refused — select the text above and copy it manually.
          </span>
        ) : null}
        <Badge tone="neutral" className="ml-auto">
          {code.length} chars
        </Badge>
      </div>
      <span aria-live="polite" className="sr-only-live">
        {copyState === 'copied' ? 'Code copied to clipboard' : ''}
      </span>
    </div>
  )
}

function PasteBox({
  value,
  onChange,
  label,
  placeholder,
  error,
  actionLabel,
  disabled,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder: string
  error: string | null
  actionLabel: string
  disabled: boolean
  onSubmit: () => void
}) {
  const id = `paste-${label.replace(/\s+/g, '-')}`
  return (
    <div className="flex flex-col gap-1.5">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        placeholder={placeholder}
        rows={3}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'w-full resize-y rounded-md border bg-deck-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-200',
          error ? 'border-live-500' : 'border-deck-600',
        )}
      />
      {error ? (
        <p role="alert" className="text-[11px] leading-snug text-live-400">
          {error}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={disabled || !value.trim()}
        onClick={onSubmit}
        className="self-start"
      >
        {actionLabel}
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
