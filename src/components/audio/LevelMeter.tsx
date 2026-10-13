import { useRef } from 'react'
import { cn } from '@/lib/cn'
import { dbToMeterFill } from '@/utils/audio-math'
import { formatDb } from '@/utils/format'
import { useAudioLevelMeter } from '@/hooks/useAudioLevel'

/**
 * An audio level meter.
 *
 * COSTS NOTHING IN REACT
 * ----------------------
 * The bar is driven by writing a CSS transform directly to a DOM node from the
 * meter bus. There is no React state here, so a mixer with ten channels
 * updating 20 times a second causes zero re-renders. The subscription is torn
 * down with the component, so no loop outlives it.
 *
 * `role="meter"` with a dB readout gives assistive technology a real value;
 * the clipping indicator is a word as well as a colour.
 */

export type LevelMeterProps = {
  channelId: string | null
  label: string
  orientation?: 'horizontal' | 'vertical'
  /** Show the numeric dB readout. */
  showReadout?: boolean
  className?: string
}

export function LevelMeter({
  channelId,
  label,
  orientation = 'horizontal',
  showReadout = true,
  className,
}: LevelMeterProps) {
  const fillRef = useRef<HTMLDivElement | null>(null)
  const readoutRef = useRef<HTMLElement | null>(null)
  const clipRef = useRef<HTMLElement | null>(null)

  useAudioLevelMeter(
    channelId,
    { fillRef, readoutRef, clipRef },
    {
      toFill: (level) => dbToMeterFill(level.db),
      formatReadout: (level) => formatDb(level.db),
    },
  )

  const vertical = orientation === 'vertical'

  return (
    <div
      className={cn('flex items-center gap-2', vertical && 'h-full flex-col', className)}
      role="meter"
      aria-label={`${label} level`}
      // The live numeric value is in the readout element; a static range here
      // keeps screen readers from announcing on every sample.
      aria-valuemin={-60}
      aria-valuemax={0}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-full bg-deck-900',
          vertical ? 'h-full w-2' : 'h-2 flex-1',
        )}
      >
        <div
          ref={fillRef}
          // The gradient makes the top of the scale read as "hot" without
          // needing a second element for the peak zone.
          className={cn(
            'absolute inset-0 origin-left',
            vertical && 'origin-bottom',
            'bg-gradient-to-r from-ok-500 via-ok-400 to-warn-400',
            vertical && 'bg-gradient-to-t',
          )}
          style={{ transform: vertical ? 'scaleY(0)' : 'scaleX(0)' }}
        />
      </div>

      {showReadout ? (
        <span
          ref={readoutRef as React.RefObject<HTMLSpanElement>}
          className={cn(
            'w-16 shrink-0 font-mono text-[10px] tabular-nums text-ink-400',
            vertical ? 'text-center' : 'text-right',
          )}
        >
          -∞ dB
        </span>
      ) : null}

      {/* Clip indicator. The `data-clipping` attribute is set imperatively by
          the meter hook; the text is always present for screen readers. */}
      <span
        ref={clipRef as React.RefObject<HTMLSpanElement>}
        className={cn(
          'shrink-0 rounded px-1 text-[9px] font-bold tracking-wide uppercase',
          'bg-transparent text-transparent',
          'data-[clipping=true]:bg-live-500 data-[clipping=true]:text-white',
        )}
      >
        clip
      </span>
    </div>
  )
}
