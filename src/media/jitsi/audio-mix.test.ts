import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeTrack } from '@/test/fake-media'
import { SendAudioMix } from './audio-mix'

let contexts: Array<{ closed: boolean; sources: Array<{ connected: boolean }> }>
let mixedTrack: MediaStreamTrack

beforeEach(() => {
  contexts = []
  mixedTrack = fakeTrack('audio', 'mixed')
  vi.stubGlobal('MediaStream', class {
    tracks: MediaStreamTrack[]
    constructor(tracks: MediaStreamTrack[]) {
      this.tracks = tracks
    }
  })
  vi.stubGlobal(
    'AudioContext',
    class {
      record = { closed: false, sources: [] as Array<{ connected: boolean }> }
      constructor() {
        contexts.push(this.record)
      }
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [mixedTrack], getTracks: () => [mixedTrack] } }
      }
      createMediaStreamSource() {
        const source = { connected: false, connect: () => { source.connected = true }, disconnect: () => { source.connected = false } }
        this.record.sources.push(source)
        return source
      }
      async close() {
        this.record.closed = true
      }
    },
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('SendAudioMix', () => {
  it('passes a single source through without an audio graph', () => {
    const mix = new SendAudioMix()
    const mic = fakeTrack('audio')
    expect(mix.output([mic, null])).toBe(mic)
    expect(mix.output([])).toBeNull()
    expect(contexts).toHaveLength(0)
  })

  it('mixes two live sources into one track, and reuses the mix for the same inputs', () => {
    const mix = new SendAudioMix()
    const mic = fakeTrack('audio')
    const screen = fakeTrack('audio')
    expect(mix.output([mic, screen])).toBe(mixedTrack)
    expect(mix.output([mic, screen])).toBe(mixedTrack)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.sources.every((source) => source.connected)).toBe(true)
  })

  it('tears the graph down when back to one source, and ignores ended tracks', () => {
    const mix = new SendAudioMix()
    const mic = fakeTrack('audio')
    const screen = fakeTrack('audio')
    mix.output([mic, screen])
    screen.stop()
    expect(mix.output([mic, screen])).toBe(mic)
    expect(contexts[0]?.closed).toBe(true)
    expect(mixedTrack.readyState).toBe('ended')
  })
})
