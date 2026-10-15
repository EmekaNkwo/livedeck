import { create } from 'zustand'
import type { AudioChannelConfig, AudioChannelKind, AudioContextStatus } from '@/types/audio'
import { MAX_GAIN_DB, MIN_GAIN_DB } from '@/types/audio'
import { clamp } from '@/utils/geometry'

/**
 * Mixer configuration.
 *
 * Holds only *configuration* — fader positions, trims, mute and monitoring
 * flags. The AudioNodes themselves live in the AudioMixer service, and the
 * level readings never enter this store at all; they are published on the
 * meter bus so that 20Hz-per-channel updates cannot trigger React renders.
 */

type AudioState = {
  channels: Record<string, AudioChannelConfig>
  order: string[]
  contextStatus: AudioContextStatus
  masterVolume: number
  /** Program bus routed to local speakers. Off by default (feedback risk). */
  programMonitoring: boolean

  upsertChannel: (channel: AudioChannelConfig) => void
  removeChannel: (channelId: string) => void
  setVolume: (channelId: string, volume: number) => void
  setGainDb: (channelId: string, gainDb: number) => void
  setMutedInMix: (channelId: string, muted: boolean) => void
  toggleMutedInMix: (channelId: string) => void
  setMonitoring: (channelId: string, monitoring: boolean) => void
  setLabel: (channelId: string, label: string) => void

  setContextStatus: (status: AudioContextStatus) => void
  setMasterVolume: (volume: number) => void
  setProgramMonitoring: (enabled: boolean) => void

  hydrate: (channels: AudioChannelConfig[], order: string[]) => void
  clear: () => void
}

/** Display order for mixer strips: host first, then guests, then media. */
const KIND_WEIGHT: Record<AudioChannelKind, number> = {
  'host-mic': 0,
  guest: 1,
  display: 2,
  media: 3,
}

export const useAudioStore = create<AudioState>()((set) => ({
  channels: {},
  order: [],
  contextStatus: 'uninitialized',
  masterVolume: 1,
  programMonitoring: false,

  upsertChannel: (channel) =>
    set((state) => {
      const channels = { ...state.channels, [channel.id]: channel }
      const order = state.order.includes(channel.id) ? state.order : [...state.order, channel.id]
      return { channels, order: sortChannelIds(order, channels) }
    }),

  removeChannel: (channelId) =>
    set((state) => {
      if (!state.channels[channelId]) return state
      const channels = { ...state.channels }
      delete channels[channelId]
      return { channels, order: state.order.filter((id) => id !== channelId) }
    }),

  setVolume: (channelId, volume) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state
      return {
        channels: {
          ...state.channels,
          [channelId]: { ...channel, volume: clamp(volume, 0, 1.5) },
        },
      }
    }),

  setGainDb: (channelId, gainDb) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state
      return {
        channels: {
          ...state.channels,
          [channelId]: { ...channel, gainDb: clamp(gainDb, MIN_GAIN_DB, MAX_GAIN_DB) },
        },
      }
    }),

  setMutedInMix: (channelId, mutedInMix) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state
      return { channels: { ...state.channels, [channelId]: { ...channel, mutedInMix } } }
    }),

  toggleMutedInMix: (channelId) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state
      return {
        channels: {
          ...state.channels,
          [channelId]: { ...channel, mutedInMix: !channel.mutedInMix },
        },
      }
    }),

  setMonitoring: (channelId, monitoring) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state
      return { channels: { ...state.channels, [channelId]: { ...channel, monitoring } } }
    }),

  setLabel: (channelId, label) =>
    set((state) => {
      const channel = state.channels[channelId]
      if (!channel) return state
      return { channels: { ...state.channels, [channelId]: { ...channel, label } } }
    }),

  setContextStatus: (contextStatus) => set({ contextStatus }),
  setMasterVolume: (masterVolume) => set({ masterVolume: clamp(masterVolume, 0, 1.5) }),
  setProgramMonitoring: (programMonitoring) => set({ programMonitoring }),

  hydrate: (channels, order) =>
    set(() => {
      const map: Record<string, AudioChannelConfig> = {}
      for (const channel of channels) {
        // Monitoring is never restored on. Reloading into a live mic routed to
        // the speakers would create instant feedback.
        map[channel.id] = { ...channel, monitoring: false }
      }
      // A corrupted saved order may repeat ids; each appears once.
      const known = [...new Set(order.filter((id) => map[id]))]
      const missing = channels.map((channel) => channel.id).filter((id) => !known.includes(id))
      return { channels: map, order: sortChannelIds([...known, ...missing], map) }
    }),

  clear: () => set({ channels: {}, order: [], contextStatus: 'uninitialized' }),
}))

function sortChannelIds(
  ids: string[],
  channels: Record<string, AudioChannelConfig>,
): string[] {
  return [...ids].sort((a, b) => {
    const left = channels[a]
    const right = channels[b]
    if (!left || !right) return 0
    const weight = KIND_WEIGHT[left.kind] - KIND_WEIGHT[right.kind]
    return weight !== 0 ? weight : left.label.localeCompare(right.label)
  })
}

/* ---------------------------------------------------------------- selectors */

export const selectChannelList = (state: AudioState): AudioChannelConfig[] =>
  state.order.map((id) => state.channels[id]).filter((c): c is AudioChannelConfig => Boolean(c))

export const selectChannel =
  (channelId: string | null) =>
  (state: AudioState): AudioChannelConfig | null =>
    channelId ? (state.channels[channelId] ?? null) : null

/** True when any channel is excluded from the program mix. */
export const selectHasMutedChannel = (state: AudioState): boolean =>
  Object.values(state.channels).some((channel) => channel.mutedInMix)
