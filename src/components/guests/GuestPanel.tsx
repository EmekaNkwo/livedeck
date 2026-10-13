import { EyeOff, Eye, Mic, MicOff, UserPlus, Users, Wand2, X } from 'lucide-react'
import { useState } from 'react'
import type { GuestView } from '@/hooks/useGuests'
import { cn } from '@/lib/cn'
import { useGuests } from '@/hooks/useGuests'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { TextField } from '@/components/shared/Field'
import { EmptyState, Notice, SimulatedBadge, StatusDot } from '@/components/shared/Status'
import type { StatusTone } from '@/components/shared/Status'

/**
 * Guests, with honest connection reporting.
 *
 * A guest appearing in this list means only that a guest *row* exists. The
 * status beside each one reflects the real transport: a simulated guest says
 * so, and a peer guest shows its actual `RTCPeerConnection` state rather than
 * being assumed connected.
 */

export function GuestPanel() {
  const guests = useGuests()
  const mode = useStudioStore((state) => state.session?.mode ?? 'local')
  const openDialog = useStudioStore((state) => state.openDialog)
  const collapsed = useStudioStore((state) => state.collapsedPanels.guests)
  const togglePanel = useStudioStore((state) => state.togglePanel)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  return (
    <Panel
      title="Guests"
      badge={
        <span className="font-mono text-[10px] text-ink-500">
          {guests.guests.filter((view) => view.connected).length}/{guests.guests.length}
        </span>
      }
      collapsed={collapsed}
      onToggleCollapsed={() => togglePanel('guests')}
    >
      <div className="flex flex-col gap-2.5">
        {/* The host is always present and is not a guest row. */}
        <div className="flex items-center gap-2 rounded-md border border-deck-700 bg-deck-800 px-2 py-1.5">
          <StatusDot tone="active" label="Host" iconOnly />
          <span className="text-xs font-medium text-ink-100">You (host)</span>
          <span className="ml-auto text-[10px] text-ink-500">Local</span>
        </div>

        {guests.guests.length === 0 ? (
          <EmptyState
            icon={<Users aria-hidden="true" className="h-6 w-6" />}
            title="No guests"
            description={
              mode === 'local'
                ? 'Add a simulated guest to build and test multi-person layouts without a second device.'
                : 'Create an offer and send the code to your guest to connect a real participant.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {guests.guests.map((view) => (
              <GuestRow
                key={view.guest.id}
                view={view}
                renaming={renamingId === view.guest.id}
                draftName={draftName}
                onDraftNameChange={setDraftName}
                onStartRename={() => {
                  setRenamingId(view.guest.id)
                  setDraftName(view.guest.name)
                }}
                onCommitRename={() => {
                  guests.renameGuest(view.guest.id, draftName)
                  setRenamingId(null)
                }}
                onCancelRename={() => setRenamingId(null)}
                onToggleMute={() =>
                  guests.setMutedInMix(view.guest.id, !view.guest.mutedInMix)
                }
                onToggleVideo={() =>
                  guests.setVideoHidden(view.guest.id, !view.guest.videoHidden)
                }
                onRemove={() => guests.requestRemoveGuest(view.guest.id)}
              />
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => guests.addSimulatedGuest()}>
            <Wand2 aria-hidden="true" className="h-3.5 w-3.5" />
            Add simulated guest
          </Button>

          <Button variant="primary" size="sm" onClick={() => openDialog('invite')}>
            <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Connect a real guest
          </Button>
        </div>

        {mode === 'local' ? (
          <Notice>
            You are in <strong className="text-ink-200">Local Studio Mode</strong>. Simulated guests
            are generated on this device — they are real media streams, but they are not remote
            participants. Switch to Peer Connection Mode to connect another browser.
          </Notice>
        ) : (
          <Notice>
            You are in <strong className="text-ink-200">Peer Connection Mode</strong>. Guests
            connect by exchanging connection codes by hand; there is no server involved.
          </Notice>
        )}
      </div>
    </Panel>
  )
}

function GuestRow({
  view,
  renaming,
  draftName,
  onDraftNameChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onToggleMute,
  onToggleVideo,
  onRemove,
}: {
  view: GuestView
  renaming: boolean
  draftName: string
  onDraftNameChange: (value: string) => void
  onStartRename: () => void
  onCommitRename: () => void
  onCancelRename: () => void
  onToggleMute: () => void
  onToggleVideo: () => void
  onRemove: () => void
}) {
  const { guest, peer, connected, statusLabel } = view

  const tone: StatusTone = guest.simulated
    ? 'warning'
    : connected
      ? 'active'
      : peer?.status === 'failed'
        ? 'error'
        : peer
          ? 'pending'
          : 'idle'

  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-2 py-2',
        connected ? 'border-ok-500/30 bg-ok-500/5' : 'border-deck-700 bg-deck-800',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot tone={tone} label={statusLabel} iconOnly />

        {renaming ? (
          <TextField
            label={`Rename ${guest.name}`}
            srOnlyLabel
            value={draftName}
            onChange={onDraftNameChange}
            className="min-w-0 flex-1"
          />
        ) : (
          <button
            type="button"
            onClick={onStartRename}
            className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink-100"
            title="Click to rename"
          >
            {guest.name}
          </button>
        )}

        {guest.simulated ? <SimulatedBadge /> : null}
      </div>

      {/* Status sentence: the one place that states what is actually true. */}
      <p className="text-[11px] leading-snug text-ink-400">{statusLabel}</p>

      {peer?.error ? (
        <p className="text-[11px] leading-snug text-live-400">{peer.error}</p>
      ) : null}

      <div className="flex items-center gap-1">
        <Button
          variant={guest.mutedInMix ? 'live' : 'ghost'}
          size="icon-sm"
          aria-pressed={guest.mutedInMix}
          disabled={!view.audioSourceId}
          onClick={onToggleMute}
          aria-label={
            guest.mutedInMix
              ? `Unmute ${guest.name} in the program mix`
              : `Mute ${guest.name} in the program mix`
          }
          title={
            view.audioSourceId
              ? 'Mute in the local program mix — the guest is not told and keeps sending audio'
              : 'This guest has no audio track'
          }
        >
          {guest.mutedInMix ? (
            <MicOff aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Mic aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          active={guest.videoHidden}
          aria-pressed={guest.videoHidden}
          disabled={!view.videoSourceId}
          onClick={onToggleVideo}
          aria-label={
            guest.videoHidden ? `Show ${guest.name}'s video` : `Hide ${guest.name}'s video`
          }
          title="Hide this guest's video in every scene"
        >
          {guest.videoHidden ? (
            <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Eye aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>

        {renaming ? (
          <>
            <Button size="sm" variant="primary" onClick={onCommitRename}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelRename}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label={`Remove ${guest.name}`}
            className="ml-auto hover:text-live-400"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </li>
  )
}
