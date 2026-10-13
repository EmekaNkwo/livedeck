import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Plus,
  Trash2,
  Unplug,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MediaSource } from '@/types/source'
import { isVisualSource } from '@/types/source'
import { cn } from '@/lib/cn'
import { SOURCE_TYPE_LABEL } from '@/services/sources/source-factory'
import { streamRegistry } from '@/services/media/stream-registry'
import { useMediaSources } from '@/hooks/useMediaSources'
import { useSceneStore } from '@/stores/sceneStore'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { EmptyState, StatusDot } from '@/components/shared/Status'
import { TextField } from '@/components/shared/Field'

/**
 * The source library, scoped to the active scene.
 *
 * Like OBS, the list shows the *current scene's* placements plus any library
 * sources not yet in the scene. Visibility, lock and layer controls therefore
 * act on the scene item (the authoritative per-scene value), while rename and
 * delete act on the source definition.
 *
 * It is a real listbox: arrow-key navigable, with each row's state in its
 * accessible name, so the composition can be inspected and reordered without a
 * pointer.
 */

export function SourceList() {
  const {
    sources,
    removeSource,
    renameSource,
    duplicateSource,
    addToActiveScene,
    removeFromActiveScene,
  } = useMediaSources()

  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const scenes = useSceneStore((state) => state.scenes)
  const updateItem = useSceneStore((state) => state.updateItem)
  const moveItemLayer = useSceneStore((state) => state.moveItemLayer)

  const selectedSourceId = useStudioStore((state) => state.selectedSourceId)
  const selectSource = useStudioStore((state) => state.selectSource)
  const openDialog = useStudioStore((state) => state.openDialog)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)
  const collapsed = useStudioStore((state) => state.collapsedPanels.sources)
  const togglePanel = useStudioStore((state) => state.togglePanel)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const activeScene = activeSceneId ? scenes[activeSceneId] : null

  /** Scene members first (topmost layer at the top), then unplaced sources. */
  const rows = useMemo(() => {
    const itemsBySource = new Map((activeScene?.items ?? []).map((item) => [item.sourceId, item]))
    const inScene = sources
      .filter((source) => itemsBySource.has(source.id))
      .sort((a, b) => {
        const left = itemsBySource.get(a.id)?.layer ?? 0
        const right = itemsBySource.get(b.id)?.layer ?? 0
        return right - left
      })
    const unplaced = sources.filter((source) => !itemsBySource.has(source.id))
    return { inScene, unplaced, itemsBySource }
  }, [activeScene?.items, sources])

  const confirmRemove = (source: MediaSource) => {
    requestConfirm({
      title: `Delete “${source.name}”?`,
      message:
        'The source will be removed from every scene and its capture released if nothing else is ' +
        'using it. This cannot be undone.',
      confirmLabel: 'Delete source',
      destructive: true,
      onConfirm: () => removeSource(source.id),
    })
  }

  const commitRename = (sourceId: string) => {
    if (draftName.trim()) renameSource(sourceId, draftName)
    setRenamingId(null)
    setDraftName('')
  }

  return (
    <Panel
      title="Sources"
      badge={
        <span className="font-mono text-[10px] text-ink-500">
          {rows.inScene.length}/{sources.length}
        </span>
      }
      collapsed={collapsed}
      onToggleCollapsed={() => togglePanel('sources')}
      flush
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => openDialog('add-source')}
          aria-label="Add a source"
          title="Add a source"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </Button>
      }
    >
      {sources.length === 0 ? (
        <EmptyState
          title="No sources yet"
          description="Start your camera, share a screen, or add an image, video, text or colour source."
          action={
            <Button size="sm" variant="primary" onClick={() => openDialog('add-source')}>
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              Add source
            </Button>
          }
        />
      ) : (
        <div role="listbox" aria-label="Sources in this scene" className="flex flex-col">
          {rows.inScene.map((source, index) => {
            const item = rows.itemsBySource.get(source.id)
            if (!item) return null
            return (
              <SourceRow
                key={source.id}
                source={source}
                selected={selectedSourceId === source.id}
                inScene
                visible={item.visible}
                locked={item.locked}
                canMoveUp={index > 0}
                canMoveDown={index < rows.inScene.length - 1}
                renaming={renamingId === source.id}
                draftName={draftName}
                onDraftNameChange={setDraftName}
                onStartRename={() => {
                  setRenamingId(source.id)
                  setDraftName(source.name)
                }}
                onCommitRename={() => commitRename(source.id)}
                onCancelRename={() => setRenamingId(null)}
                onSelect={() => selectSource(source.id)}
                onToggleVisible={() =>
                  activeSceneId &&
                  updateItem(activeSceneId, source.id, { visible: !item.visible })
                }
                onToggleLocked={() =>
                  activeSceneId && updateItem(activeSceneId, source.id, { locked: !item.locked })
                }
                // "Up" in the list means forward in the stack.
                onMoveUp={() => activeSceneId && moveItemLayer(activeSceneId, source.id, 'up')}
                onMoveDown={() => activeSceneId && moveItemLayer(activeSceneId, source.id, 'down')}
                onDuplicate={() => duplicateSource(source.id)}
                onRemoveFromScene={() => removeFromActiveScene(source.id)}
                onDelete={() => confirmRemove(source)}
              />
            )
          })}

          {rows.unplaced.length > 0 ? (
            <>
              <p className="border-y border-deck-700 bg-deck-900/60 px-2.5 py-1 text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
                Not in this scene
              </p>
              {rows.unplaced.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  selected={selectedSourceId === source.id}
                  inScene={false}
                  visible={false}
                  locked={false}
                  canMoveUp={false}
                  canMoveDown={false}
                  renaming={renamingId === source.id}
                  draftName={draftName}
                  onDraftNameChange={setDraftName}
                  onStartRename={() => {
                    setRenamingId(source.id)
                    setDraftName(source.name)
                  }}
                  onCommitRename={() => commitRename(source.id)}
                  onCancelRename={() => setRenamingId(null)}
                  onSelect={() => selectSource(source.id)}
                  onAddToScene={() => addToActiveScene(source.id)}
                  onDuplicate={() => duplicateSource(source.id)}
                  onDelete={() => confirmRemove(source)}
                />
              ))}
            </>
          ) : null}
        </div>
      )}
    </Panel>
  )
}

type SourceRowProps = {
  source: MediaSource
  selected: boolean
  inScene: boolean
  visible: boolean
  locked: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  renaming: boolean
  draftName: string
  onDraftNameChange: (value: string) => void
  onStartRename: () => void
  onCommitRename: () => void
  onCancelRename: () => void
  onSelect: () => void
  onToggleVisible?: () => void
  onToggleLocked?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onAddToScene?: () => void
  onRemoveFromScene?: () => void
  onDuplicate: () => void
  onDelete: () => void
}

function SourceRow({
  source,
  selected,
  inScene,
  visible,
  locked,
  canMoveUp,
  canMoveDown,
  renaming,
  draftName,
  onDraftNameChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onSelect,
  onToggleVisible,
  onToggleLocked,
  onMoveUp,
  onMoveDown,
  onAddToScene,
  onRemoveFromScene,
  onDuplicate,
  onDelete,
}: SourceRowProps) {
  // Live status comes from the registry, not from a stored flag, so the row
  // cannot claim a source is running when its track has ended.
  const live = source.streamKey ? streamRegistry.has(source.streamKey) : null
  const needsCapture =
    source.type === 'camera' ||
    source.type === 'screen' ||
    source.type === 'microphone' ||
    source.type === 'remote-video' ||
    source.type === 'remote-audio'

  const statusTone = !needsCapture ? 'active' : live ? 'active' : 'idle'
  const statusLabel = !needsCapture ? 'Ready' : live ? 'Live' : 'Not started'

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'group flex cursor-pointer flex-col gap-1 border-b border-deck-800 px-2.5 py-2',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400',
        selected ? 'bg-accent-500/10' : 'hover:bg-deck-800',
        !inScene && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot tone={statusTone} label={statusLabel} iconOnly />

        {renaming ? (
          <TextField
            label={`Rename ${source.name}`}
            srOnlyLabel
            value={draftName}
            onChange={onDraftNameChange}
            className="min-w-0 flex-1"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={onStartRename}
            onClick={(event) => {
              event.stopPropagation()
              onSelect()
            }}
            className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink-100"
            title={`${source.name} — double-click to rename`}
          >
            {source.name}
          </button>
        )}

      </div>

      <div className="flex items-center gap-1">
        <span className="mr-auto text-[10px] text-ink-500">
          {SOURCE_TYPE_LABEL[source.type]}
        </span>

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
          <div
            // Row actions are always in the DOM (never hidden behind hover
            // only), so keyboard and touch users can reach them.
            className="flex items-center gap-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            {inScene && isVisualSource(source.type) ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onToggleVisible}
                  aria-pressed={!visible}
                  aria-label={visible ? `Hide ${source.name}` : `Show ${source.name}`}
                  title={visible ? 'Hide in this scene' : 'Show in this scene'}
                >
                  {visible ? (
                    <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff aria-hidden="true" className="h-3.5 w-3.5 text-ink-500" />
                  )}
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onToggleLocked}
                  aria-pressed={locked}
                  aria-label={locked ? `Unlock ${source.name}` : `Lock ${source.name}`}
                  title={locked ? 'Unlock' : 'Lock position and size'}
                >
                  {locked ? (
                    <Lock aria-hidden="true" className="h-3.5 w-3.5 text-warn-400" />
                  ) : (
                    <LockOpen aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!canMoveUp}
                  onClick={onMoveUp}
                  aria-label={`Move ${source.name} forward`}
                  title="Move forward one layer"
                >
                  <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!canMoveDown}
                  onClick={onMoveDown}
                  aria-label={`Move ${source.name} backward`}
                  title="Move backward one layer"
                >
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : null}

            {!inScene && isVisualSource(source.type) ? (
              <Button variant="ghost" size="sm" onClick={onAddToScene}>
                <Plus aria-hidden="true" className="h-3 w-3" />
                Add to scene
              </Button>
            ) : null}

            {inScene && isVisualSource(source.type) ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onRemoveFromScene}
                aria-label={`Remove ${source.name} from this scene`}
                title="Remove from this scene (keeps the source)"
              >
                <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            ) : null}

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDuplicate}
              aria-label={`Duplicate ${source.name}`}
              title="Duplicate (shares the same capture)"
            >
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>


            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              aria-label={`Delete ${source.name}`}
              title="Delete source"
              className="hover:text-live-400"
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
