import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SignalEnvelope } from '@/types/peer'
import { ManualSignalingAdapter } from '@/services/signaling/manual-adapter'
import { WebSocketSignalingAdapter } from '@/services/signaling/websocket-adapter'
import { resolveRelayUrl } from '@/services/signaling/relay-url'
import type {
  JoinRoomOptions,
  RoomPeerInfo,
  SignalingAdapter,
  SignalingCapabilities,
  TransportState,
} from '@/services/signaling/types'
import { encodePayload, parseEnvelope } from '@/services/signaling/types'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * The signaling transport.
 *
 * Two adapters ship, chosen in settings:
 *
 *  - **manual** (default) needs no infrastructure whatsoever. Connection
 *    details travel in a link the user sends. Vanilla ICE, and the guest's
 *    answer must come back by hand.
 *  - **server** talks to the relay in `server/`. Guests join by room name with
 *    nothing to copy, and ICE trickles, so connections come up far faster.
 *    Requires that process to be running.
 *
 * The seam is `SignalingAdapter`; neither the studio UI nor the peer manager
 * knows which one is in play beyond reading its capability flags.
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
  /**
   * The last envelope published locally.
   *
   * Exposed so a caller can build an invite *link* from the same envelope the
   * raw code came from, rather than re-deriving it.
   */
  lastEnvelope: SignalEnvelope | null
  copyState: CopyState
  /** Validation error from the last paste attempt. */
  inputError: string | null

  publish: (envelope: SignalEnvelope) => Promise<void>
  clearPublished: () => void
  copyLocalCode: () => Promise<boolean>
  /** The transport's own connection state. Always `idle` for manual. */
  transportState: TransportState
  /** Enter a room. A no-op on transports without room support. */
  joinRoom: (options: JoinRoomOptions) => Promise<void>
  /** Leave the current room, keeping the transport. A no-op without rooms. */
  leaveRoom: () => Promise<void>
  /** Relay a trickled candidate. A no-op when the transport cannot trickle. */
  sendCandidate: (peerId: string, candidate: RTCIceCandidateInit) => void
  /** Validate a pasted code without applying it. */
  validate: (raw: string, expect?: 'offer' | 'answer') => SignalEnvelope | null
  /** Report a validation failure produced elsewhere, beside the paste box. */
  setInputError: (message: string) => void
  clearInputError: () => void
}

function createAdapter(transport: 'manual' | 'server', serverUrl: string): SignalingAdapter {
  if (transport === 'server') {
    // A blank address resolves rather than disqualifying the transport: the
    // operator chose rooms, and quietly demoting them to the copy-a-link flow
    // because a field was empty is how "guests just don't appear" happens.
    const url = resolveRelayUrl(serverUrl)
    if (url) return new WebSocketSignalingAdapter({ url })
  }
  return new ManualSignalingAdapter()
}

export function useSignaling(events?: {
  onOffer?: (envelope: SignalEnvelope) => void
  onAnswer?: (envelope: SignalEnvelope) => void
  onRemoteCandidate?: (peerId: string, candidate: RTCIceCandidateInit) => void
  onPeerAvailable?: (peer: RoomPeerInfo) => void
  onPeerGone?: (peerId: string) => void
}): UseSignaling {
  const transport = useSettingsStore((state) => state.settings.signalingTransport)
  const serverUrl = useSettingsStore((state) => state.settings.signalingServerUrl)

  const adapterRef = useRef<SignalingAdapter | null>(null)
  const [transportState, setTransportState] = useState<TransportState>('idle')
  const [localCode, setLocalCode] = useState<string | null>(null)
  const [localKind, setLocalKind] = useState<'offer' | 'answer' | null>(null)
  const [lastEnvelope, setLastEnvelope] = useState<SignalEnvelope | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [inputError, setInputError] = useState<string | null>(null)

  // Handlers are read through a ref so the adapter is connected exactly once.
  const eventsRef = useRef(events)
  eventsRef.current = events

  /**
   * Rebuild the adapter when the transport configuration changes.
   *
   * A live adapter owns a socket and room membership, so switching transports
   * has to tear the old one down rather than mutate it.
   */
  useEffect(() => {
    const adapter = createAdapter(transport, serverUrl)
    adapterRef.current = adapter
    setTransportState('idle')

    void adapter.connect({
      onOffer: (envelope) => eventsRef.current?.onOffer?.(envelope),
      onAnswer: (envelope) => eventsRef.current?.onAnswer?.(envelope),
      onError: (message) => setInputError(message),
      onRemoteCandidate: (peerId, candidate) =>
        eventsRef.current?.onRemoteCandidate?.(peerId, candidate),
      onPeerAvailable: (peer) => eventsRef.current?.onPeerAvailable?.(peer),
      onPeerGone: (peerId) => eventsRef.current?.onPeerGone?.(peerId),
      onTransportState: setTransportState,
    })

    return () => {
      adapter.disconnect()
      if (adapterRef.current === adapter) adapterRef.current = null
    }
  }, [transport, serverUrl])

  const publish = useCallback(async (envelope: SignalEnvelope) => {
    const adapter = adapterRef.current
    if (!adapter) return
    await adapter.publish(envelope)

    // A copyable code only means something when the user has to move it. With
    // a relay, publishing *is* sending, so offering a code would invite
    // pointless manual work.
    if (adapter.capabilities.requiresManualExchange) {
      setLocalCode(encodePayload(envelope))
      setLocalKind(envelope.kind)
    }
    setLastEnvelope(envelope)
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
    () => createAdapter(transport, serverUrl).capabilities,
    [transport, serverUrl],
  )

  const joinRoom = useCallback(async (options: JoinRoomOptions) => {
    await adapterRef.current?.joinRoom?.(options)
  }, [])

  const leaveRoom = useCallback(async () => {
    await adapterRef.current?.leaveRoom?.()
  }, [])

  const sendCandidate = useCallback((peerId: string, candidate: RTCIceCandidateInit) => {
    adapterRef.current?.sendCandidate?.(peerId, candidate)
  }, [])

  return {
    capabilities,
    localCode,
    localKind,
    lastEnvelope,
    copyState,
    inputError,
    transportState,
    joinRoom,
    leaveRoom,
    sendCandidate,
    publish,
    clearPublished,
    copyLocalCode,
    validate,
    setInputError: (message: string) => setInputError(message),
    clearInputError: () => setInputError(null),
  }
}
