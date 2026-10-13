import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Scene, TransitionType } from '@/types/scene'
import { cn } from '@/lib/cn'
import { useSceneManager } from '@/hooks/useSceneManager'
import { Button } from '@/components/shared/Button'
import { NumberField, SelectField, TextField } from '@/components/shared/Field'
import { Badge } from '@/components/shared/Status'

/**
 * The scene selector.
 *
 * Selecting a scene changes the program output — the compositor reads the
 * active scene id every frame — so this is a production control, not a
 * thumbnail picker. It is a tablist so arrow keys move between scenes, which
 * is how an operator switches without reaching for the mouse.
 */

const TRANSITION_OPTIONS: Array<{ value: TransitionType; label: string }> = [
  { value: 'cut', label: 'Cut' },
  { value: 'fade', label: 'Fade (through black)' },
  { value: 'crossfade', label: 'Crossfade' },
]

export function SceneStrip() {
  const manager = useSceneManager()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const activeScene = manager.activeScene

  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-panel border border-deck-700 bg-deck-850 p-2.5">
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-ink-400 uppercase">
          Scenes
        </h2>
        {manager.transitioning ? <Badge tone="accent">Transitioning</Badge> : null}
        <span className="ml-auto text-[10px] text-ink-500">
          Page Up / Page Down to switch
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Scenes"
        aria-orientation="horizontal"
        className="flex gap-2 overflow-x-auto pb-1"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            manager.stepScene(1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            manager.stepScene(-1)
          }
        }}
      >
        {manager.scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            active={scene.id === manager.activeSceneId}
            editing={editingId === scene.id}
            draftName={draftName}
            onDraftNameChange={setDraftName}
            onActivate={() => manager.activateScene(scene.id)}
            onStartRename={() => {
              setEditingId(scene.id)
              setDraftName(scene.name)
            }}
            onCommitRename={() => {
              manager.renameScene(scene.id, draftName)
              setEditingId(null)
            }}
            onCancelRename={() => setEditingId(null)}
            onDuplicate={() => manager.duplicateScene(scene.id)}
            onDelete={() => manager.requestDeleteScene(scene.id)}
          />
        ))}

        <Button
          variant="outline"
          onClick={() => manager.createScene()}
          className="h-auto min-h-16 shrink-0 flex-col gap-1 border-dashed px-4"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          <span className="text-[11px]">New scene</span>
        </Button>
      </div>

      {/* Transition settings for the active scene — these are what plays when
          switching *to* this scene. */}
      {activeScene ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-deck-700 pt-2">
          <SelectField
            label="Transition into this scene"
            value={activeScene.transition.type}
            options={TRANSITION_OPTIONS}
            onChange={(type) => manager.setTransitionType(activeScene.id, type)}
            className="min-w-44 flex-1"
          />
          <NumberField
            label="Duration"
            unit="ms"
            min={0}
            max={3000}
            step={50}
            disabled={activeScene.transition.type === 'cut'}
            value={activeScene.transition.durationMs}
            onChange={(durationMs) => manager.setTransitionDuration(activeScene.id, durationMs)}
            className="w-28"
          />
          <p className="mb-1 min-w-48 flex-1 text-[11px] leading-snug text-ink-500">
            Production transitions run in the program output and are captured in recordings. They
            are independent of the interface’s reduced-motion setting.
          </p>
        </div>
      ) : null}
    </div>
  )
}

type SceneCardProps = {
  scene: Scene
  active: boolean
  editing: boolean
  draftName: string
  onDraftNameChange: (value: string) => void
  onActivate: () => void
  onStartRename: () => void
  onCommitRename: () => void
  onCancelRename: () => void
  onDuplicate: () => void
  onDelete: () => void
}

function SceneCard({
  scene,
  active,
  editing,
  draftName,
  onDraftNameChange,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDuplicate,
  onDelete,
}: SceneCardProps) {
  const visibleCount = scene.items.filter((item) => item.visible).length

  if (editing) {
    return (
      <div className="flex w-44 shrink-0 flex-col gap-1 rounded-md border border-accent-500 bg-deck-800 p-2">
        <TextField
          label="Scene name"
          srOnlyLabel
          value={draftName}
          onChange={onDraftNameChange}
        />
        <div className="flex gap-1">
          <Button size="sm" variant="primary" onClick={onCommitRename} className="flex-1">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelRename}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group relative flex w-40 shrink-0 flex-col justify-between rounded-md border p-2 text-left transition-colors',
        active
          ? 'border-accent-400 bg-accent-500/10 ring-1 ring-accent-400'
          : 'border-deck-600 bg-deck-800 hover:border-deck-500',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // Only the active tab is in the tab order; arrow keys move between
        // them, which is the expected tablist behaviour.
        tabIndex={active ? 0 : -1}
        onClick={onActivate}
        className="flex flex-col items-start gap-1 text-left focus-visible:outline-none"
      >
        <span className="truncate text-xs font-semibold text-ink-100">{scene.name}</span>
        <span className="text-[10px] text-ink-500">
          {scene.items.length === 0
            ? 'Empty'
            : `${visibleCount} of ${scene.items.length} visible`}
        </span>
        {active ? <Badge tone="live">On air</Badge> : null}
      </button>

      <div className="mt-2 flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onStartRename}
          aria-label={`Rename ${scene.name}`}
          title="Rename"
        >
          <Pencil aria-hidden="true" className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDuplicate}
          aria-label={`Duplicate ${scene.name}`}
          title="Duplicate"
        >
          <Copy aria-hidden="true" className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label={`Delete ${scene.name}`}
          title="Delete"
          className="ml-auto hover:text-live-400"
        >
          <Trash2 aria-hidden="true" className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
