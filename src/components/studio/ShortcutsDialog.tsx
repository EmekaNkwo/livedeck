import { SHORTCUTS } from '@/hooks/useHotkeys'
import type { ShortcutDoc } from '@/hooks/useHotkeys'
import { useStudioStore } from '@/stores/studioStore'
import { Dialog } from '@/components/shared/Dialog'

/**
 * Shortcut documentation, generated from the same list the handler uses, so
 * the documentation cannot drift from the behaviour.
 */
export function ShortcutsDialog() {
  const dialog = useStudioStore((state) => state.dialog)
  const closeDialog = useStudioStore((state) => state.closeDialog)

  const groups = SHORTCUTS.reduce<Record<string, ShortcutDoc[]>>((accumulator, shortcut) => {
    const list = accumulator[shortcut.group] ?? []
    list.push(shortcut)
    accumulator[shortcut.group] = list
    return accumulator
  }, {})

  return (
    <Dialog
      open={dialog === 'shortcuts'}
      onClose={closeDialog}
      title="Keyboard shortcuts"
      description="Shortcuts are suspended while you are typing in a text field."
      size="md"
    >
      <div className="flex flex-col gap-4">
        {Object.entries(groups).map(([group, shortcuts]) => (
          <section key={group}>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
              {group}
            </h3>
            <dl className="flex flex-col gap-1">
              {shortcuts.map((shortcut) => (
                <div
                  key={shortcut.keys}
                  className="flex items-baseline justify-between gap-4 rounded px-2 py-1 odd:bg-deck-900/60"
                >
                  <dt className="text-xs text-ink-300">{shortcut.description}</dt>
                  <dd className="shrink-0">
                    <kbd className="rounded border border-deck-600 bg-deck-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-200">
                      {shortcut.keys}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
