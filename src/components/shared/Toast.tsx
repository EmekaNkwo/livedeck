import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useStudioStore } from '@/stores/studioStore'
import { useReducedMotion } from '@/hooks/useStudioSettings'
import { Button } from './Button'

/**
 * Transient notifications.
 *
 * Rendered into a polite live region so screen readers announce it without
 * interrupting, except for errors, which are assertive. Auto-dismiss is
 * generous (6s) because operators are watching the canvas, not the corner of
 * the screen, and there is always a manual close.
 */

const AUTO_DISMISS_MS = 6000

export function Toast() {
  const toast = useStudioStore((state) => state.toast)
  const dismiss = useStudioStore((state) => state.dismissToast)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS)
    // Re-keyed on message so a second toast resets the countdown rather than
    // inheriting the remainder of the first.
    return () => clearTimeout(timer)
  }, [dismiss, toast])

  const Icon = toast?.tone === 'success' ? CheckCircle2 : toast?.tone === 'error' ? XCircle : Info

  return (
    <div
      aria-live={toast?.tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-60 flex justify-center px-4"
    >
      <AnimatePresence>
        {toast ? (
          <motion.div
            key={toast.message}
            initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
            transition={{ duration: reducedMotion ? 0 : 0.18 }}
            className={cn(
              'pointer-events-auto flex max-w-md items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-xl',
              toast.tone === 'error'
                ? 'border-live-500/50 bg-deck-800 text-live-400'
                : toast.tone === 'success'
                  ? 'border-ok-500/50 bg-deck-800 text-ok-400'
                  : 'border-deck-600 bg-deck-800 text-ink-200',
            )}
          >
            <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 text-xs leading-relaxed">{toast.message}</p>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={dismiss}
              aria-label="Dismiss notification"
              className="-mt-0.5 -mr-1 shrink-0"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
