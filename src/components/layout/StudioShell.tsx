import { PanelLeftClose, PanelRightClose } from 'lucide-react'
import { Suspense, lazy, useCallback, useState } from 'react'
import { cn } from '@/lib/cn'
import { useIsDesktopLayout } from '@/hooks/useBreakpoint'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useMediaSources } from '@/hooks/useMediaSources'
import { useRecording } from '@/hooks/useRecording'
import { useSceneManager } from '@/hooks/useSceneManager'
import { useScreenShare } from '@/hooks/useScreenShare'
import { useSourceTransform } from '@/hooks/useSourceTransform'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'

import { Button } from '@/components/shared/Button'
import { AudioMixerPanel } from '@/components/audio/AudioMixerPanel'
import { GuestPanel } from '@/components/guests/GuestPanel'
import { RecordingControls } from '@/components/recording/RecordingControls'
import { SceneStrip } from '@/components/scenes/SceneStrip'
import { CaptureControls } from '@/components/sources/CaptureControls'
import { PropertiesPanel } from '@/components/sources/PropertiesPanel'
import { SourceList } from '@/components/sources/SourceList'
import { ProgramCanvas } from '@/components/studio/ProgramCanvas'
import { SessionBar } from './SessionBar'

/**
 * Deferred surfaces.
 *
 * Diagnostics and the dialogs are not needed to start producing, and most of
 * them are never opened in a given session, so they are split out of the
 * initial studio chunk and fetched on first use.
 */
const lazyPanel = <T extends Record<string, React.ComponentType>>(
  loader: () => Promise<T>,
  name: keyof T,
) => lazy(() => loader().then((module) => ({ default: module[name] })))

const DiagnosticsPanel = lazyPanel(
  () => import('@/components/diagnostics/DiagnosticsPanel'),
  'DiagnosticsPanel',
)
const SimulationPanel = lazyPanel(
  () => import('@/components/diagnostics/SimulationPanel'),
  'SimulationPanel',
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
const InviteDialog = lazyPanel(() => import('@/components/guests/InviteDialog'), 'InviteDialog')
const RecordingLibraryDialog = lazyPanel(
  () => import('@/components/recording/RecordingLibrary'),
  'RecordingLibraryDialog',
)
const CommandPalette = lazyPanel(
  () => import('@/components/studio/CommandPalette'),
  'CommandPalette',
)

/**
 * The studio layout.
 *
 * Desktop-first: a three-column production desk with the program output in the
 * middle and the control surfaces flanking it, so the chrome never covers the
 * output. Below ~1024px the side columns become tabbed drawers, keeping the
 * program preview and the recording status visible on tablets and phones.
 *
 * This component also owns the global hotkey wiring, because shortcuts have to
 * reach across panels (switch scene, delete the selected source) and belong at
 * the level that can see all of them.
 */

type MobileTab = 'program' | 'sources' | 'properties' | 'audio' | 'guests' | 'diagnostics'

export function StudioShell() {
  // Exactly one layout is rendered — see useBreakpoint for why.
  const isDesktop = useIsDesktopLayout()
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [mobileTab, setMobileTab] = useState<MobileTab>('program')

  const scenes = useSceneManager()
  const recording = useRecording()
  const screen = useScreenShare()
  const sources = useMediaSources()

  const selectedSourceId = useStudioStore((state) => state.selectedSourceId)
  const openDialog = useStudioStore((state) => state.openDialog)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)
  const transform = useSourceTransform(selectedSourceId)

  /** Deleting a source from the keyboard still goes through confirmation. */
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
    toggleRecording: () =>
      recording.isRecording ? recording.stop() : void recording.start(),
    toggleScreenShare: () => void screen.toggle(),
    openCommandPalette: () => openDialog('command-palette'),
    deleteSelection,
    nextScene: () => scenes.stepScene(1),
    previousScene: () => scenes.stepScene(-1),
    nudgeSelection: (dx, dy) => transform.nudge(dx, dy),
    toggleSelectionVisibility: () => transform.setVisible(!(transform.item?.visible ?? true)),
    toggleSelectionLock: () => transform.setLocked(!(transform.item?.locked ?? false)),
  })

  return (
    <div className="flex h-full flex-col bg-deck-950">
      <SessionBar />

      {/* ------------------------------------------------ desktop layout */}
      {isDesktop ? (
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {/* Left column: capture, sources. */}
        <div
          className={cn(
            'flex min-h-0 flex-col gap-2 transition-all',
            leftCollapsed ? 'w-10' : 'w-72 shrink-0',
          )}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setLeftCollapsed((value) => !value)}
            aria-expanded={!leftCollapsed}
            aria-label={leftCollapsed ? 'Expand the left panel' : 'Collapse the left panel'}
            className="self-end"
          >
            <PanelLeftClose
              aria-hidden="true"
              className={cn('h-4 w-4 transition-transform', leftCollapsed && 'rotate-180')}
            />
          </Button>

          {!leftCollapsed ? (
            <>
              <CaptureControls />
              <SourceList />
            </>
          ) : null}
        </div>

        {/* Centre column: program output and scenes. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <ProgramCanvas />
          <SceneStrip />
          <div className="grid shrink-0 gap-2 xl:grid-cols-2">
            <RecordingControls />
            <AudioMixerPanel />
          </div>
        </div>

        {/* Right column: properties, guests, diagnostics, demo. */}
        <div
          className={cn(
            'flex min-h-0 flex-col gap-2 transition-all',
            rightCollapsed ? 'w-10' : 'w-80 shrink-0',
          )}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRightCollapsed((value) => !value)}
            aria-expanded={!rightCollapsed}
            aria-label={rightCollapsed ? 'Expand the right panel' : 'Collapse the right panel'}
            className="self-start"
          >
            <PanelRightClose
              aria-hidden="true"
              className={cn('h-4 w-4 transition-transform', rightCollapsed && 'rotate-180')}
            />
          </Button>

          {!rightCollapsed ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              <PropertiesPanel />
              <GuestPanel />
              <Suspense fallback={<PanelFallback label="demo panel" />}>
                <SimulationPanel />
              </Suspense>
              <Suspense fallback={<PanelFallback label="diagnostics" />}>
                <DiagnosticsPanel />
              </Suspense>
            </div>
          ) : null}
        </div>
      </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {/* The program output stays visible above the tabs — on a small screen
            the preview is the thing worth keeping. */}
        <div className="shrink-0">
          <ProgramCanvas />
        </div>

        <nav
          role="tablist"
          aria-label="Studio panels"
          className="flex shrink-0 gap-1 overflow-x-auto"
        >
          {(
            [
              ['program', 'Scenes'],
              ['sources', 'Sources'],
              ['properties', 'Properties'],
              ['audio', 'Audio'],
              ['guests', 'Guests'],
              ['diagnostics', 'Diagnostics'],
            ] as Array<[MobileTab, string]>
          ).map(([tab, label]) => (
            <Button
              key={tab}
              role="tab"
              aria-selected={mobileTab === tab}
              size="sm"
              variant="outline"
              active={mobileTab === tab}
              onClick={() => setMobileTab(tab)}
            >
              {label}
            </Button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {mobileTab === 'program' ? (
            <div className="flex flex-col gap-2">
              <SceneStrip />
              <RecordingControls />
            </div>
          ) : null}
          {mobileTab === 'sources' ? (
            <div className="flex flex-col gap-2">
              <CaptureControls />
              <SourceList />
            </div>
          ) : null}
          {mobileTab === 'properties' ? (
            <div className="flex flex-col gap-2">
              {/* On a small screen, dragging on the canvas is impractical, so
                  the numeric controls are the primary editing surface. */}
              <p className="rounded-md border border-deck-700 bg-deck-850 px-2.5 py-2 text-[11px] leading-relaxed text-ink-400">
                On small screens the numeric controls below are the most reliable way to arrange
                sources. Precise drag-and-resize editing is easier on a larger display.
              </p>
              <PropertiesPanel />
            </div>
          ) : null}
          {mobileTab === 'audio' ? <AudioMixerPanel /> : null}
          {mobileTab === 'guests' ? <GuestPanel /> : null}
          {mobileTab === 'diagnostics' ? (
            <div className="flex flex-col gap-2">
              <Suspense fallback={<PanelFallback label="demo panel" />}>
                <SimulationPanel />
              </Suspense>
              <Suspense fallback={<PanelFallback label="diagnostics" />}>
                <DiagnosticsPanel />
              </Suspense>
            </div>
          ) : null}
        </div>
      </div>
      )}

      {/* Dialogs are mounted once, at the shell level, and each renders
          nothing until its chunk is needed — they are closed by default. */}
      <Suspense fallback={null}>
        <SettingsDialog />
        <ShortcutsDialog />
        <AddSourceDialog />
        <InviteDialog />
        <RecordingLibraryDialog />
        <CommandPalette />
      </Suspense>
    </div>
  )
}

function PanelFallback({ label }: { label: string }) {
  return (
    <div className="rounded-panel border border-deck-700 bg-deck-850 px-2.5 py-3">
      <p role="status" className="text-[11px] text-ink-500">
        Loading {label}…
      </p>
    </div>
  )
}
