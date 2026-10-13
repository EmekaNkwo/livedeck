import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

/**
 * A meeting-style split control: toggle on the left, device picker on the right.
 *
 * The pattern every conferencing tool uses, and for a good reason — "turn my
 * camera off" and "use my *other* camera" are different intentions, and
 * burying the second one in a settings page means people join on the wrong
 * device and never find out why.
 *
 * ACCESSIBILITY
 * -------------
 * The two halves are separate buttons, so each has its own name and its own
 * keyboard stop — a single button that did both would be impossible to
 * describe. The menu is a real `menu` with `menuitemradio` items, so a screen
 * reader announces which device is in use rather than just listing names.
 * State is never carried by colour alone: the toggle's icon changes with it and
 * `aria-pressed` carries it for assistive technology.
 */

export type DeviceOption = {
  id: string
  label: string
}

export type DeviceButtonProps = {
  /** True when the device is on — drives `aria-pressed` and the styling. */
  active: boolean
  /** Toggle the device on or off. */
  onToggle: () => void
  /** Name for the toggle half, e.g. "Turn camera off". */
  label: string
  /** Icon for the toggle half. */
  children: React.ReactNode

  devices: DeviceOption[]
  /** Currently selected device id, or '' for the system default. */
  selectedId: string
  onSelect: (deviceId: string) => void
  /** Name for the picker half, e.g. "Choose a camera". */
  menuLabel: string
  disabled?: boolean
}

export function DeviceButton({
  active,
  onToggle,
  label,
  children,
  devices,
  selectedId,
  onSelect,
  menuLabel,
  disabled,
}: DeviceButtonProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  /**
   * Close on an outside click or Escape.
   *
   * Bound to the document only while open, so a page with several of these
   * does not keep a listener per control running for the whole session.
   */
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative flex items-center">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={active}
        aria-label={label}
        title={label}
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-l-full border border-r-0 transition-colors',
          'focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none',
          disabled && 'cursor-not-allowed opacity-40',
          active
            ? 'border-deck-600 bg-deck-700 text-ink-100 hover:bg-deck-600'
            : 'border-live-500 bg-live-500/90 text-white hover:bg-live-500',
        )}
      >
        {children}
      </button>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled || devices.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={menuLabel}
        title={devices.length === 0 ? 'No devices found' : menuLabel}
        className={cn(
          'flex h-10 w-6 items-center justify-center rounded-r-full border transition-colors',
          'focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none',
          (disabled || devices.length === 0) && 'cursor-not-allowed opacity-40',
          active
            ? 'border-deck-600 bg-deck-700 text-ink-300 hover:bg-deck-600'
            : 'border-live-500 bg-live-500/90 text-white hover:bg-live-500',
        )}
      >
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          /*
           * Opens upward: these controls sit in a bar at the bottom of the
           * screen, where a downward menu would be clipped by the viewport.
           */
          className="absolute bottom-full left-0 z-20 mb-2 flex min-w-56 flex-col border border-deck-600 bg-deck-900 py-1 shadow-xl"
        >
          <DeviceItem
            label="System default"
            selected={selectedId === ''}
            onSelect={() => {
              onSelect('')
              setOpen(false)
            }}
          />
          {devices.map((device) => (
            <DeviceItem
              key={device.id}
              label={device.label}
              selected={selectedId === device.id}
              onSelect={() => {
                onSelect(device.id)
                setOpen(false)
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function DeviceItem({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
        'focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none',
        selected ? 'text-accent-400' : 'text-ink-300 hover:bg-deck-800',
      )}
    >
      {/* A shape, not just colour: the check is what carries selection. */}
      <span aria-hidden="true" className="w-3 shrink-0 text-center">
        {selected ? '✓' : ''}
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}
