import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlChannelState } from '@/types/room'
import type { PeerManagerEvents } from '@/services/webrtc/peer-manager'

/**
 * Screen-share announcement delivery.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ----------------------------
 * A shared screen reaches a peer as an ordinary video track — there is one
 * video transceiver and a share *replaces* the camera — so the receiver only
 * knows it is a screen because the sender says so over the control channel.
 *
 * That announcement used to be fired when the participant *count* changed. A
 * peer enters the roster the moment the relay announces it, which is long
 * before ICE finishes and SCTP brings the data channel to `open`, and
 * `ControlChannel.send` discards anything sent before then with no queue. So
 * the announcement was reliably too early.
 *
 * Locally that never showed: over host candidates the channel opens within a
 * microtask, so the race was essentially always won — every unit test and
 * every e2e run passed. Across two real networks through a TURN relay it was
 * essentially always lost, and the share stayed laid out as a face for the
 * rest of the session because nothing re-sent it.
 *
 * The fix keys the announcement on the channel's *open* transition, an
 * ordering that cannot be too early. These tests drive that transition
 * directly, which is the only way to express "the channel opened late" without
 * a real network.
 *
 * SCOPE: the peer manager is mocked. What is under test is the wiring — which
 * event triggers a send, and what gets sent — not WebRTC itself, which
 * `peer-manager.test.ts` covers.
 */

const sendControl = vi.fn<(peerId: string, message: unknown) => boolean>()
const broadcastControl = vi.fn<(message: unknown) => number>()
let capturedEvents: Partial<PeerManagerEvents> = {}

vi.mock('@/services/webrtc/peer-manager', () => ({
  peerManager: {
    configure: (options: { events: Partial<PeerManagerEvents> }) => {
      capturedEvents = options.events
    },
    sendControl: (peerId: string, message: unknown) => sendControl(peerId, message),
    broadcastControl: (message: unknown) => broadcastControl(message),
    setLocalStream: async () => {},
    closeAll: () => {},
    closePeer: () => {},
    listPeers: () => [],
    getRemoteStream: () => null,
    isSupported: () => true,
    isControlOpen: () => false,
    createOffer: async () => null,
    createOfferTo: async () => null,
    acceptOffer: async () => null,
    acceptAnswer: async () => false,
    addRemoteCandidate: async () => {},
    getPeer: () => null,
  },
}))

const { useWebRTC } = await import('./useWebRTC')

function controlState(peerId: string, open: boolean): ControlChannelState {
  return {
    peerId,
    open,
    latencyMs: null,
    reportedMicMuted: null,
    reportedCameraMuted: null,
    lastMessageAt: null,
  }
}

beforeEach(() => {
  sendControl.mockReset().mockReturnValue(true)
  broadcastControl.mockReset().mockReturnValue(0)
  capturedEvents = {}
})

describe('sharing announcement delivery', () => {
  it('re-sends the sharing state to a peer whose channel opens late', () => {
    const { result } = renderHook(() => useWebRTC({ send: 'camera' }))

    // The share starts while no channel is open yet — the broadcast reaches
    // nobody, which is exactly the deployed failure.
    act(() => result.current.announceSharing(true))
    expect(broadcastControl).toHaveBeenCalledWith({ v: 1, type: 'sharing', sharing: true })
    expect(sendControl).not.toHaveBeenCalled()

    // The channel finally opens, seconds later over a relay.
    act(() => capturedEvents.onControlState?.(controlState('peer-1', true)))

    expect(sendControl).toHaveBeenCalledWith('peer-1', {
      v: 1,
      type: 'sharing',
      sharing: true,
    })
  })

  it('replays the latest state, not the first', () => {
    const { result } = renderHook(() => useWebRTC({ send: 'camera' }))

    act(() => result.current.announceSharing(true))
    act(() => result.current.announceSharing(false))
    act(() => capturedEvents.onControlState?.(controlState('peer-1', true)))

    // A peer joining after a share *stopped* must not be told it is running.
    expect(sendControl).toHaveBeenCalledWith('peer-1', {
      v: 1,
      type: 'sharing',
      sharing: false,
    })
  })

  it('catches up every peer independently as each channel opens', () => {
    const { result } = renderHook(() => useWebRTC({ send: 'camera' }))

    act(() => result.current.announceSharing(true))
    act(() => capturedEvents.onControlState?.(controlState('peer-1', true)))
    act(() => capturedEvents.onControlState?.(controlState('peer-2', true)))

    expect(sendControl).toHaveBeenCalledWith('peer-1', expect.anything())
    expect(sendControl).toHaveBeenCalledWith('peer-2', expect.anything())
  })

  it('sends nothing on a channel that merely closed', () => {
    const { result } = renderHook(() => useWebRTC({ send: 'camera' }))

    act(() => result.current.announceSharing(true))
    act(() => capturedEvents.onControlState?.(controlState('peer-1', false)))

    expect(sendControl).not.toHaveBeenCalled()
  })

  it('stays silent for a role that never announces', () => {
    // A director does not share, and must not start emitting guest messages
    // just because a control channel came up.
    renderHook(() => useWebRTC({ send: 'program' }))

    act(() => capturedEvents.onControlState?.(controlState('peer-1', true)))

    expect(sendControl).not.toHaveBeenCalled()
  })
})
