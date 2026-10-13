import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SignalEnvelope } from '@/types/peer'
import { ManualSignalingAdapter } from '@/services/signaling/manual-adapter'
import type { SignalingAdapter, SignalingCapabilities } from '@/services/signaling/types'
import { encodePayload, parseEnvelope } from '@/services/signaling/types'

/**
 * The signaling transport.
 *
 * Only the manual adapter ships, because it is the only one that can establish
 * a real connection without a backend. An external service can be added by
 * implementing `SignalingAdapter` and returning it from `createAdapter` below —
 * no studio UI changes required.
 *
 * Clipboard writes can fail (permissions, non-secure context, Firefox without
 * user activation), so every copy reports whether it actually succeeded and the
 * UI always keeps a selectable textarea as a manual fallback.
 */

export type CopyState = 'idle' | 'copied' | 'failed'

export type UseSignaling = {
  capabilities: SignalingCapabilities
  /** The local code awaiting copy, or null. */
  localCode: string | null
  localKind: 'offer' | 'answer' | null
  copyState: CopyState
  /** Validation error from the last paste attempt. */
  inputError: string | null

  publish: (envelope: SignalEnvelope) => Promise<void>
  clearPublished: () => void
  copyLocalCode: () => Promise<boolean>
  /** Validate a pasted code without applying it. */
  validate: (raw: string, expect?: 'offer' | 'answer') => SignalEnvelope | null
  clearInputError: () => void
}

function createAdapter(): SignalingAdapter {
  return new ManualSignalingAdapter()
}

export function useSignaling(events?: {
  onOffer?: (envelope: SignalEnvelope) => void
  onAnswer?: (envelope: SignalEnvelope) => void
}): UseSignaling {
  const adapterRef = useRef<ManualSignalingAdapter | null>(null)
  const [localCode, setLocalCode] = useState<string | null>(null)
  const [localKind, setLocalKind] = useState<'offer' | 'answer' | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [inputError, setInputError] = useState<string | null>(null)

  // Handlers are read through a ref so the adapter is connected exactly once.
  const eventsRef = useRef(events)
  eventsRef.current = events

  if (!adapterRef.current) {
    adapterRef.current = createAdapter() as ManualSignalingAdapter
  }

  useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    void adapter.connect({
      onOffer: (envelope) => eventsRef.current?.onOffer?.(envelope),
      onAnswer: (envelope) => eventsRef.current?.onAnswer?.(envelope),
      onError: (message) => setInputError(message),
    })
    return () => adapter.disconnect()
  }, [])

  const publish = useCallback(async (envelope: SignalEnvelope) => {
    const adapter = adapterRef.current
    if (!adapter) return
    await adapter.publish(envelope)
    setLocalCode(encodePayload(envelope))
    setLocalKind(envelope.kind)
    setCopyState('idle')
  }, [])

  const clearPublished = useCallback(() => {
    setLocalCode(null)
    setLocalKind(null)
    setCopyState('idle')
  }, [])

  const copyLocalCode = useCallback(async (): Promise<boolean> => {
    if (!localCode) return false
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(localCode)
      setCopyState('copied')
      // Reset the affordance so a second copy still gives feedback.
      setTimeout(() => setCopyState('idle'), 2000)
      return true
    } catch {
      // The textarea beside the button stays selectable, so the user can copy
      // by hand. Reporting failure honestly matters more than a fake success.
      setCopyState('failed')
      return false
    }
  }, [localCode])

  const validate = useCallback(
    (raw: string, expect?: 'offer' | 'answer'): SignalEnvelope | null => {
      const result = parseEnvelope(raw, expect)
      if (!result.ok) {
        setInputError(result.error)
        return null
      }
      setInputError(null)
      return result.envelope
    },
    [],
  )

  const capabilities = useMemo(
    () => adapterRef.current?.capabilities ?? new ManualSignalingAdapter().capabilities,
    [],
  )

  return {
    capabilities,
    localCode,
    localKind,
    copyState,
    inputError,
    publish,
    clearPublished,
    copyLocalCode,
    validate,
    clearInputError: () => setInputError(null),
  }
}
