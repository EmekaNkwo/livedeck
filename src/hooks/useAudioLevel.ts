import { useEffect, useRef, useState } from 'react'
import type { AudioLevel } from '@/types/audio'
import { SILENT_LEVEL } from '@/types/audio'
import { meterBus } from '@/services/audio/meter-bus'

/**
 * Subscribe a DOM node directly to a channel's level.
 *
 * DELIBERATELY NOT REACT STATE
 * ----------------------------
 * Levels arrive ~20 times a second per channel. Putting them in state would
 * re-render the mixer continuously. Instead the callback writes straight to
 * the element — a transform on the fill bar and the text of a readout — so a
 * meter costs React nothing after mount.
 *
 * The subscription is torn down on unmount and when the channel disappears,
 * so no loop outlives the component that asked for it.
 */

export type MeterRefs = {
  /** Bar whose `scaleX` is driven by the level. */
  fillRef: React.RefObject<HTMLDivElement | null>
  /** Optional element receiving the dB readout as text. */
  readoutRef?: React.RefObject<HTMLElement | null>
  /** Optional element that gets a `data-clipping` attribute. */
  clipRef?: React.RefObject<HTMLElement | null>
}

export type UseAudioLevelOptions = {
  /** Convert a level into a 0..1 fill. Defaults to a broadcast-style curve. */
  toFill: (level: AudioLevel) => number
  formatReadout?: (level: AudioLevel) => string
}

export function useAudioLevelMeter(
  channelId: string | null,
  refs: MeterRefs,
  options: UseAudioLevelOptions,
): void {
  /**
   * Options are captured in a ref so that passing inline formatter functions —
   * which every caller does — cannot resubscribe the meter on every render.
   *
   * The ref is written in an effect rather than during render. Effects run in
   * declaration order, so this one lands before the subscription effect below
   * and the first render still sees the correct options.
   */
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  useEffect(() => {
    const fill = refs.fillRef.current
    if (!channelId) {
      if (fill) fill.style.transform = 'scaleX(0)'
      return
    }

    const render = (level: AudioLevel) => {
      const element = refs.fillRef.current
      if (element) {
        const value = optionsRef.current.toFill(level)
        // transform is compositor-friendly; animating width would force layout
        // 20 times a second per channel.
        element.style.transform = `scaleX(${value.toFixed(4)})`
      }
      const readout = refs.readoutRef?.current
      if (readout && optionsRef.current.formatReadout) {
        readout.textContent = optionsRef.current.formatReadout(level)
      }
      const clip = refs.clipRef?.current
      if (clip) {
        if (level.clipping) clip.setAttribute('data-clipping', 'true')
        else clip.removeAttribute('data-clipping')
      }
    }

    render(meterBus.get(channelId))
    return meterBus.subscribe(channelId, render)
  }, [channelId, refs.clipRef, refs.fillRef, refs.readoutRef])
}

/**
 * Read a level into React state, sampled at a low rate.
 *
 * Use this only where a level has to drive *conditional markup* (an "input
 * detected" hint, an activity dot in a list). For anything purely visual use
 * `useAudioLevelMeter`, which does not render at all. The default 300ms
 * interval is roughly a tenth of the meter bus rate, which keeps the render
 * cost negligible.
 */
export function useAudioLevelSnapshot(channelId: string | null, intervalMs = 300): AudioLevel {
  const [level, setLevel] = useState<AudioLevel>(SILENT_LEVEL)

  useEffect(() => {
    if (!channelId) {
      setLevel(SILENT_LEVEL)
      return
    }
    // Poll the bus rather than subscribing to it: subscribing would deliver
    // every update and defeat the point of sampling.
    setLevel(meterBus.get(channelId))
    const timer = setInterval(() => setLevel(meterBus.get(channelId)), intervalMs)
    return () => clearInterval(timer)
  }, [channelId, intervalMs])

  return level
}
