import { useCallback, useMemo } from 'react'
import type { Guest, PeerState, PeerStats } from '@/types/peer'
import { streamRegistry } from '@/services/media/stream-registry'
import { streamKeys } from '@/services/sources/source-factory'
import { useMediaSessionStore } from '@/media/session-store'
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
  /** Live camera/microphone stream backing this guest, if any. */
  stream: MediaStream | null
  /** The guest's shared screen, if they are sharing one. */
  screenStream: MediaStream | null
  videoSourceId: string | null
  audioSourceId: string | null
  screenSourceId: string | null
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
  attachStream: (guestId: string, stream: MediaStream, options?: AttachOptions) => void
  detachStream: (guestId: string, options?: AttachOptions) => void
}

export type AttachOptions = {
  /** The stream is a shared screen, not the guest's face. */
  screen?: boolean
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
    (guestId: string, screen = false) => {
      let videoSourceId: string | null = null
      let audioSourceId: string | null = null
      for (const source of Object.values(useSourceStore.getState().sources)) {
        const settings = source.settings
        if (settings.kind !== 'remote-video' && settings.kind !== 'remote-audio') continue
        if (settings.guestId !== guestId || Boolean(settings.screen) !== screen) continue
        if (settings.kind === 'remote-video') videoSourceId = source.id
        else audioSourceId = source.id
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
    (guestId: string, stream: MediaStream, options?: AttachOptions) => {
      const guest = useGuestStore.getState().guests[guestId]
      if (!guest) return
      const screen = options?.screen ?? false
      const key = screen ? streamKeys.guestScreen(guestId) : streamKeys.guest(guestId)
      const suffix = screen ? 'screen' : 'video'

      if (streamRegistry.getStream(key) !== stream) streamRegistry.register(key, stream)

      const existing = findGuestSources(guestId, screen)
      const hasVideo = stream.getVideoTracks().length > 0
      const hasAudio = stream.getAudioTracks().length > 0

      if (hasVideo) {
        if (existing.videoSourceId) {
          replaceStream(existing.videoSourceId, key)
        } else {
          addSource({
            name: `${guest.name} ${suffix}`,
            type: 'remote-video',
            streamKey: key,
            settings: { kind: 'remote-video', guestId, ...(screen ? { screen: true } : {}) },
            addToMixer: false,
            // A shared screen is placed by the operator, not automatically.
            ...(screen ? { addToScene: false } : {}),
          })
          // The video source registered the key; the audio source below takes
          // its own reference.
        }
      } else if (existing.videoSourceId) {
        removeSource(existing.videoSourceId)
      }

      if (hasAudio) {
        if (existing.audioSourceId) {
          replaceStream(existing.audioSourceId, key)
        } else {
          if (hasVideo || existing.videoSourceId) streamRegistry.retain(key)
          addSource({
            name: `${guest.name} ${screen ? 'screen audio' : 'audio'}`,
            type: 'remote-audio',
            streamKey: key,
            settings: { kind: 'remote-audio', guestId, ...(screen ? { screen: true } : {}) },
            mixerKind: 'guest',
            addToScene: false,
          })
        }
      } else if (existing.audioSourceId) {
        removeSource(existing.audioSourceId)
      }
    },
    [addSource, findGuestSources, removeSource, replaceStream],
  )

  const detachStream = useCallback(
    (guestId: string, options?: AttachOptions) => {
      const screens = options ? [options.screen ?? false] : [false, true]
      for (const screen of screens) {
        const { videoSourceId, audioSourceId } = findGuestSources(guestId, screen)
        if (videoSourceId) removeSource(videoSourceId)
        if (audioSourceId) removeSource(audioSourceId)
      }
    },
    [findGuestSources, removeSource],
  )

  const addPeerGuest = useCallback(
    (name?: string) => addGuestToStore({ name }),
    [addGuestToStore],
  )

  /**
   * Remove a guest row and release the sources it owns.
   *
   * The media itself belongs to the session's consumers, which the session
   * closes when the participant leaves or is kicked; this only drops the
   * production model's view of them.
   */
  const removeGuest = useCallback(
    (guestId: string) => {
      const guest = useGuestStore.getState().guests[guestId]
      detachStream(guestId)
      if (guest?.peerId) removePeer(guest.peerId)
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
          'This guest will be removed from the room and their sources taken out of every scene.',
        confirmLabel: 'Remove guest',
        destructive: true,
        onConfirm: () => {
          const session = useMediaSessionStore.getState().session
          if (guest.peerId && session) {
            void session.control(guest.peerId, { action: 'kick' }).catch(() => undefined)
          }
          removeGuest(guestId)
        },
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
        const stream = streamRegistry.getStream(streamKeys.guest(guest.id))
        const screenStream = streamRegistry.getStream(streamKeys.guestScreen(guest.id))

        let videoSourceId: string | null = null
        let audioSourceId: string | null = null
        let screenSourceId: string | null = null
        for (const source of Object.values(sources)) {
          const settings = source.settings
          if (settings.kind === 'remote-video' && settings.guestId === guest.id) {
            if (settings.screen) screenSourceId = source.id
            else videoSourceId = source.id
          }
          if (settings.kind === 'remote-audio' && settings.guestId === guest.id && !settings.screen) {
            audioSourceId = source.id
          }
        }

        return {
          guest,
          peer,
          stats,
          stream,
          screenStream,
          videoSourceId,
          audioSourceId,
          screenSourceId,
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
  if (!peer) return 'Not in the room'
  switch (peer.status) {
    case 'connected':
      // Media arrival is shown separately on the tile; this is the connection.
      return 'Connected'
    case 'connecting':
      return 'Connecting to the media server'
    case 'reconnecting':
      return 'Connection interrupted — recovering'
    case 'failed':
      return peer.error ?? 'Connection failed'
    case 'closed':
      return 'Disconnected'
  }
}

