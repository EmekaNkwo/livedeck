import {
  AlertTriangle,
  CircleDot,
  CircleSlash,
  CircleX,
  Loader2,
  MinusCircle,
} from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Status indicators.
 *
 * NEVER COLOUR ALONE
 * ------------------
 * Every status carries a distinct *icon shape* as well as a colour, and the
 * accessible name always includes the status word. An operator with colour
 * vision deficiency, or looking at a washed-out projector, can still tell
 * "active" from "denied".
 */

export type StatusTone = 'active' | 'idle' | 'pending' | 'warning' | 'error' | 'disabled'

const TONE_STYLE: Record<StatusTone, { color: string; Icon: typeof CircleDot }> = {
  active: { color: 'text-ok-400', Icon: CircleDot },
  idle: { color: 'text-ink-500', Icon: MinusCircle },
  pending: { color: 'text-warn-400', Icon: Loader2 },
  warning: { color: 'text-warn-400', Icon: AlertTriangle },
  error: { color: 'text-live-400', Icon: CircleX },
  disabled: { color: 'text-ink-600', Icon: CircleSlash },
}

export type StatusDotProps = {
  tone: StatusTone
  /** The status word, e.g. "Active". Always part of the accessible name. */
  label: string
  /** Hide the visible text and keep only the icon plus an accessible label. */
  iconOnly?: boolean
  className?: string
}

export function StatusDot({ tone, label, iconOnly, className }: StatusDotProps) {
  const { color, Icon } = TONE_STYLE[tone]
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs', color, className)}
      title={iconOnly ? label : undefined}
    >
      <Icon
        aria-hidden="true"
        className={cn('h-3.5 w-3.5 shrink-0', tone === 'pending' && 'animate-spin')}
      />
      <span className={cn(iconOnly && 'sr-only')}>{label}</span>
    </span>
  )
}

export type BadgeProps = {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'live' | 'warn' | 'ok'
  className?: string
}

const BADGE_TONE: Record<NonNullable<BadgeProps['tone']>, string> = {
  neutral: 'bg-deck-700 text-ink-300',
  accent: 'bg-accent-500/15 text-accent-400 ring-1 ring-accent-500/30',
  live: 'bg-live-500/15 text-live-400 ring-1 ring-live-500/30',
  warn: 'bg-warn-500/15 text-warn-400 ring-1 ring-warn-500/30',
  ok: 'bg-ok-500/15 text-ok-400 ring-1 ring-ok-500/30',
}

export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export type EmptyStateProps = {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-8 text-center',
        className,
      )}
    >
      {icon ? <div className="text-ink-500">{icon}</div> : null}
      <p className="text-sm font-medium text-ink-300">{title}</p>
      {description ? (
        <p className="max-w-xs text-xs leading-relaxed text-balance text-ink-500">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export type MetricProps = {
  label: string
  /** Pre-formatted value. Pass "—" for genuinely unavailable metrics. */
  value: React.ReactNode
  mono?: boolean
}

/** One diagnostics reading. */
export function Metric({ label, value, mono = true }: MetricProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-[11px] text-ink-500">{label}</dt>
      <dd
        className={cn(
          'min-w-0 truncate text-right text-[11px] text-ink-200',
          mono && 'font-mono tabular-nums',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * Inline explanatory / warning note.
 *
 * Used for the honest-limitation copy throughout the studio — display audio
 * availability, NAT traversal, upscaling. `role="note"` keeps it out of the
 * alert queue; `tone="error"` switches to `role="alert"`.
 */
export function Notice({
  tone = 'info',
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'error'
  children: React.ReactNode
  className?: string
}) {
  const styles = {
    info: 'border-deck-600 bg-deck-800 text-ink-300',
    warning: 'border-warn-500/40 bg-warn-500/10 text-warn-400',
    error: 'border-live-500/40 bg-live-500/10 text-live-400',
  }[tone]

  const Icon = tone === 'info' ? CircleDot : AlertTriangle

  return (
    <div
      role={tone === 'error' ? 'alert' : 'note'}
      className={cn(
        'flex gap-2 border px-2.5 py-2 text-[11px] leading-relaxed',
        styles,
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
