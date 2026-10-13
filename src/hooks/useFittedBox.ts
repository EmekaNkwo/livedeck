import { useCallback, useEffect, useRef, useState } from 'react'
import type { Size } from '@/types/geometry'

/**
 * Compute the largest box of a given aspect ratio that fits its container.
 *
 * WHY THIS IS MEASURED IN JS RATHER THAN DONE IN CSS
 * --------------------------------------------------
 * CSS can express "fit a fixed-aspect box inside a container" only when the
 * element is *replaced* (`object-fit: contain` on an image or canvas). But that
 * letterboxes the **painted content** inside an element box that still fills
 * the container — which is exactly what we must not have here, because the
 * editor overlay is positioned against the element box. If the two disagree,
 * selection handles sit next to the video instead of on it, and pointer
 * coordinates map to the wrong place.
 *
 * `aspect-ratio` with `max-width`/`max-height` does not solve it either: with
 * `width: 100%` the height is derived and then clamped by `max-height`, leaving
 * a box *wider* than its own aspect ratio. That was the original bug — a
 * too-short video with dead space either side, and a misaligned overlay.
 *
 * Measuring gives one box that is simultaneously the video's size and the
 * overlay's coordinate space, so they cannot drift.
 */

export type UseFittedBox = {
  /** Attach to the constraining container. */
  containerRef: (element: HTMLElement | null) => void
  /** Exact pixel size of the fitted box. Zero until first measurement. */
  box: Size
  /** True once a real measurement has happened. */
  measured: boolean
}

/**
 * @param aspect width / height of the box to fit.
 * @param padding pixels to leave inside the container on each axis.
 */
export function useFittedBox(aspect: number, padding = 0): UseFittedBox {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [box, setBox] = useState<Size>({ width: 0, height: 0 })
  const [measured, setMeasured] = useState(false)

  // The latest inputs, so the observer callback does not need re-subscribing
  // every time the aspect ratio changes.
  const inputs = useRef({ aspect, padding })
  inputs.current = { aspect, padding }

  /**
   * @param content The container's **content box** — padding and border already
   * excluded. Using `clientWidth` here instead would include padding, making
   * the computed box wider than the space available; flexbox would then shrink
   * it, skewing the aspect ratio and letterboxing the canvas inside its own
   * box. That was a real bug.
   */
  const measure = useCallback((content: Size) => {
    const { aspect: ratio, padding: inset } = inputs.current
    if (!Number.isFinite(ratio) || ratio <= 0) return

    const available = {
      width: Math.max(0, content.width - inset * 2),
      height: Math.max(0, content.height - inset * 2),
    }
    if (available.width <= 0 || available.height <= 0) return

    /*
     * Fit by whichever axis binds first, rounding only *that* axis to a whole
     * pixel and deriving the other from the ratio.
     *
     * Rounding both would skew the box's aspect by a fraction of a percent,
     * which is enough for `object-fit: contain` to letterbox the canvas by a
     * few pixels inside its own box — reintroducing exactly the overlay
     * misalignment this hook exists to remove. An exact ratio means the canvas
     * fills the box completely and the two spaces are identical.
     */
    const widthLimited = available.width / ratio <= available.height
    const next = widthLimited
      ? { width: Math.floor(available.width), height: Math.floor(available.width) / ratio }
      : { width: Math.floor(available.height) * ratio, height: Math.floor(available.height) }

    setBox((current) =>
      Math.abs(current.width - next.width) < 0.5 && Math.abs(current.height - next.height) < 0.5
        ? current
        : next,
    )
    setMeasured(true)
  }, [])

  const containerRef = useCallback((element: HTMLElement | null) => {
    setContainer(element)
  }, [])

  /** Read the content box without a ResizeObserver entry to hand. */
  const readContentBox = useCallback((element: HTMLElement): Size => {
    const style = getComputedStyle(element)
    const horizontal = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
    const vertical = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    return {
      width: element.clientWidth - (Number.isFinite(horizontal) ? horizontal : 0),
      height: element.clientHeight - (Number.isFinite(vertical) ? vertical : 0),
    }
  }, [])

  useEffect(() => {
    if (!container) return

    measure(readContentBox(container))

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => measure(readContentBox(container))
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      // `contentRect` is already the content box, which is what we need.
      measure(entry ? entry.contentRect : readContentBox(container))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container, measure, readContentBox])

  // Re-fit when the aspect ratio changes (e.g. 16:9 → 9:16) without waiting
  // for the container to happen to resize.
  useEffect(() => {
    if (container) measure(readContentBox(container))
  }, [aspect, padding, container, measure, readContentBox])

  return { containerRef, box, measured }
}
