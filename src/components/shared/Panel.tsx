import { ChevronDown } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

/**
 * A collapsible studio panel.
 *
 * Uses a real `<section>` with an accessible name and a disclosure button
 * wired with `aria-expanded`/`aria-controls`, so panel structure is navigable
 * by screen reader and the collapse state is announced.
 */

export type PanelProps = {
  title: string
  /** Short count or status shown beside the title. */
  badge?: React.ReactNode
  /** Controls rendered in the header, right-aligned. */
  actions?: React.ReactNode
  collapsed?: boolean
  onToggleCollapsed?: () => void
  /** Removes body padding, for panels that host their own scroll area. */
  flush?: boolean
  className?: string
  bodyClassName?: string
  children: React.ReactNode
}

export function Panel({
  title,
  badge,
  actions,
  collapsed = false,
  onToggleCollapsed,
  flush = false,
  className,
  bodyClassName,
  children,
}: PanelProps) {
  const bodyId = useId()
  const titleId = useId()
  const collapsible = typeof onToggleCollapsed === 'function'

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'flex min-h-0 flex-col rounded-panel border border-deck-700 bg-deck-850',
        className,
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-deck-700 px-2.5">
        {collapsible ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={onToggleCollapsed}
            className="-ml-1 shrink-0"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn('h-4 w-4 transition-transform', collapsed && '-rotate-90')}
            />
            <span className="sr-only">
              {collapsed ? `Expand ${title}` : `Collapse ${title}`}
            </span>
          </Button>
        ) : null}

        <h2
          id={titleId}
          className="truncate text-[11px] font-semibold tracking-[0.08em] text-ink-400 uppercase"
        >
          {title}
        </h2>
        {badge ? <span className="shrink-0">{badge}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
      </header>

      {/* Kept in the tree but hidden when collapsed, so scroll position and
          focus targets survive a collapse/expand cycle. */}
      <div
        id={bodyId}
        hidden={collapsed}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          !flush && 'p-2.5',
          collapsed && 'hidden',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  )
}
