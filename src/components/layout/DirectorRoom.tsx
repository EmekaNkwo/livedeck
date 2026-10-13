import {
  ExternalLink,
  Layers,
  Megaphone,
  PanelRightClose,
  Radio,
  Settings,
  Sliders,
  Users,
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { useDirectorControl } from '@/hooks/useDirectorControl'
import { useGuests } from '@/hooks/useGuests'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useInviteLink } from '@/hooks/useInviteLink'
import { useMediaSources } from '@/hooks/useMediaSources'
import { useProgramPublisher } from '@/hooks/useProgramMirror'
import { useRecording } from '@/hooks/useRecording'
import { useSceneManager } from '@/hooks/useSceneManager'
import { useScreenShare } from '@/hooks/useScreenShare'
import { useSolo } from '@/hooks/useSolo'
import { useSourceTransform } from '@/hooks/useSourceTransform'
import type { UseWebRTC } from '@/hooks/useWebRTC'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'

import { Button } from '@/components/shared/Button'
import { EmptyState, Notice } from '@/components/shared/Status'
import { AudioMixerPanel } from '@/components/audio/AudioMixerPanel'
import { GuestTile } from '@/components/guests/GuestTile'
import { InvitePanel } from '@/components/guests/InvitePanel'
import { RecordingControls } from '@/components/recording/RecordingControls'
import { SceneStrip } from '@/components/scenes/SceneStrip'
import { CaptureControls } from '@/components/sources/CaptureControls'
import { PropertiesPanel } from '@/components/sources/PropertiesPanel'
import { SourceList } from '@/components/sources/SourceList'
import { ProgramCanvas } from '@/components/studio/ProgramCanvas'
import { RoomBar } from './RoomBar'

/**
 * The director's control room.
 *
 * VDO.Ninja's director is guest-first: the page you spend time on is a grid of
 * live guest tiles with their controls and connection numbers on them. The
 * production surfaces — scene editor, mixer, recorder — live behind tabs, so
 * they are one click away without crowding the thing you actually watch.
 *
 * This component owns the global hotkey wiring, because shortcuts reach across
 * tabs and belong at the level that can see all of them.
 */

const lazyPanel = <T extends Record<string, React.ComponentType>>(
  loader: () => Promise<T>,
  name: keyof T,
) => lazy(() => loader().then((module) => ({ default: module[name] })))

const DiagnosticsPanel = lazyPanel(
  () => import('@/components/diagnostics/DiagnosticsPanel'),
  'DiagnosticsPanel',
)
const SettingsDialog = lazyPanel(
  () => import('@/components/studio/SettingsDialog'),
  'SettingsDialog',
)
const ShortcutsDialog = lazyPanel(
  () => import('@/components/studio/ShortcutsDialog'),
  'ShortcutsDialog',
)
const AddSourceDialog = lazyPanel(
  () => import('@/components/sources/AddSourceDialog'),
  'AddSourceDialog',
)
const RecordingLibraryDialog = lazyPanel(
  () => import('@/components/recording/RecordingLibrary'),
  'RecordingLibraryDialog',
)
const CommandPalette = lazyPanel(
  () => import('@/components/studio/CommandPalette'),
  'CommandPalette',
)

type Tab = 'guests' | 'scenes' | 'mix' | 'sources' | 'diagnostics'

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'guests', label: 'Guests', icon: <Users aria-hidden="true" className="h-3.5 w-3.5" /> },
  { id: 'scenes', label: 'Scenes', icon: <Layers aria-hidden="true" className="h-3.5 w-3.5" /> },
  { id: 'mix', label: 'Mix & record', icon: <Sliders aria-hidden="true" className="h-3.5 w-3.5" /> },
  {
    id: 'sources',
    label: 'Sources',
    icon: <Radio aria-hidden="true" className="h-3.5 w-3.5" />,
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    icon: <Settings aria-hidden="true" className="h-3.5 w-3.5" />,
  },
]

export type DirectorRoomProps = {
  room: string
  webrtc: UseWebRTC
}

export function DirectorRoom({ room, webrtc }: DirectorRoomProps) {
  const [tab, setTab] = useState<Tab>('guests')
  const [cueText, setCueText] = useState('')

  /*
   * The side panel is collapsible, and that is a sizing decision rather than a
   * cosmetic one.
   *
   * The program canvas is almost always *width*-limited: at 16:9 in a typical
   * window there is spare vertical space, and the binding constraint is how
   * much width the panel leaves behind. Collapsing it to a rail gives the video
   * roughly a third more height. The rail keeps the tab icons, so reopening
   * lands on the panel you wanted.
   */
  const [panelCollapsed, setPanelCollapsed] = useState(false)

  const guests = useGuests()

  /*
   * Mirror the program output to any scene window open on this room.
   *
   * Lives here rather than in a panel because a scene window has to keep
   * receiving frames while the operator is on the Mixer or Sources tab — and
   * because this component is mounted for exactly as long as the control room
   * owns a program output.
   */
  useProgramPublisher(room)
  const director = useDirectorControl()
  const solo = useSolo()
  const scenes = useSceneManager()
  const recording = useRecording()
  const screen = useScreenShare()
  const sources = useMediaSources()
  const invite = useInviteLink()

  const selectedSourceId = useStudioStore((state) => state.selectedSourceId)
  const openDialog = useStudioStore((state) => state.openDialog)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)
  const transform = useSourceTransform(selectedSourceId)

  const deleteSelection = useCallback(() => {
    if (!selectedSourceId) return
    const source = useSourceStore.getState().sources[selectedSourceId]
    if (!source) return
    requestConfirm({
      title: `Delete “${source.name}”?`,
      message:
        'The source will be removed from every scene and its capture released if nothing else is ' +
        'using it. This cannot be undone.',
      confirmLabel: 'Delete source',
      destructive: true,
      onConfirm: () => sources.removeSource(selectedSourceId),
    })
  }, [requestConfirm, selectedSourceId, sources])

  useHotkeys({
    toggleRecording: () => (recording.isRecording ? recording.stop() : void recording.start()),
    toggleScreenShare: () => void screen.toggle(),
    openCommandPalette: () => openDialog('command-palette'),
    deleteSelection,
    nextScene: () => scenes.stepScene(1),
    previousScene: () => scenes.stepScene(-1),
    nudgeSelection: (dx, dy) => transform.nudge(dx, dy),
    toggleSelectionVisibility: () => transform.setVisible(!(transform.item?.visible ?? true)),
    toggleSelectionLock: () => transform.setLocked(!(transform.item?.locked ?? false)),
  })

  /**
   * Keep guests informed about whether they are live.
   *
   * A guest seeing a genuine on-air tally is the single most useful thing a
   * director can send them, and it costs one message per state change.
   */
  useEffect(() => {
    director.broadcastOnAir(recording.isRecording)
  }, [director, recording.isRecording])

  const connectedCount = guests.guests.filter((view) => view.connected).length

  return (
    <div className="flex h-full flex-col bg-deck-950">
      <RoomBar room={room} />

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row">
        {/* ------------------------------------------- program + scenes */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <ProgramCanvas />

          {solo.soloedSourceId ? (
            <div className="flex shrink-0 items-center gap-2 border border-accent-600 bg-accent-500/10 px-2.5 py-1.5">
              <Radio aria-hidden="true" className="h-3.5 w-3.5 text-accent-400" />
              <p className="flex-1 text-[11px] text-accent-400">
                Soloed — every other source in this scene is hidden.
              </p>
              <Button variant="outline" size="sm" onClick={solo.clearSolo}>
                Exit solo
              </Button>
            </div>
          ) : null}

          <SceneStrip />
        </div>

        {/* ------------------------------------------- collapsed rail */}
        {panelCollapsed ? (
          <div className="hidden shrink-0 flex-col gap-1 border border-deck-700 bg-deck-900 p-1 lg:flex">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelCollapsed(false)}
              aria-expanded={false}
              aria-label="Expand the control panel"
              title="Expand the control panel"
            >
              <PanelRightClose aria-hidden="true" className="h-4 w-4 rotate-180" />
            </Button>
            {TABS.map((entry) => (
              <Button
                key={entry.id}
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setTab(entry.id)
                  setPanelCollapsed(false)
                }}
                aria-label={`Open ${entry.label}`}
                title={entry.label}
                className="relative"
              >
                {entry.icon}
                {entry.id === 'guests' && connectedCount > 0 ? (
                  <span className="absolute -top-0.5 -right-0.5 bg-ok-500 px-1 font-mono text-[9px] leading-tight text-deck-950">
                    {connectedCount}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        ) : null}

        {/* ---------------------------------------------------- side panel */}
        <div
          className={cn(
            'flex min-h-0 w-full flex-col gap-2 lg:shrink-0',
            panelCollapsed ? 'lg:hidden' : 'lg:w-[24rem] xl:w-[26rem]',
          )}
        >
          <nav
            role="tablist"
            aria-label="Control room panels"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border border-deck-700 bg-deck-900 p-1"
          >
            {TABS.map((entry) => (
              <Button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                size="sm"
                variant="ghost"
                active={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className="shrink-0"
              >
                {entry.icon}
                {entry.label}
                {entry.id === 'guests' && connectedCount > 0 ? (
                  <span className="ml-0.5 bg-ok-500/20 px-1 font-mono text-[10px] text-ok-400">
                    {connectedCount}
                  </span>
                ) : null}
              </Button>
            ))}

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelCollapsed(true)}
              aria-expanded
              aria-label="Collapse the control panel"
              title="Collapse the control panel — gives the program output more width"
              className="ml-auto hidden shrink-0 lg:inline-flex"
            >
              <PanelRightClose aria-hidden="true" className="h-4 w-4" />
            </Button>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'guests' ? (
              <section aria-label="Guests" className="flex flex-col gap-3">
                {/* Cue-all — a director talking to the whole room at once. */}
                <div className="flex gap-1.5">
                  <label className="sr-only" htmlFor="cue-all">
                    Message to send to every guest
                  </label>
                  <input
                    id="cue-all"
                    type="text"
                    value={cueText}
                    placeholder="Cue every guest… (e.g. “90 seconds”)"
                    onChange={(event) => setCueText(event.target.value)}
                    className="h-8 min-w-0 flex-1 border border-deck-600 bg-deck-900 px-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!cueText.trim()}
                    onClick={() => {
                      const delivered = director.cueAll(cueText.trim())
                      setCueText('')
                      useStudioStore
                        .getState()
                        .showToast(
                          delivered > 0
                            ? `Cue sent to ${delivered} guest${delivered === 1 ? '' : 's'}.`
                            : 'No guest has an open control channel, so the cue was not delivered.',
                          delivered > 0 ? 'success' : 'error',
                        )
                    }}
                  >
                    <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />
                    Cue all
                  </Button>
                </div>

                {guests.guests.length === 0 ? (
                  <EmptyState
                    icon={<Users aria-hidden="true" className="h-6 w-6" />}
                    title="No guests yet"
                    description="Send the room link below. Guests appear here once they join and connect."
                  />
                ) : (
                  <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    {guests.guests.map((view) => (
                      <GuestTile
                        key={view.guest.id}
                        view={view}
                        control={director.controlStateFor(view.guest.peerId)}
                        canControlRemotely={director.canControlRemotely(view.guest.peerId)}
                        soloed={
                          view.videoSourceId !== null &&
                          solo.isSoloed(view.videoSourceId)
                        }
                        inScene={
                          view.videoSourceId
                            ? sources.isInActiveScene(view.videoSourceId)
                            : false
                        }
                        onToggleRemoteMic={() =>
                          director.muteGuestMic(
                            view.guest.peerId,
                            !(director.controlStateFor(view.guest.peerId)?.reportedMicMuted ?? false),
                          )
                        }
                        onToggleRemoteCamera={() =>
                          director.muteGuestCamera(
                            view.guest.peerId,
                            !(
                              director.controlStateFor(view.guest.peerId)
                                ?.reportedCameraMuted ?? false
                            ),
                          )
                        }
                        onToggleLocalMute={() =>
                          guests.setMutedInMix(view.guest.id, !view.guest.mutedInMix)
                        }
                        onToggleLocalHide={() =>
                          guests.setVideoHidden(view.guest.id, !view.guest.videoHidden)
                        }
                        onSolo={() => {
                          if (view.videoSourceId) solo.toggleSolo(view.videoSourceId)
                        }}
                        onAddToScene={() => {
                          if (view.videoSourceId) sources.addToActiveScene(view.videoSourceId)
                        }}
                        onRemove={() => guests.requestRemoveGuest(view.guest.id)}
                      />
                    ))}
                  </ul>
                )}

                <div className="border-t border-deck-700 pt-3">
                  <InvitePanel room={room} webrtc={webrtc} />
                </div>
              </section>
            ) : null}

            {tab === 'scenes' ? (
              <div className="flex flex-col gap-2">
                <SceneOutputLink room={room} roleLink={invite.roleLink} onCopy={invite.copy} />
                <PropertiesPanel />
              </div>
            ) : null}

            {tab === 'mix' ? (
              <div className="flex flex-col gap-2">
                <RecordingControls />
                <AudioMixerPanel />
              </div>
            ) : null}

            {tab === 'sources' ? (
              <div className="flex flex-col gap-2">
                <CaptureControls />
                <SourceList />
              </div>
            ) : null}

            {tab === 'diagnostics' ? (
              <div className="flex flex-col gap-2">
                <Suspense fallback={<PanelFallback label="diagnostics" />}>
                  <DiagnosticsPanel />
                </Suspense>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Suspense fallback={null}>
        <SettingsDialog />
        <ShortcutsDialog />
        <AddSourceDialog />
        <RecordingLibraryDialog />
        <CommandPalette />
      </Suspense>
    </div>
  )
}

/**
 * The scene-output link — VDO.Ninja's OBS integration point.
 *
 * Opening this URL in a second window gives a chrome-free program output at the
 * logical canvas size, which is exactly what you point a screen-capture source
 * at. Worth surfacing prominently, because it is the reason the scene route
 * exists.
 */
function SceneOutputLink({
  room,
  roleLink,
  onCopy,
}: {
  room: string
  roleLink: (role: 'scene', room: string) => string
  onCopy: (text?: string) => Promise<boolean>
}) {
  const url = roleLink('scene', room)
  const [copied, setCopied] = useState(false)

  return (
    <div className="flex flex-col gap-2 border border-deck-700 bg-deck-900 p-2.5">
      <p className="text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
        Scene output link
      </p>
      <p className="text-[11px] leading-relaxed text-ink-400">
        A clean program output with no interface, sized to the logical canvas. Open it in a second
        window and capture that window in OBS, or any screen recorder.
      </p>
      <code className="url-box border border-deck-700 bg-deck-950 px-2 py-1 text-accent-400">
        {url}
      </code>
      <div className="flex gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void onCopy(url).then((ok) => {
              setCopied(ok)
              if (ok) setTimeout(() => setCopied(false), 2000)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(url, '_blank', 'noopener,width=1280,height=720')}
        >
          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
          Open in a new window
        </Button>
      </div>
      <Notice>
        The scene window renders its own compositor from the same saved scenes. It is a second
        view of this production, not a mirror of this tab — so closing this tab stops it.
      </Notice>
    </div>
  )
}

function PanelFallback({ label }: { label: string }) {
  return (
    <div className={cn('border border-deck-700 bg-deck-900 px-2.5 py-3')}>
      <p role="status" className="text-[11px] text-ink-500">
        Loading {label}…
      </p>
    </div>
  )
}
