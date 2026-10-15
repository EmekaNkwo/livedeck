import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioLevel } from '@/types/audio'
import { SILENT_LEVEL } from '@/types/audio'
import { PROGRAM_METER_ID, meterBus } from './meter-bus'

const loud: AudioLevel = { rms: 0.6, peak: 0.9, db: -4.4, clipping: false }
const quiet: AudioLevel = { rms: 0.1, peak: 0.2, db: -20, clipping: false }

afterEach(() => {
  meterBus.clear()
})

describe('meterBus', () => {
  it('reports silence for a channel that has never published', () => {
    expect(meterBus.get('nobody')).toEqual(SILENT_LEVEL)
    expect(meterBus.hasListeners()).toBe(false)
  })

  it('delivers a published level only to that channel’s subscribers', () => {
    const host = vi.fn()
    const guest = vi.fn()
    meterBus.subscribe('host', host)
    meterBus.subscribe('guest', guest)

    meterBus.publish('host', loud)

    expect(host).toHaveBeenCalledExactlyOnceWith(loud)
    expect(guest).not.toHaveBeenCalled()
    expect(meterBus.get('host')).toBe(loud)
  })

  it('replays the latest value to a new subscriber immediately', () => {
    meterBus.publish('host', loud)
    meterBus.publish('host', quiet)
    const listener = vi.fn()
    meterBus.subscribe('host', listener)
    expect(listener).toHaveBeenCalledExactlyOnceWith(quiet)
  })

  it('does not replay anything when the channel has no reading yet', () => {
    const listener = vi.fn()
    meterBus.subscribe('host', listener)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe and forgets empty channels', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = meterBus.subscribe('host', first)
    const offSecond = meterBus.subscribe('host', second)

    offFirst()
    meterBus.publish('host', loud)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(meterBus.hasListeners()).toBe(true)

    offSecond()
    expect(meterBus.hasListeners()).toBe(false)
    expect(() => offSecond()).not.toThrow()
  })

  it('an unsubscribe left over from before a clear is harmless', () => {
    const off = meterBus.subscribe('host', vi.fn())
    meterBus.clear()
    const fresh = vi.fn()
    meterBus.subscribe('host', fresh)
    off()
    meterBus.publish('host', loud)
    expect(fresh).toHaveBeenCalledWith(loud)
  })

  it('a throwing listener does not starve the others', () => {
    const after = vi.fn()
    meterBus.subscribe('host', () => {
      throw new Error('meter unmounted mid-frame')
    })
    meterBus.subscribe('host', after)
    expect(() => meterBus.publish('host', loud)).not.toThrow()
    expect(after).toHaveBeenCalledWith(loud)
  })

  it('reset settles subscribers and the stored value at silence', () => {
    const listener = vi.fn()
    meterBus.publish('host', loud)
    meterBus.subscribe('host', listener)
    meterBus.reset('host')
    expect(listener).toHaveBeenLastCalledWith(SILENT_LEVEL)
    expect(meterBus.get('host')).toEqual(SILENT_LEVEL)
    // A removed channel is forgotten, not kept as a silent entry.
    expect(meterBus.channelIds()).not.toContain('host')
  })

  it('clear silences every channel, then drops all listeners and readings', () => {
    const host = vi.fn()
    const program = vi.fn()
    meterBus.publish('host', loud)
    meterBus.publish(PROGRAM_METER_ID, quiet)
    meterBus.subscribe('host', host)
    meterBus.subscribe(PROGRAM_METER_ID, program)
    expect(meterBus.channelIds()).toEqual(['host', PROGRAM_METER_ID])

    meterBus.clear()

    expect(host).toHaveBeenLastCalledWith(SILENT_LEVEL)
    expect(program).toHaveBeenLastCalledWith(SILENT_LEVEL)
    expect(meterBus.channelIds()).toEqual([])
    expect(meterBus.hasListeners()).toBe(false)
    meterBus.publish('host', loud)
    // Replay on subscribe, then silence on clear; nothing after the drop.
    expect(host).toHaveBeenCalledTimes(2)
  })

  it('uses a reserved id for the program bus', () => {
    expect(PROGRAM_METER_ID).toBe('__program__')
  })
})
