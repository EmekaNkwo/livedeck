import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/cn'
import { useReducedMotion } from '@/hooks/useStudioSettings'
import { Button } from './Button'

/**
 * Modal dialog.
 *
 * Accessibility handled explicitly rather than assumed:
 *  - `role="dialog"` + `aria-modal` + an `aria-labelledby` title,
 *  - focus moves into the dialog on open and returns to the previously focused
 *    element on close,
 *  - Tab is trapped inside while open,
 *  - Escape closes (handled here, and also globally in `useHotkeys`),
 *  - the backdrop is inert to screen readers and click-to-close is opt-out for
 *    dialogs mid-task.
 */

export type DialogProps = {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /** Prevent backdrop clicks from closing — for multi-step flows. */
  dismissOnBackdrop?: boolean
  size?: 'sm' | 'md' | 'lg' | 'xl'
  footer?: React.ReactNode
  children: React.ReactNode
}

const SIZES: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  dismissOnBackdrop = true,
  size = 'md',
  footer,
  children,
}: DialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const reducedMotion = useReducedMotion()

  /** Move focus in on open, and put it back where it came from on close. */
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null

    // Defer so the panel exists before we look for something to focus.
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const target = panel.querySelector<HTMLElement>(
        '[data-autofocus], input:not([type="hidden"]), textarea, select, button',
      )
      ;(target ?? panel).focus()
    })

    return () => {
      cancelAnimationFrame(frame)
      restoreFocusRef.current?.focus?.()
    }
  }, [open])

  /** Keep Tab inside the dialog. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
            'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.offsetParent !== null)

      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            // Decorative scrim: not announced, and not a click target when the
            // dialog opts out of backdrop dismissal.
            aria-hidden="true"
            className="absolute inset-0 bg-deck-950/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.15 }}
            onClick={dismissOnBackdrop ? onClose : undefined}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.97, y: reducedMotion ? 0 : 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.98, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
            className={cn(
              'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl',
              'border border-deck-600 bg-deck-850 shadow-2xl outline-none',
              SIZES[size],
            )}
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-deck-700 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-sm font-semibold text-ink-100">
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-ink-400">
                    {description}
                  </p>
                ) : null}
              </div>
              <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close dialog">
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

            {footer ? (
              <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-deck-700 bg-deck-900/60 px-4 py-3">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  )
}
