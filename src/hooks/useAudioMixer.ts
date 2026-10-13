import { useCallback, useEffect, useRef } from 'react'
import type { AudioChannelConfig, AudioContextStatus } from '@/types/audio'
import { audioMixer } from '@/services/audio/audio-mixer'
import { streamRegistry } from '@/services/media/stream-registry'
import { assetCache } from '@/services/composition/asset-cache'
import { useAudioStore } from '@/stores/audioStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Keep the Web Audio graph in step with mixer configuration.
 *
 * AVOIDING NODE CHURN
 * -------------------
 * The one thing that must not happen is rebuilding AudioNodes on every render.
 * So this hook reconciles: it compares the set of channels that *should* exist
 * (config + a live stream) against the set the mixer actually has, and makes
 * only the difference. A volume change updates a GainNode in place; it never
 * recreates a MediaStreamAudioSourceNode.
 *
 * The AudioContext is created lazily from a user gesture via `initialize`,
 * because browsers start a context in `suspended` otherwise and no audio flows.
 */

export type UseAudioMixer = {
  channels: AudioChannelConfig[]
  contextStatus: AudioContextStatus
  /** Call from a user gesture (a click) to start the audio graph. */
  initialize: () => Promise<void>
  programStream: MediaStream | null

  setVolume: (channelId: string, volume: number) => void
  setGainDb: (channelId: string, gainDb: number) => void
  setMutedInMix: (channelId: string, muted: boolean) => void
  toggleMutedInMix: (channelId: string) => void
  setMonitoring: (channelId: string, monitoring: boolean) => void
  setMasterVolume: (volume: number) => void
  setProgramMonitoring: (enabled: boolean) => void
}

export function useAudioMixer(): UseAudioMixer {
  const channelsRecord = useAudioStore((state) => state.channels)
  const order = useAudioStore((state) => state.order)
  const contextStatus = useAudioStore((state) => state.contextStatus)
  const masterVolume = useAudioStore((state) => state.masterVolume)
  const programMonitoring = useAudioStore((state) => state.programMonitoring)

  const setContextStatus = useAudioStore((state) => state.setContextStatus)
  const setVolumeInStore = useAudioStore((state) => state.setVolume)
  const setGainInStore = useAudioStore((state) => state.setGainDb)
  const setMutedInStore = useAudioStore((state) => state.setMutedInMix)
  const toggleMutedInStore = useAudioStore((state) => state.toggleMutedInMix)
  const setMonitoringInStore = useAudioStore((state) => state.setMonitoring)
  const setMasterInStore = useAudioStore((state) => state.setMasterVolume)
  const setProgramMonitoringInStore = useAudioStore((state) => state.setProgramMonitoring)

  const sources = useSourceStore((state) => state.sources)
  const monitorFromSettings = useSettingsStore((state) => state.settings.monitorProgramAudio)

  /** Which stream each live channel was built from, to detect a swap. */
  const builtFrom = useRef(new Map<string, MediaStream>())

  const initialize = useCallback(async () => {
    const status = await audioMixer.initialize()
    setContextStatus(status)
  }, [setContextStatus])

  /**
   * Reconcile the graph.
   *
   * Runs whenever channel configs or source stream bindings change. Adds
   * channels whose stream has appeared, rebuilds those whose stream was
   * replaced, updates gains in place, and removes channels whose config or
   * stream is gone.
   */
  useEffect(() => {
    if (audioMixer.getStatus() === 'uninitialized' || audioMixer.getStatus() === 'unavailable') {
      return
    }

    const desired = new Map<string, { config: AudioChannelConfig; stream: MediaStream }>()

    for (const channelId of order) {
      const config = channelsRecord[channelId]
      if (!config) continue
      const source = sources[config.sourceId]
      if (!source) continue

      // Resolve the stream this channel should consume. A local video file is
      // captured from its decoded element; everything else comes from the
      // stream registry.
      let stream: MediaStream | null = null
      if (source.type === 'video') {
        stream = assetCache.captureAudio(source.id)
      } else if (source.streamKey) {
        stream = streamRegistry.getStream(source.streamKey)
      }
      if (!stream || stream.getAudioTracks().length === 0) continue

      desired.set(channelId, { config, stream })
    }

    // Remove channels that should no longer exist.
    for (const existingId of audioMixer.channelIds()) {
      if (!desired.has(existingId)) {
        audioMixer.removeChannel(existingId)
        builtFrom.current.delete(existingId)
      }
    }

    // Add or update the rest.
    for (const [channelId, { config, stream }] of desired) {
      const previousStream = builtFrom.current.get(channelId)
      if (!audioMixer.hasChannel(channelId) || previousStream !== stream) {
        // New channel, or the underlying capture was swapped (device change).
        if (audioMixer.addChannel(config, stream)) {
          builtFrom.current.set(channelId, stream)
        }
      } else {
        // Same stream: adjust gains in place. No nodes are created.
        audioMixer.updateChannel(config)
      }
    }
  }, [channelsRecord, order, sources])

  useEffect(() => {
    audioMixer.setMasterVolume(masterVolume)
  }, [masterVolume])

  useEffect(() => {
    audioMixer.setProgramMonitoring(programMonitoring)
  }, [programMonitoring])

  // Reflect the persisted preference into the store on first load.
  useEffect(() => {
    setProgramMonitoringInStore(monitorFromSettings)
  }, [monitorFromSettings, setProgramMonitoringInStore])

  /**
   * Browsers suspend an AudioContext when a tab is backgrounded. Resuming on
   * return keeps the mixer and the meters alive without the user having to
   * click anything.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return
      void audioMixer.resume().then(() => setContextStatus(audioMixer.getStatus()))
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [setContextStatus])

  const channels = order
    .map((id) => channelsRecord[id])
    .filter((channel): channel is AudioChannelConfig => Boolean(channel))

  return {
    channels,
    contextStatus,
    initialize,
    programStream: audioMixer.getProgramStream(),
    setVolume: setVolumeInStore,
    setGainDb: setGainInStore,
    setMutedInMix: setMutedInStore,
    toggleMutedInMix: toggleMutedInStore,
    setMonitoring: setMonitoringInStore,
    setMasterVolume: setMasterInStore,
    setProgramMonitoring: setProgramMonitoringInStore,
  }
}
