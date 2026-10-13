import { useEffect, useState } from 'react'

/**
 * Track a media query in React state.
 *
 * WHY THIS EXISTS RATHER THAN CSS-ONLY RESPONSIVENESS
 * ---------------------------------------------------
 * The studio's desktop and mobile layouts are different component trees, not
 * just different CSS. Rendering both and hiding one with `lg:hidden` would
 * mount every panel twice — two `ProgramCanvas` instances fighting over which
 * canvas the compositor attaches to, two sets of device-enumeration effects,
 * two sets of meter subscriptions. So exactly one layout is rendered, chosen
 * here.
 *
 * Plain CSS breakpoints are still used everywhere *within* a layout; this is
 * only for the top-level structural split.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    // Re-read on subscribe: the viewport can change between the initial render
    // and this effect running.
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Tailwind's `lg` breakpoint — where the full production desk becomes usable. */
export const DESKTOP_QUERY = '(min-width: 1024px)'

export function useIsDesktopLayout(): boolean {
  return useMediaQuery(DESKTOP_QUERY)
}
