import { beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice, FakeSignaling, asDevice, asSignalingClient } from '@/test/fake-mediasoup'
import { MediaSession } from './media-session'
import { selectSession, selectSnapshot, useMediaSessionStore } from './session-store'
import { INITIAL_SNAPSHOT } from './types'

function makeSession(): MediaSession {
  return new MediaSession({
    url: 'ws://test',
    createSignaling: () => asSignalingClient(new FakeSignaling()),
    createDevice: () => asDevice(new FakeDevice()),
  })
}

beforeEach(() => {
  useMediaSessionStore.setState({ session: null, snapshot: INITIAL_SNAPSHOT, quality: null })
})

describe('session store', () => {
  it('mirrors the attached session’s snapshots and clears on detach', async () => {
    const session = makeSession()
    const detach = useMediaSessionStore.getState().attach(session)
    expect(selectSession(useMediaSessionStore.getState())).toBe(session)
    await session.start({ room: 'studio', label: 'Me' })
    expect(selectSnapshot(useMediaSessionStore.getState()).status).toBe('joined')
    useMediaSessionStore.getState().setQuality({
      downlinkTier: 2,
      uplinkTier: 2,
      downlink: { packetLoss: null, roundTripTimeMs: null, jitterMs: null, bitrateKbps: null },
      uplink: { packetLoss: null, roundTripTimeMs: null, bitrateKbps: null },
      sampledAt: 1,
    })
    detach()
    expect(useMediaSessionStore.getState().session).toBeNull()
    expect(useMediaSessionStore.getState().snapshot).toBe(INITIAL_SNAPSHOT)
    expect(useMediaSessionStore.getState().quality).toBeNull()
    session.leave()
  })

  it('ignores snapshots from a session that is no longer attached', async () => {
    const first = makeSession()
    const second = makeSession()
    useMediaSessionStore.getState().attach(first)
    useMediaSessionStore.getState().attach(second)
    await first.start({ room: 'studio', label: 'A' })
    expect(useMediaSessionStore.getState().snapshot.status).toBe('idle')
    first.leave()
    second.leave()
  })
})
