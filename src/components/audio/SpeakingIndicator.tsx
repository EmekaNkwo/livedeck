import { Mic, MicOff } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * "This person is talking."
 *
 * A participant-level signal rather than a measurement. A dB meter answers
 * "how loud", which matters when you are setting up; mid-production the
 * question is "who is speaking", and that wants a glance, not a reading.
 *
 * The detection itself lives in `hooks/useIsSpeaking.ts`; this is only the
 * glyph.
 */

export type SpeakingIndicatorProps = {
  speaking: boolean
  /** Muted wins: a muted participant is never shown as speaking. */
  muted?: boolean
  className?: string
}

/**
 * The glyph itself.
 *
 * Carries its own text for assistive technology, because an animated ring is
 * not available to a screen reader — and it is a shape change, not just a
 * colour change, so it survives being viewed in greyscale.
 */
export function SpeakingIndicator({ speaking, muted, className }: SpeakingIndicatorProps) {
  const active = speaking && !muted
  const label = muted ? 'Muted' : active ? 'Speaking' : 'Not speaking'

  return (
    <span
      className={cn('inline-flex items-center', className)}
      title={label}
      // Polite, not assertive: this changes constantly during a conversation
      // and must never interrupt what a screen reader is already saying.
      aria-live="polite"
    >
      <span className="sr-only">{label}</span>
      {muted ? (
        <MicOff aria-hidden="true" className="h-3 w-3 text-live-400" />
      ) : (
        <Mic
          aria-hidden="true"
          className={cn(
            'h-3 w-3 transition-colors',
            active ? 'animate-pulse text-accent-400' : 'text-ink-500',
          )}
        />
      )}
    </span>
  )
}
