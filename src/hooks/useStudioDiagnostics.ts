import { useEffect, useState } from 'react'
import type { TrackSnapshot } from '@/types/media'
import type { RecordingFormat } from '@/types/recording'
import type { PeerState, PeerStats } from '@/types/peer'
import type { CapabilityGap } from '@/lib/capabilities'
import { findCapabilityGaps } from '@/lib/capabilities'
import { streamRegistry } from '@/services/media/stream-registry'
import { compositor } from '@/services/composition/compositor'
import type { CompositorStats } from '@/services/composition/compositor'
import { audioMixer } from '@/services/audio/audio-mixer'
import { listSupportedFormats } from '@/services/recording/mime'
import { trackedUrlCount } from '@/services/persistence/object-urls'
import { useStudioStore } from '@/stores/studioStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useGuestStore } from '@/stores/guestStore'
import { useAudioStore } from '@/stores/audioStore'
import { useRecordingStore } from '@/stores/recordingStore'

/**
 * Technical inspection.
 *
 * THE RULE THIS HOOK FOLLOWS
 * --------------------------
 * Every metric is either a real reading or an explicit "unavailable". No value
 * is estimated, interpolated or invented. `PeerStats` fields are nullable
 * precisely so the UI can render a dash instead of a plausible-looking number.
 *
 * Polled on a timer rather than subscribed per-frame: diagnostics are for
 * reading, and a 1Hz refresh costs nothing.
 */

export type PeerDiagnostic = {
  peerId: string
  guestName: string
  state: PeerState
  stats: PeerStats | null
}

export type StudioDiagnostics = {
  capabilityGaps: CapabilityGap[]

  cameraStatus: string
  microphoneStatus: string
  screenStatus: string
  cameraPermission: string
  microphonePermission: string
  lastMediaError: ReturnType<typeof useStudioStore.getState>['lastMediaError']

  streams: Array<{ key: string; refCount: number; tracks: TrackSnapshot[] }>
  activeTrackCount: number

  activeSceneName: string | null
  sceneCount: number
  sourceCount: number
  visibleSourceCount: number

  compositor: CompositorStats & { running: boolean; canvas: string }

  audioContextStatus: string
  mixerChannelCount: number
  mutedChannelCount: number

  recordingStatus: string
  recordingFormat: string | null
  /**
   * Full format records rather than labels: two candidates can share a label
   * ("MP4 · H.264 + AAC") while differing in codec string, so the mimeType is
   * the only stable identity.
   */
  supportedFormats: RecordingFormat[]

  peers: PeerDiagnostic[]
  objectUrlCount: number
}

const POLL_INTERVAL_MS = 1000

export function useStudioDiagnostics(): StudioDiagnostics {
  const cameraStatus = useStudioStore((state) => state.cameraStatus)
  const microphoneStatus = useStudioStore((state) => state.microphoneStatus)
  const screenStatus = useStudioStore((state) => state.screenStatus)
  const cameraPermission = useStudioStore((state) => state.cameraPermission)
  const microphonePermission = useStudioStore((state) => state.microphonePermission)
  const lastMediaError = useStudioStore((state) => state.lastMediaError)

  const sources = useSourceStore((state) => state.sources)
  const scenes = useSceneStore((state) => state.scenes)
  const activeSceneId = useSceneStore((state) => state.activeSceneId)
  const guests = useGuestStore((state) => state.guests)
  const peerStates = useGuestStore((state) => state.peerStates)
  const peerStats = useGuestStore((state) => state.peerStats)
  const channels = useAudioStore((state) => state.channels)
  const audioContextStatus = useAudioStore((state) => state.contextStatus)
  const recordingStatus = useRecordingStore((state) => state.status)
  const recordingFormat = useRecordingStore((state) => state.format)

  /** Live readings that are not in any store, sampled on a timer. */
  const [live, setLive] = useState(() => sampleLive())

  useEffect(() => {
    const timer = setInterval(() => setLive(sampleLive()), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const activeScene = activeSceneId ? scenes[activeSceneId] : null
  const visibleSourceCount = activeScene?.items.filter((item) => item.visible).length ?? 0

  const peers: PeerDiagnostic[] = Object.values(peerStates).map((state) => {
    const guest = Object.values(guests).find((candidate) => candidate.peerId === state.peerId)
    return {
      peerId: state.peerId,
      guestName: guest?.name ?? 'Unknown peer',
      state,
      // Stats only exist once a connection is up; before that, null is honest.
      stats: peerStats[state.peerId] ?? null,
    }
  })

  return {
    capabilityGaps: findCapabilityGaps(),

    cameraStatus,
    microphoneStatus,
    screenStatus,
    cameraPermission,
    microphonePermission,
    lastMediaError,

    streams: live.streams,
    activeTrackCount: live.streams.reduce(
      (total, entry) => total + entry.tracks.filter((track) => track.readyState === 'live').length,
      0,
    ),

    activeSceneName: activeScene?.name ?? null,
    sceneCount: Object.keys(scenes).length,
    sourceCount: Object.keys(sources).length,
    visibleSourceCount,

    compositor: live.compositor,

    audioContextStatus,
    mixerChannelCount: Object.keys(channels).length,
    mutedChannelCount: Object.values(channels).filter((channel) => channel.mutedInMix).length,

    recordingStatus,
    recordingFormat: recordingFormat?.label ?? null,
    supportedFormats: live.supportedFormats,

    peers,
    objectUrlCount: live.objectUrlCount,
  }
}

function sampleLive() {
  const canvas = compositor.getCanvas()
  const output = compositor.getOutputSize()
  return {
    streams: streamRegistry.keys().map((key) => ({
      key,
      refCount: streamRegistry.refCount(key),
      tracks: streamRegistry.snapshotTracks(key),
    })),
    compositor: {
      ...compositor.getStats(),
      running: compositor.isRunning(),
      canvas: canvas ? `${output.width}×${output.height}` : 'not attached',
    },
    supportedFormats: listSupportedFormats(),
    objectUrlCount: trackedUrlCount(),
    audioStatus: audioMixer.getStatus(),
  }
}

