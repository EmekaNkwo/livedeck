import { useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { useSceneManager } from '@/hooks/useSceneManager'
import { useRecording } from '@/hooks/useRecording'
import { useCamera } from '@/hooks/useCamera'
import { useStudioStore } from '@/stores/studioStore'
import { Dialog } from '@/components/shared/Dialog'

/**
 * A keyboard-first command launcher.
 *
 * Everything here calls the same hook actions the panels do, so a command and
 * its button can never diverge. The list is a `listbox` driven by arrow keys,
 * with the filter input keeping focus throughout.
 */

type Command = {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function CommandPalette() {
  const dialog = useStudioStore((state) => state.dialog)
  const closeDialog = useStudioStore((state) => state.closeDialog)
  const openDialog = useStudioStore((state) => state.openDialog)

  const scenes = useSceneManager()
  const recording = useRecording()
  const camera = useCamera()

  const room = useStudioStore((state) => state.session?.id ?? '')
  const showToast = useStudioStore((state) => state.showToast)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'record',
        label: recording.isRecording ? 'Stop recording' : 'Start recording',
        hint: 'Ctrl/Cmd + Shift + R',
        run: () => (recording.isRecording ? recording.stop() : void recording.start()),
      },
      {
        id: 'camera',
        label: camera.active ? 'Stop camera' : 'Start camera',
        run: () => (camera.active ? camera.stop() : void camera.start()),
      },
      { id: 'new-scene', label: 'Create a scene', run: () => scenes.createScene() },
      {
        id: 'scene-link',
        label: 'Copy the scene output link',
        hint: 'For OBS capture',
        run: () => {
          const url = `${window.location.origin}/scene/${room}`
          void navigator.clipboard
            ?.writeText(url)
            .then(() => showToast('Scene output link copied.', 'success'))
            .catch(() =>
              showToast('Clipboard access was refused — copy the link from the Scenes tab.', 'error'),
            )
        },
      },
      {
        id: 'open-scene',
        label: 'Open the scene output in a new window',
        run: () =>
          window.open(
            `${window.location.origin}/scene/${room}`,
            '_blank',
            'noopener,width=1280,height=720',
          ),
      },
      { id: 'recordings', label: 'Open the recording library', run: () => openDialog('recordings') },
      { id: 'settings', label: 'Open settings', run: () => openDialog('settings') },
      { id: 'shortcuts', label: 'Show keyboard shortcuts', run: () => openDialog('shortcuts') },
    ]

    // Switching to a specific scene by name is the most common thing an
    // operator wants from a palette mid-production.
    for (const scene of scenes.scenes) {
      list.push({
        id: `scene-${scene.id}`,
        label: `Switch to “${scene.name}”`,
        hint: scene.id === scenes.activeSceneId ? 'On air' : undefined,
        run: () => scenes.activateScene(scene.id),
      })
    }

    return list
  }, [camera, openDialog, recording, room, scenes, showToast])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) => command.label.toLowerCase().includes(needle))
  }, [commands, query])

  const run = (command: Command | undefined) => {
    if (!command) return
    // Close first: several commands open another dialog, and leaving this one
    // mounted would stack two modals.
    closeDialog()
    setQuery('')
    command.run()
  }

  return (
    <Dialog
      open={dialog === 'command-palette'}
      onClose={() => {
        setQuery('')
        closeDialog()
      }}
      title="Command palette"
      size="md"
    >
      <div className="flex flex-col gap-2">
        <label className="sr-only" htmlFor="command-query">
          Filter commands
        </label>
        <input
          id="command-query"
          data-autofocus
          type="text"
          value={query}
          placeholder="Type to filter commands…"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((index) => Math.min(filtered.length - 1, index + 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((index) => Math.max(0, index - 1))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              run(filtered[activeIndex])
            }
          }}
          className="h-9 w-full rounded-md border border-deck-600 bg-deck-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
        />

        <ul role="listbox" aria-label="Commands" className="flex max-h-72 flex-col overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-ink-500">No matching commands.</li>
          ) : (
            filtered.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => run(command)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs',
                    index === activeIndex ? 'bg-accent-500/15 text-ink-100' : 'text-ink-300',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.hint ? (
                    <span className="shrink-0 font-mono text-[10px] text-ink-500">
                      {command.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </Dialog>
  )
}
