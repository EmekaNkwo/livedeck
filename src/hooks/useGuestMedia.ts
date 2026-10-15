import { useEffect, useMemo, useRef } from 'react'
import type { MediaSource, Participant } from '@shared/protocol'
import type { RemoteTrack } from '@/media/types'
import { streamRegistry } from '@/services/media/stream-registry'
import { useSourceStore } from '@/stores/sourceStore'
import { GUEST_SCREEN_KEY } from './useGuestScreenShare'
import { useMediaSession, type UseMediaSession } from './useMediaSession'

/**
 * A guest's media: publish what is captured, receive everyone else.
 *
 * PUBLISHING
 * ----------
 * Whatever is live in the stream registry goes out, each as its own
 * producer: microphone, camera, and a screen share with its audio when the
 * browser provided one. The camera keeps going while a screen is shared;
 * the receiving side decides what to show.
 *
 * RECEIVING
 * ---------
 * Remote tracks are grouped per participant into a face stream (camera plus
 * microphone) and a screen stream. Mix-minus is a property of the topology:
 * a participant never consumes its own producers, so it never hears itself.
 */

export type RemoteParticipantView = {
  participant: Participant
  stream: MediaStream | null
  screenStream: MediaStream | null
  /** True when any video track from them is currently arriving. */
  hasVideo: boolean
  hasAudio: boolean
}

export type UseGuestMedia = UseMediaSession & {
  remotes: RemoteParticipantView[]
}

export type UseGuestMediaOptions = {
  room: string
  /** Null until the guest clicks Join. */
  label: string | null
  key?: string | null
}

export function useGuestMedia({ room, label, key }: UseGuestMediaOptions): UseGuestMedia {
  const session = useMediaSession({
    join: label ? { room, label, key: key ?? undefined } : null,
  })
  const { snapshot, produce, closeProducer } = session

  // Fingerprint of live local captures, so publishing follows the registry.
  const liveKeys = useSourceStore((state) =>
    Object.values(state.sources)
      .map((source) => source.streamKey)
      .filter((k): k is string => Boolean(k))
      .sort()
      .join('|'),
  )
  const screenLive = streamRegistry.has(GUEST_SCREEN_KEY)

  useEffect(() => {
    if (snapshot.status !== 'joined') return
    const wanted = new Map<MediaSource, MediaStreamTrack>()
    for (const registryKey of streamRegistry.keys()) {
      const stream = streamRegistry.getStream(registryKey)
      if (!stream) continue
      if (registryKey.startsWith('camera:')) {
        const track = stream.getVideoTracks()[0]
        if (track) wanted.set('camera', track)
      } else if (registryKey.startsWith('mic:')) {
        const track = stream.getAudioTracks()[0]
        if (track) wanted.set('mic', track)
      } else if (registryKey === GUEST_SCREEN_KEY) {
        const video = stream.getVideoTracks()[0]
        const audio = stream.getAudioTracks()[0]
        if (video) wanted.set('screen', video)
        if (audio) wanted.set('screen-audio', audio)
      }
    }
    for (const [source, track] of wanted) void produce(source, track)
    for (const source of ['camera', 'mic', 'screen', 'screen-audio'] as const) {
      if (!wanted.has(source)) void closeProducer(source)
    }
    // `liveKeys` and `screenLive` are the triggers; the registry is the data.
  }, [closeProducer, liveKeys, produce, screenLive, snapshot.status])

  // Keep sharing state in step for the roster.
  const lastSharing = useRef<boolean | null>(null)
  useEffect(() => {
    if (snapshot.status !== 'joined') return
    const sharing = snapshot.producers.some((p) => p.source === 'screen')
    if (lastSharing.current === sharing) return
    lastSharing.current = sharing
    void session.updateState({ sharing }).catch(() => undefined)
  }, [session, snapshot.producers, snapshot.status])

  const remotes = useMemo(() => buildRemotes(snapshot.participants, snapshot.tracks), [snapshot.participants, snapshot.tracks])

  return { ...session, remotes }
}

/**
 * Streams per participant, reused across renders while their tracks are
 * unchanged so a `<video>` element is not re-bound on every snapshot.
 */
const streamCache = new Map<string, { fingerprint: string; stream: MediaStream }>()

function cachedStream(cacheKey: string, tracks: RemoteTrack[]): MediaStream | null {
  if (tracks.length === 0) {
    streamCache.delete(cacheKey)
    return null
  }
  const fingerprint = tracks.map((t) => t.consumerId).sort().join('|')
  const cached = streamCache.get(cacheKey)
  if (cached && cached.fingerprint === fingerprint) return cached.stream
  const stream = new MediaStream(tracks.map((t) => t.track))
  streamCache.set(cacheKey, { fingerprint, stream })
  return stream
}

function buildRemotes(participants: Participant[], tracks: RemoteTrack[]): RemoteParticipantView[] {
  const views: RemoteParticipantView[] = []
  const seen = new Set<string>()
  for (const participant of participants) {
    if (participant.role === 'director') continue
    seen.add(participant.id)
    const mine = tracks.filter((t) => t.participantId === participant.id)
    const face = mine.filter((t) => t.source === 'camera' || t.source === 'mic')
    const screen = mine.filter((t) => t.source === 'screen' || t.source === 'screen-audio')
    views.push({
      participant,
      stream: cachedStream(`face:${participant.id}`, face),
      screenStream: cachedStream(`screen:${participant.id}`, screen),
      hasVideo: face.some((t) => t.kind === 'video' && !t.producerPaused),
      hasAudio: face.some((t) => t.kind === 'audio' && !t.producerPaused),
    })
  }
  for (const cacheKey of [...streamCache.keys()]) {
    const id = cacheKey.slice(cacheKey.indexOf(':') + 1)
    if (!seen.has(id)) streamCache.delete(cacheKey)
  }
  return views
}
