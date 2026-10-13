import type { SignalEnvelope } from '@/types/peer'
import type { SignalingAdapter, SignalingCapabilities, SignalingEvents } from './types'
import { encodePayload, parseEnvelope } from './types'

/**
 * Backend-free signaling by explicit out-of-band exchange.
 *
 * The user copies a code from one browser and pastes it into the other. There
 * is no server, no WebSocket and no polling — which is exactly why this works
 * with no infrastructure, and exactly why it cannot be automatic.
 *
 * The published code is only made available for copying; `publish` does not
 * transmit anything. See `ManualSignalingAdapter.getPublished`.
 */
export class ManualSignalingAdapter implements SignalingAdapter {
  readonly capabilities: SignalingCapabilities = {
    id: 'manual',
    label: 'Manual exchange (copy & paste)',
    crossDevice: true,
    requiresManualExchange: true,
    description:
      'Session descriptions are exchanged by hand. Works between any two browsers with no server, ' +
      'but both sides must be able to reach each other over the network.',
  }

  private events: Partial<SignalingEvents> = {}
  private published: SignalEnvelope | null = null
  private connected = false

  async connect(events: Partial<SignalingEvents>): Promise<void> {
    this.events = events
    this.connected = true
  }

  async publish(envelope: SignalEnvelope): Promise<void> {
    if (!this.connected) throw new Error('The signaling adapter is not connected.')
    this.published = envelope
  }

  /** The code the local user should copy, or null if nothing is ready yet. */
  getPublished(): { envelope: SignalEnvelope; code: string } | null {
    if (!this.published) return null
    return { envelope: this.published, code: encodePayload(this.published) }
  }

  /** Accept a pasted code and route it to the matching handler. */
  async ingest(raw: string): Promise<void> {
    const result = parseEnvelope(raw)
    if (!result.ok) {
      this.events.onError?.(result.error)
      return
    }
    if (result.envelope.kind === 'offer') {
      this.events.onOffer?.(result.envelope)
    } else {
      this.events.onAnswer?.(result.envelope)
    }
  }

  disconnect(): void {
    this.connected = false
    this.events = {}
    this.published = null
  }
}
