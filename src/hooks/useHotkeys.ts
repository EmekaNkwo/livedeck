import { useEffect } from 'react'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Global keyboard shortcuts.
 *
 * NOT HIJACKING THE BROWSER
 * -------------------------
 * Shortcuts are ignored whenever focus is inside a text field, a textarea, a
 * select, or anything `contenteditable` — otherwise Delete would destroy a
 * source while the operator was renaming it, and Ctrl+K would fight the URL
 * bar's find. Only the specific combinations listed below are prevented from
 * reaching the browser; everything else passes through untouched.
 *
 * Destructive shortcuts route through the confirmation flow rather than acting
 * immediately.
 */

export type HotkeyActions = {
  toggleRecording: () => void
  toggleScreenShare: () => void
  openCommandPalette: () => void
  deleteSelection: () => void
  nextScene: () => void
  previousScene: () => void
  nudgeSelection: (dx: number, dy: number) => void
  toggleSelectionVisibility: () => void
  toggleSelectionLock: () => void
}

export type ShortcutDoc = {
  keys: string
  description: string
  group: 'Production' | 'Scenes' | 'Selection' | 'Interface'
}

/** Documentation shown in the shortcuts dialog. */
export const SHORTCUTS: ShortcutDoc[] = [
  { keys: 'Ctrl/Cmd + Shift + R', description: 'Start or stop recording', group: 'Production' },
  { keys: 'Ctrl/Cmd + Shift + S', description: 'Start or stop screen sharing', group: 'Production' },
  { keys: 'Ctrl/Cmd + K', description: 'Open the command palette', group: 'Interface' },
  { keys: '?', description: 'Show keyboard shortcuts', group: 'Interface' },
  { keys: 'Escape', description: 'Close a dialog, or clear the selection', group: 'Interface' },
  { keys: 'Page Down / ]', description: 'Switch to the next scene', group: 'Scenes' },
  { keys: 'Page Up / [', description: 'Switch to the previous scene', group: 'Scenes' },
  { keys: 'Delete / Backspace', description: 'Remove the selected source (asks first)', group: 'Selection' },
  { keys: 'Arrow keys', description: 'Nudge the selected source', group: 'Selection' },
  { keys: 'Shift + Arrows', description: 'Nudge further', group: 'Selection' },
  { keys: 'V', description: 'Show or hide the selected source', group: 'Selection' },
  { keys: 'L', description: 'Lock or unlock the selected source', group: 'Selection' },
]

/** One nudge step, in normalized units (0.5% of the canvas). */
const NUDGE_STEP = 0.005
const NUDGE_STEP_LARGE = 0.025

export function useHotkeys(actions: HotkeyActions): void {
  const dialog = useStudioStore((state) => state.dialog)
  const confirm = useStudioStore((state) => state.confirm)
  const closeDialog = useStudioStore((state) => state.closeDialog)
  const resolveConfirm = useStudioStore((state) => state.resolveConfirm)
  const selectSource = useStudioStore((state) => state.selectSource)
  const openDialog = useStudioStore((state) => state.openDialog)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape is the one key that must work everywhere, including inside a
      // dialog's form fields.
      if (event.key === 'Escape') {
        if (confirm) {
          resolveConfirm(false)
          event.preventDefault()
          return
        }
        if (dialog) {
          closeDialog()
          event.preventDefault()
          return
        }
        if (useStudioStore.getState().selectedSourceId) {
          selectSource(null)
          event.preventDefault()
        }
        return
      }

      if (isTextEntry(event.target)) return
      // A modal owns the keyboard while it is open.
      if (confirm) return

      const modifier = event.ctrlKey || event.metaKey

      if (modifier && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        actions.toggleRecording()
        return
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        actions.toggleScreenShare()
        return
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        actions.openCommandPalette()
        return
      }

      // Everything below is unmodified, so it must not clash with browser
      // shortcuts — hence no bare Ctrl/Cmd combinations here.
      if (modifier) return
      if (dialog) return

      switch (event.key) {
        case '?':
          event.preventDefault()
          openDialog('shortcuts')
          return
        case 'PageDown':
        case ']':
          event.preventDefault()
          actions.nextScene()
          return
        case 'PageUp':
        case '[':
          event.preventDefault()
          actions.previousScene()
          return
        case 'Delete':
        case 'Backspace':
          if (!useStudioStore.getState().selectedSourceId) return
          event.preventDefault()
          actions.deleteSelection()
          return
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!useStudioStore.getState().selectedSourceId) return
          event.preventDefault()
          const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
          actions.nudgeSelection(dx, dy)
          return
        }
        default:
          break
      }

      if (event.key.toLowerCase() === 'v' && useStudioStore.getState().selectedSourceId) {
        event.preventDefault()
        actions.toggleSelectionVisibility()
        return
      }
      if (event.key.toLowerCase() === 'l' && useStudioStore.getState().selectedSourceId) {
        event.preventDefault()
        actions.toggleSelectionLock()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions, closeDialog, confirm, dialog, openDialog, resolveConfirm, selectSource])
}

/**
 * True when the event target is somewhere the user is typing.
 * Checking `isContentEditable` as well as tag names catches rich-text and
 * custom inputs that are not `<input>` elements.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // A focused option inside a listbox also counts as keyboard-owned.
  return target.getAttribute('role') === 'textbox'
}
