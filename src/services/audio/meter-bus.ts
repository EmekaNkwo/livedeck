import type { AudioLevel } from '@/types/audio'
import { SILENT_LEVEL } from '@/types/audio'

/**
 * Publish/subscribe bus for audio level readings.
 *
 * WHY NOT ZUSTAND
 * ---------------
 * Levels update ~20 times a second per channel. Routing that through React
 * state would re-render the studio continuously and make the whole interface
 * feel sluggish. Instead, meter components subscribe to this bus directly and
 * mutate a DOM node (a transform on a bar), so a meter costs nothing in React.
 *
 * Subscribers are keyed per channel, so adding a sixth guest does not wake the
 * other five meters.
 */

type Listener = (level: AudioLevel) => void

class MeterBus {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly latest = new Map<string, AudioLevel>()

  subscribe(channelId: string, listener: Listener): () => void {
    let set = this.listeners.get(channelId)
    if (!set) {
      set = new Set()
      this.listeners.set(channelId, set)
    }
    set.add(listener)
    // Deliver the last known value immediately so a freshly-mounted meter is
    // not blank until the next poll.
    const current = this.latest.get(channelId)
    if (current) listener(current)
    return () => {
      const current2 = this.listeners.get(channelId)
      if (!current2) return
      current2.delete(listener)
      if (current2.size === 0) this.listeners.delete(channelId)
    }
  }

  publish(channelId: string, level: AudioLevel): void {
    this.latest.set(channelId, level)
    const set = this.listeners.get(channelId)
    if (!set) return
    for (const listener of set) {
      try {
        listener(level)
      } catch {
        // A throwing meter must not stall the polling loop for other channels.
      }
    }
  }

  get(channelId: string): AudioLevel {
    return this.latest.get(channelId) ?? SILENT_LEVEL
  }

  /** Called when a channel is removed, so meters settle at silence. */
  reset(channelId: string): void {
    // Tell listeners the channel went silent, then forget it entirely.
    this.publish(channelId, SILENT_LEVEL)
    this.latest.delete(channelId)
  }

  clear(): void {
    for (const id of [...this.latest.keys()]) this.reset(id)
    this.listeners.clear()
    this.latest.clear()
  }

  /** True when at least one component is watching — lets the mixer idle. */
  hasListeners(): boolean {
    return this.listeners.size > 0
  }

  channelIds(): string[] {
    return [...this.latest.keys()]
  }
}

export const meterBus = new MeterBus()

/** Program (master) bus meter uses a reserved channel id. */
export const PROGRAM_METER_ID = '__program__'
