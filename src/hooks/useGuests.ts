import { useCallback, useMemo } from 'react'
import type { Guest, PeerState, PeerStats } from '@/types/peer'
import { streamRegistry } from '@/services/media/stream-registry'
import { peerManager } from '@/services/webrtc/peer-manager'
import { streamKeys } from '@/services/sources/source-factory'
import { useGuestStore } from '@/stores/guestStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useAudioStore } from '@/stores/audioStore'
import { useStudioStore } from '@/stores/studioStore'
import { useMediaSources } from './useMediaSources'

/**
 * Guest management.
 *
 * A guest row is identity and layout only; it holds no live objects. Media
 * arrives from `useWebRTC`, which binds an incoming remote stream to the
 * guest's video and audio sources.
 *
 * A guest existing here says nothing about whether its connection succeeded —
 * `connected` is derived solely from the real peer state, so the UI can never
 * imply a connection that does not exist.
 */

export type GuestView = {
  guest: Guest
  peer: PeerState | null
  stats: PeerStats | null
  /** Live stream backing this guest, if any. */
  stream: MediaStream | null
  videoSourceId: string | null
  audioSourceId: string | null
  /** Honest one-line status for the UI. */
  statusLabel: string
  connected: boolean
}

export type UseGuests = {
  guests: GuestView[]
  addPeerGuest: (name?: string) => Guest
  requestRemoveGuest: (guestId: string) => void
  removeGuest: (guestId: string) => void
  renameGuest: (guestId: string, name: string) => void
  setMutedInMix: (guestId: string, muted: boolean) => void
  setVideoHidden: (guestId: string, hidden: boolean) => void
  /** Attach an incoming remote stream to a guest's sources. */
  attachStream: (guestId: string, stream: MediaStream) => void
  detachStream: (guestId: string) => void
}

export function useGuests(): UseGuests {
  const guestsRecord = useGuestStore((state) => state.guests)
  const order = useGuestStore((state) => state.order)
  const peerStates = useGuestStore((state) => state.peerStates)
  const peerStats = useGuestStore((state) => state.peerStats)

  const addGuestToStore = useGuestStore((state) => state.addGuest)
  const removeGuestFromStore = useGuestStore((state) => state.removeGuest)
  const renameInStore = useGuestStore((state) => state.renameGuest)
  const setMutedInStore = useGuestStore((state) => state.setMutedInMix)
  const setHiddenInStore = useGuestStore((state) => state.setVideoHidden)
  const removePeer = useGuestStore((state) => state.removePeer)

  const sources = useSourceStore((state) => state.sources)
  const setMixMuted = useAudioStore((state) => state.setMutedInMix)
  const requestConfirm = useStudioStore((state) => state.requestConfirm)

  const { addSource, removeSource, replaceStream } = useMediaSources()

  /**
   * Find a guest's video/audio source ids.
   *
   * Reads the store directly rather than the `sources` snapshot this hook
   * rendered with. That is load-bearing, not tidiness: `ontrack` fires **once
   * per track**, so a guest sending camera and microphone calls
   * {@link attachStream} twice in immediate succession — before React has
   * re-rendered. Against a stale snapshot the second call could not see the
   * source the first had just created, so it created another one, and the
   * guest appeared twice in the scene.
   */
  const findGuestSources = useCallback(
    (guestId: string) => {
      let videoSourceId: string | null = null
      let audioSourceId: string | null = null
      for (const source of Object.values(useSourceStore.getState().sources)) {
        if (source.settings.kind === 'remote-video' && source.settings.guestId === guestId) {
          videoSourceId = source.id
        }
        if (source.settings.kind === 'remote-audio' && source.settings.guestId === guestId) {
          audioSourceId = source.id
        }
      }
      return { videoSourceId, audioSourceId }
    },
    // No dependency on the rendered `sources` snapshot — reading the store
    // keeps this callback stable, which also stops `attachStream` from being
    // rebuilt (and the peer manager reconfigured) on every source change.
    [],
  )

  /**
   * Create the video and audio sources for a guest and bind them to a stream.
   * Both sources share one stream key, so the registry refcount is 2 and
   * removing one does not stop the other.
   */
  const attachStream = useCallback(
    (guestId: string, stream: MediaStream) => {
      const guest = useGuestStore.getState().guests[guestId]
      if (!guest) return
      const key = streamKeys.guest(guestId)

      streamRegistry.register(key, stream)

      const existing = findGuestSources(guestId)
      const hasVideo = stream.getVideoTracks().length > 0
      const hasAudio = stream.getAudioTracks().length > 0

      if (hasVideo) {
        if (existing.videoSourceId) {
          replaceStream(existing.videoSourceId, key)
        } else {
          addSource({
            name: `${guest.name} video`,
            type: 'remote-video',
            streamKey: key,
            settings: { kind: 'remote-video', guestId },
            addToMixer: false,
          })
          // The video source registered the key; the audio source below takes
          // its own reference.
        }
      }

      if (hasAudio) {
        if (existing.audioSourceId) {
          replaceStream(existing.audioSourceId, key)
        } else {
          if (hasVideo) streamRegistry.retain(key)
          addSource({
            name: `${guest.name} audio`,
            type: 'remote-audio',
            streamKey: key,
            settings: { kind: 'remote-audio', guestId },
            mixerKind: 'guest',
            addToScene: false,
          })
        }
      }
    },
    [addSource, findGuestSources, replaceStream],
  )

  const detachStream = useCallback(
    (guestId: string) => {
      const { videoSourceId, audioSourceId } = findGuestSources(guestId)
      if (videoSourceId) removeSource(videoSourceId)
      if (audioSourceId) removeSource(audioSourceId)
    },
    [findGuestSources, removeSource],
  )

  const addPeerGuest = useCallback(
    (name?: string) => addGuestToStore({ name }),
    [addGuestToStore],
  )

  /**
   * Remove a guest and release everything it owns.
   *
   * Closing the peer connection is essential and easy to miss: dropping the
   * guest row alone would leave a live RTCPeerConnection — and its ICE agent,
   * transports and stats timer — running with nothing referencing it.
   * `peerManager` is a plain service, so this does not create a dependency on
   * `useWebRTC`.
   */
  const removeGuest = useCallback(
    (guestId: string) => {
      const guest = useGuestStore.getState().guests[guestId]
      detachStream(guestId)
      if (guest?.peerId) {
        peerManager.closePeer(guest.peerId)
        removePeer(guest.peerId)
      }
      removeGuestFromStore(guestId)
    },
    [detachStream, removeGuestFromStore, removePeer],
  )

  const requestRemoveGuest = useCallback(
    (guestId: string) => {
      const guest = useGuestStore.getState().guests[guestId]
      if (!guest) return
      requestConfirm({
        title: `Remove ${guest.name}?`,
        message:
          'The peer connection will be closed and this guest’s sources removed from every scene.',
        confirmLabel: 'Remove guest',
        destructive: true,
        onConfirm: () => removeGuest(guestId),
      })
    },
    [removeGuest, requestConfirm],
  )

  /**
   * Muting a guest mutes them in the *local program mix* only. It does not
   * signal anything to the remote peer, who keeps sending audio and has no
   * idea they were muted here.
   */
  const setMutedInMix = useCallback(
    (guestId: string, muted: boolean) => {
      setMutedInStore(guestId, muted)
      const { audioSourceId } = findGuestSources(guestId)
      if (audioSourceId) setMixMuted(audioSourceId, muted)
    },
    [findGuestSources, setMixMuted, setMutedInStore],
  )

  /** Hiding a guest hides their video in every scene but keeps the placement. */
  const setVideoHidden = useCallback(
    (guestId: string, hidden: boolean) => {
      setHiddenInStore(guestId, hidden)
      const { videoSourceId } = findGuestSources(guestId)
      if (!videoSourceId) return
      // Applies to every scene: hiding a guest is a production-wide decision,
      // not a per-scene layout tweak. The placements themselves are kept.
      const { scenes, updateItem } = useSceneStore.getState()
      for (const scene of Object.values(scenes)) {
        if (scene.items.some((item) => item.sourceId === videoSourceId)) {
          updateItem(scene.id, videoSourceId, { visible: !hidden })
        }
      }
    },
    [findGuestSources, setHiddenInStore],
  )

  const guests = useMemo<GuestView[]>(() => {
    return order
      .map((id) => guestsRecord[id])
      .filter((guest): guest is Guest => Boolean(guest))
      .map((guest) => {
        const peer = guest.peerId ? (peerStates[guest.peerId] ?? null) : null
        const stats = guest.peerId ? (peerStats[guest.peerId] ?? null) : null
        const key = streamKeys.guest(guest.id)
        const stream = streamRegistry.getStream(key)

        let videoSourceId: string | null = null
        let audioSourceId: string | null = null
        for (const source of Object.values(sources)) {
          if (source.settings.kind === 'remote-video' && source.settings.guestId === guest.id) {
            videoSourceId = source.id
          }
          if (source.settings.kind === 'remote-audio' && source.settings.guestId === guest.id) {
            audioSourceId = source.id
          }
        }

        return {
          guest,
          peer,
          stats,
          stream,
          videoSourceId,
          audioSourceId,
          statusLabel: describeGuestStatus(peer),
          // Only a real peer in the connected state counts as connected.
          connected: peer?.status === 'connected',
        }
      })
  }, [guestsRecord, order, peerStates, peerStats, sources])

  return {
    guests,
    addPeerGuest,
    requestRemoveGuest,
    removeGuest,
    renameGuest: renameInStore,
    setMutedInMix,
    setVideoHidden,
    attachStream,
    detachStream,
  }
}

/**
 * Honest status text.
 *
 * Reports the guest's real transport state and nothing more; a row with no
 * peer says so rather than implying it is waiting on something that is
 * already underway.
 */
function describeGuestStatus(peer: PeerState | null): string {
  if (!peer) return 'No connection — awaiting signaling'
  switch (peer.status) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting — running connectivity checks'
    case 'waiting-for-offer':
      return 'Waiting for the host’s offer'
    case 'waiting-for-answer':
      return 'Waiting for this guest’s answer'
    case 'reconnecting':
      return 'Connection interrupted — attempting to recover'
    case 'failed':
      return peer.error ?? 'Connection failed'
    case 'closed':
      return 'Disconnected'
    case 'initializing':
      return 'Preparing connection'
  }
}

