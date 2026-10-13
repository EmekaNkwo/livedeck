import { useStudioStore } from '@/stores/studioStore'
import { Button } from './Button'
import { Dialog } from './Dialog'

/**
 * The single confirmation dialog for destructive actions.
 *
 * Centralised so that every irreversible operation — deleting a scene, a
 * source, a recording, resetting a production — goes through the same
 * explicitly-worded gate, including when it is triggered by a keyboard
 * shortcut. Backdrop dismissal is disabled so a stray click cannot be mistaken
 * for a decision.
 */
export function ConfirmDialog() {
  const confirm = useStudioStore((state) => state.confirm)
  const resolveConfirm = useStudioStore((state) => state.resolveConfirm)

  return (
    <Dialog
      open={confirm !== null}
      onClose={() => resolveConfirm(false)}
      title={confirm?.title ?? ''}
      size="sm"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={() => resolveConfirm(false)}>
            Cancel
          </Button>
          <Button
            // The confirm button takes initial focus, but it is the
            // *destructive* styling that signals consequence — and Escape
            // always cancels.
            data-autofocus
            variant={confirm?.destructive ? 'live' : 'primary'}
            onClick={() => resolveConfirm(true)}
          >
            {confirm?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-ink-300">{confirm?.message}</p>
    </Dialog>
  )
}
