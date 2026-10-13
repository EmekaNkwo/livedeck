import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STUN_URLS,
  buildIceServers,
  buildPeerConfiguration,
  countCandidates,
  describeConnectivity,
  hasPublicCandidate,
  hasRelayCandidate,
  waitForIceGathering,
} from './ice'

/**
 * ICE configuration and the vanilla-ICE gathering wait.
 *
 * The connectivity assessment is the mechanism that keeps the UI honest about
 * NAT traversal, so the mapping from candidate types to the warning the user
 * sees is covered explicitly.
 */

const hostOnlySdp = ['v=0', 'a=candidate:1 1 udp 1 192.168.1.5 50000 typ host'].join('\r\n')
const srflxSdp = [hostOnlySdp, 'a=candidate:2 1 udp 1 203.0.113.9 50001 typ srflx'].join('\r\n')
const relaySdp = [srflxSdp, 'a=candidate:3 1 udp 1 198.51.100.4 50002 typ relay'].join('\r\n')

describe('buildIceServers', () => {
  it('falls back to the default STUN servers for empty input', () => {
    expect(buildIceServers([])).toEqual([{ urls: [...DEFAULT_STUN_URLS] }])
    expect(buildIceServers(['', '   '])).toEqual([{ urls: [...DEFAULT_STUN_URLS] }])
  })

  it('groups STUN URLs into one entry', () => {
    const servers = buildIceServers(['stun:a.example:3478', 'stun:b.example:3478'])
    expect(servers).toHaveLength(1)
    expect(servers[0]?.urls).toHaveLength(2)
  })

  it('parses TURN credentials from the pipe syntax', () => {
    const servers = buildIceServers(['turn:relay.example:3478|alice:secret'])
    expect(servers[0]).toEqual({
      urls: ['turn:relay.example:3478'],
      username: 'alice',
      credential: 'secret',
    })
  })

  it('accepts TURN without credentials', () => {
    const servers = buildIceServers(['turn:relay.example:3478'])
    expect(servers[0]?.urls).toEqual(['turn:relay.example:3478'])
    expect(servers[0]?.username).toBeUndefined()
  })

  it('puts STUN first when mixed with TURN', () => {
    const servers = buildIceServers(['turn:relay.example:3478', 'stun:a.example:3478'])
    expect(servers[0]?.urls[0]).toContain('stun:')
  })
})

describe('buildPeerConfiguration', () => {
  it('allows every candidate type and bundles media', () => {
    const config = buildPeerConfiguration([])
    expect(config.iceTransportPolicy).toBe('all')
    expect(config.bundlePolicy).toBe('max-bundle')
    expect(config.rtcpMuxPolicy).toBe('require')
  })
})

describe('candidate inspection', () => {
  it('counts candidate lines', () => {
    expect(countCandidates(hostOnlySdp)).toBe(1)
    expect(countCandidates(relaySdp)).toBe(3)
    expect(countCandidates('v=0')).toBe(0)
  })

  it('detects public and relay candidates', () => {
    expect(hasPublicCandidate(hostOnlySdp)).toBe(false)
    expect(hasPublicCandidate(srflxSdp)).toBe(true)
    expect(hasRelayCandidate(srflxSdp)).toBe(false)
    expect(hasRelayCandidate(relaySdp)).toBe(true)
  })
})

describe('describeConnectivity', () => {
  const outcome = (sdp: string, complete = true) => ({
    description: { sdp, type: 'offer' } as RTCSessionDescription,
    complete,
    candidateCount: countCandidates(sdp),
    elapsedMs: 100,
    hasPublicCandidate: hasPublicCandidate(sdp),
  })

  it('reports a dead configuration when nothing was gathered', () => {
    const result = describeConnectivity(outcome('v=0'))
    expect(result.level).toBe('poor')
    expect(result.message).toMatch(/will not succeed/i)
  })

  it('reports host-only candidates as same-network only', () => {
    const result = describeConnectivity(outcome(hostOnlySdp))
    expect(result.level).toBe('poor')
    expect(result.message).toMatch(/same network/i)
  })

  it('warns about symmetric NAT for a STUN-only set', () => {
    // This is the honest-limitation path that stops the UI from implying
    // connections will always work.
    const result = describeConnectivity(outcome(srflxSdp))
    expect(result.level).toBe('limited')
    expect(result.message).toMatch(/symmetric NAT/i)
    expect(result.message).toMatch(/TURN/i)
  })

  it('reports a relay as good', () => {
    const result = describeConnectivity(outcome(relaySdp))
    expect(result.level).toBe('good')
    expect(result.message).toMatch(/relay/i)
  })

  it('mentions a gathering timeout', () => {
    const result = describeConnectivity(outcome(hostOnlySdp, false))
    expect(result.message).toMatch(/timed out/i)
  })
})

describe('waitForIceGathering', () => {
  /** A peer connection stub that lets a test drive gathering state. */
  function fakePeer(initialState: RTCIceGatheringState = 'gathering') {
    const listeners = new Map<string, Set<EventListener>>()
    const peer = {
      iceGatheringState: initialState,
      localDescription: { sdp: srflxSdp, type: 'offer' } as RTCSessionDescription,
      addEventListener: (type: string, listener: EventListener) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener)
      },
      emit: (type: string, event: unknown = {}) => {
        for (const listener of listeners.get(type) ?? []) listener(event as Event)
      },
      listenerCount: () =>
        [...listeners.values()].reduce((total, set) => total + set.size, 0),
    }
    return peer
  }

  it('resolves immediately when gathering is already complete', async () => {
    const peer = fakePeer('complete')
    const outcome = await waitForIceGathering(peer as unknown as RTCPeerConnection)
    expect(outcome.complete).toBe(true)
    expect(outcome.candidateCount).toBe(2)
    expect(outcome.hasPublicCandidate).toBe(true)
  })

  it('resolves when the gathering state reaches complete', async () => {
    const peer = fakePeer()
    const promise = waitForIceGathering(peer as unknown as RTCPeerConnection)
    peer.iceGatheringState = 'complete'
    peer.emit('icegatheringstatechange')
    const outcome = await promise
    expect(outcome.complete).toBe(true)
  })

  it('resolves on the null end-of-candidates signal', async () => {
    // Some browsers fire this before the state transition.
    const peer = fakePeer()
    const promise = waitForIceGathering(peer as unknown as RTCPeerConnection)
    peer.emit('icecandidate', { candidate: null })
    const outcome = await promise
    expect(outcome.complete).toBe(true)
  })

  it('resolves early on timeout rather than hanging forever', async () => {
    // An unreachable TURN server can keep gathering indefinitely; a partial
    // candidate set is still worth trying.
    vi.useFakeTimers()
    const peer = fakePeer()
    const promise = waitForIceGathering(peer as unknown as RTCPeerConnection, 1000)
    await vi.advanceTimersByTimeAsync(1001)
    const outcome = await promise
    expect(outcome.complete).toBe(false)
    expect(outcome.candidateCount).toBe(2)
    vi.useRealTimers()
  })

  it('removes its listeners once settled', async () => {
    const peer = fakePeer()
    const promise = waitForIceGathering(peer as unknown as RTCPeerConnection)
    peer.iceGatheringState = 'complete'
    peer.emit('icegatheringstatechange')
    await promise
    expect(peer.listenerCount()).toBe(0)
  })

  it('rejects when no local description was produced', async () => {
    const peer = fakePeer('complete')
    peer.localDescription = null as unknown as RTCSessionDescription
    await expect(waitForIceGathering(peer as unknown as RTCPeerConnection)).rejects.toThrow(
      /local session description/i,
    )
  })
})
