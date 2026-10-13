import { useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import type { ParsedUrlParameters } from '@/services/signaling/url-parameters'
import { parseUrlParameters } from '@/services/signaling/url-parameters'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Parse the current URL's parameters and apply the ones that are settings.
 *
 * Applied **once per URL**, not on every render: these are initial conditions
 * from a link, and re-applying them would fight the operator every time they
 * changed a setting by hand. A different URL (a new invite link) counts as a
 * new set of initial conditions.
 */
export function useUrlParameters(): ParsedUrlParameters {
  const location = useLocation()
  const setOutput = useSettingsStore((state) => state.setOutput)

  const parameters = useMemo(() => parseUrlParameters(location.search), [location.search])

  /** The search string whose settings have already been applied. */
  const appliedFor = useRef<string | null>(null)

  useEffect(() => {
    if (appliedFor.current === location.search) return
    appliedFor.current = location.search

    // Only output settings are global; label/mute/mirror are consumed by the
    // view that cares about them.
    const patch: Parameters<typeof setOutput>[0] = {}
    if (parameters.quality) patch.resolution = parameters.quality
    if (parameters.fps) patch.frameRate = parameters.fps
    if (parameters.ratio) patch.aspectRatio = parameters.ratio
    if (Object.keys(patch).length > 0) setOutput(patch)
  }, [location.search, parameters, setOutput])

  return parameters
}
