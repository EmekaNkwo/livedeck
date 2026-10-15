import { beforeEach, describe, expect, it } from 'vitest'
import type { AudioChannelConfig } from '@/types/audio'
import { MAX_GAIN_DB, MIN_GAIN_DB } from '@/types/audio'
import { selectChannel, selectChannelList, selectHasMutedChannel, useAudioStore } from './audioStore'

function channel(overrides: Partial<AudioChannelConfig> & Pick<AudioChannelConfig, 'id'>): AudioChannelConfig {
  return {
    sourceId: overrides.id,
    kind: 'guest',
    label: overrides.id,
    volume: 1,
    gainDb: 0,
    mutedInMix: false,
    monitoring: false,
    ...overrides,
  }
}

const store = () => useAudioStore.getState()
const get = (id: string) => store().channels[id]

beforeEach(() => {
  useAudioStore.setState({
    channels: {},
    order: [],
    contextStatus: 'uninitialized',
    masterVolume: 1,
    programMonitoring: false,
  })
})

describe('audioStore defaults', () => {
  it('starts empty, unmonitored and at unity master', () => {
    expect(store()).toMatchObject({
      channels: {},
      order: [],
      contextStatus: 'uninitialized',
      masterVolume: 1,
      programMonitoring: false,
    })
  })
})

describe('upsertChannel / removeChannel', () => {
  it('orders strips host first, then guests, display, media, and by label within a kind', () => {
    store().upsertChannel(channel({ id: 'm', kind: 'media', label: 'Music' }))
    store().upsertChannel(channel({ id: 'g2', label: 'Zoe' }))
    store().upsertChannel(channel({ id: 'd', kind: 'display', label: 'Screen' }))
    store().upsertChannel(channel({ id: 'g1', label: 'Ada' }))
    store().upsertChannel(channel({ id: 'h', kind: 'host-mic', label: 'Host' }))
    expect(store().order).toEqual(['h', 'g1', 'g2', 'd', 'm'])
  })

  it('replaces an existing channel in place without duplicating its id', () => {
    store().upsertChannel(channel({ id: 'g1', label: 'Ada' }))
    store().upsertChannel(channel({ id: 'g2', label: 'Bea' }))
    store().upsertChannel(channel({ id: 'g1', label: 'Zed' }))
    expect(store().order).toEqual(['g2', 'g1'])
    expect(get('g1')?.label).toBe('Zed')
  })

  it('removes a channel and its order entry, and ignores unknown ids', () => {
    store().upsertChannel(channel({ id: 'g1' }))
    store().upsertChannel(channel({ id: 'g2' }))
    store().removeChannel('g1')
    expect(store().order).toEqual(['g2'])
    expect(get('g1')).toBeUndefined()

    const before = store()
    store().removeChannel('nobody')
    expect(store()).toBe(before)
  })
})

describe('channel setters', () => {
  beforeEach(() => {
    store().upsertChannel(channel({ id: 'g1', volume: 0.5 }))
  })

  it('clamps volume to 0..1.5', () => {
    store().setVolume('g1', 0.8)
    expect(get('g1')?.volume).toBe(0.8)
    store().setVolume('g1', 4)
    expect(get('g1')?.volume).toBe(1.5)
    store().setVolume('g1', -1)
    expect(get('g1')?.volume).toBe(0)
    store().setVolume('g1', Number.NaN)
    expect(get('g1')?.volume).toBe(0)
  })

  it('clamps the input trim to the dB range', () => {
    store().setGainDb('g1', 6)
    expect(get('g1')?.gainDb).toBe(6)
    store().setGainDb('g1', 40)
    expect(get('g1')?.gainDb).toBe(MAX_GAIN_DB)
    store().setGainDb('g1', -40)
    expect(get('g1')?.gainDb).toBe(MIN_GAIN_DB)
  })

  it('sets and toggles mute independently of monitoring', () => {
    store().setMutedInMix('g1', true)
    expect(get('g1')).toMatchObject({ mutedInMix: true, monitoring: false })
    store().toggleMutedInMix('g1')
    expect(get('g1')?.mutedInMix).toBe(false)
    store().toggleMutedInMix('g1')
    expect(get('g1')?.mutedInMix).toBe(true)

    store().setMonitoring('g1', true)
    expect(get('g1')).toMatchObject({ mutedInMix: true, monitoring: true })
  })

  it('renames a channel', () => {
    store().setLabel('g1', 'Guest one')
    expect(get('g1')?.label).toBe('Guest one')
  })

  it('updates immutably: the previous channel object is untouched', () => {
    const previous = get('g1')
    store().setVolume('g1', 1)
    expect(previous?.volume).toBe(0.5)
    expect(get('g1')).not.toBe(previous)
  })

  it('every setter is a no-op for an unknown channel', () => {
    const before = store()
    store().setVolume('nobody', 1)
    store().setGainDb('nobody', 1)
    store().setMutedInMix('nobody', true)
    store().toggleMutedInMix('nobody')
    store().setMonitoring('nobody', true)
    store().setLabel('nobody', 'x')
    expect(store()).toBe(before)
    expect(store().channels.nobody).toBeUndefined()
  })
})

describe('program settings', () => {
  it('stores the context status', () => {
    store().setContextStatus('running')
    expect(store().contextStatus).toBe('running')
  })

  it('clamps master volume to 0..1.5', () => {
    store().setMasterVolume(0.7)
    expect(store().masterVolume).toBe(0.7)
    store().setMasterVolume(3)
    expect(store().masterVolume).toBe(1.5)
    store().setMasterVolume(-2)
    expect(store().masterVolume).toBe(0)
  })

  it('toggles program monitoring', () => {
    store().setProgramMonitoring(true)
    expect(store().programMonitoring).toBe(true)
  })
})

describe('hydrate / clear', () => {
  it('never restores monitoring on, keeping everything else', () => {
    store().hydrate(
      [channel({ id: 'h', kind: 'host-mic', monitoring: true, volume: 0.4, mutedInMix: true })],
      ['h'],
    )
    expect(get('h')).toMatchObject({ monitoring: false, volume: 0.4, mutedInMix: true })
  })

  it('drops order entries with no channel and appends channels missing from the order', () => {
    store().hydrate(
      [channel({ id: 'g1', label: 'Ada' }), channel({ id: 'h', kind: 'host-mic', label: 'Host' })],
      ['ghost', 'g1'],
    )
    expect(store().order).toEqual(['h', 'g1'])
    expect(Object.keys(store().channels).sort()).toEqual(['g1', 'h'])
  })

  it('lists each channel once even when the saved order repeats an id', () => {
    store().hydrate([channel({ id: 'a' })], ['a', 'a'])
    expect(store().order).toEqual(['a'])
  })

  it('replaces whatever was there before', () => {
    store().upsertChannel(channel({ id: 'old' }))
    store().hydrate([channel({ id: 'new' })], ['new'])
    expect(store().order).toEqual(['new'])
    expect(get('old')).toBeUndefined()
  })

  it('clear empties the mixer and resets the context status', () => {
    store().upsertChannel(channel({ id: 'g1' }))
    store().setContextStatus('running')
    store().clear()
    expect(store()).toMatchObject({ channels: {}, order: [], contextStatus: 'uninitialized' })
  })
})

describe('selectors', () => {
  it('lists channels in display order', () => {
    store().upsertChannel(channel({ id: 'g1', label: 'Bea' }))
    store().upsertChannel(channel({ id: 'h', kind: 'host-mic', label: 'Host' }))
    expect(selectChannelList(store()).map((c) => c.id)).toEqual(['h', 'g1'])
  })

  it('skips order entries whose channel is gone', () => {
    store().upsertChannel(channel({ id: 'g1' }))
    useAudioStore.setState({ order: ['g1', 'stale'] })
    expect(selectChannelList(store()).map((c) => c.id)).toEqual(['g1'])
  })

  it('selects one channel by id, or null', () => {
    store().upsertChannel(channel({ id: 'g1' }))
    expect(selectChannel('g1')(store())?.id).toBe('g1')
    expect(selectChannel('nobody')(store())).toBeNull()
    expect(selectChannel(null)(store())).toBeNull()
  })

  it('reports whether any channel is muted in the mix', () => {
    store().upsertChannel(channel({ id: 'g1' }))
    expect(selectHasMutedChannel(store())).toBe(false)
    store().setMutedInMix('g1', true)
    expect(selectHasMutedChannel(store())).toBe(true)
  })
})
