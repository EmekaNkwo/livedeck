import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Participant } from '@shared/protocol'
import type { RemoteTrack, SessionSnapshot } from '@/media/types'
import { readJson, writeJson } from '@/services/persistence/local-store'
import { streamRegistry } from '@/services/media/stream-registry'
import { streamKeys } from '@/services/sources/source-factory'
import { useGuestStore } from '@/stores/guestStore'
import type { PeerState } from '@/types/peer'
import type { ControlChannelState } from '@/types/room'
import { useGuests } from './useGuests'
import { useMediaSession, type UseMediaSession } from './useMediaSession'

/**
 * The control room's view of the room.
 *
 * Binds the media session to the production model: every participant that
 * publishes media becomes a guest row with remote-video and remote-audio
 * sources, fed by the consumers' tracks. A participant with no media is still
 * a row, honestly labelled as such.
 *
 * ROOM KEYS
 * ---------
 * The first control room to open an empty room claims it and is handed the
 * director key, which is stored per room so a reload keeps the role. A link
 * carrying `?key=` wins over the stored one, so a director can be moved to
 * another machine by sharing its link.
 */

export type DirectorMedia = UseMediaSession & {
  room: string
  keys: { directorKey: string; producerKey: string } | null
}

function keyStorage(room: string): string {
  return `room-key:${room}`
}

export function useDirectorMedia(room: string, keyFromUrl: string | null): DirectorMedia {
  const storedKey = useMemo(() => readJson<string>(keyStorage(room), '') || null, [room])
  const key = keyFromUrl ?? storedKey ?? undefined

  const session = useMediaSession({
    join: room ? { room, label: 'Director', key, claim: true } : null,
  })
  const { snapshot } = session
  const keysRef = useRef<{ directorKey: string; producerKey: string } | null>(null)
  const keysStore = useGuestStore((state) => state.roomKeys)
  const setRoomKeys = useGuestStore((state) => state.setRoomKeys)

  // Once in as director, fetch and remember the keys.
  useEffect(() => {
    if (snapshot.status !== 'joined' || snapshot.role !== 'director' || keysRef.current) return
    void session.getRoomKeys().then((keys) => {
      if (!keys) return
      keysRef.current = keys
      writeJson(keyStorage(room), keys.directorKey)
      setRoomKeys(keys)
    })
  }, [room, session, setRoomKeys, snapshot.role, snapshot.status])

  useEffect(() => {
    keysRef.current = null
    setRoomKeys(null)
  }, [room, setRoomKeys])

  useParticipantBinding(snapshot)

  return { ...session, room, keys: keysStore }
}

/**
 * Keep guest rows, sources and live state in step with the snapshot.
 *
 * One guest row per participant, keyed by participant id. Tracks are grouped
 * per participant into a camera+mic stream and, separately, a screen stream,
 * so a shared screen is its own source rather than replacing the face.
 */
function useParticipantBinding(snapshot: SessionSnapshot): void {
  const { addPeerGuest, attachStream, detachStream, removeGuest } = useGuests()
  const bindPeer = useGuestStore((state) => state.bindPeer)
  const setPeerState = useGuestStore((state) => state.setPeerState)
  const setControlState = useGuestStore((state) => state.setControlState)
  const removePeer = useGuestStore((state) => state.removePeer)
  const participantToGuest = useRef(new Map<string, string>())

  const guestFor = useCallback(
    (participant: Participant): string => {
      const existing = participantToGuest.current.get(participant.id)
      if (existing) return existing
      const guest = addPeerGuest(participant.label)
      participantToGuest.current.set(participant.id, guest.id)
      bindPeer(guest.id, participant.id)
      return guest.id
    },
    [addPeerGuest, bindPeer],
  )

  // Roster → rows and live state.
  useEffect(() => {
    const present = new Set<string>()
    for (const participant of snapshot.participants) {
      if (participant.role === 'director') continue
      present.add(participant.id)
      const guestId = guestFor(participant)
      const current = useGuestStore.getState().guests[guestId]
      if (current && current.name !== participant.label) {
        useGuestStore.getState().renameGuest(guestId, participant.label)
      }
      const tracks = snapshot.tracks.filter((t) => t.participantId === participant.id)
      setPeerState(describePeer(participant, tracks, snapshot))
      setControlState(describeControl(participant, snapshot))
    }
    for (const [participantId, guestId] of [...participantToGuest.current]) {
      if (present.has(participantId)) continue
      participantToGuest.current.delete(participantId)
      removePeer(participantId)
      removeGuest(guestId)
    }
  }, [guestFor, removeGuest, removePeer, setControlState, setPeerState, snapshot])

  // Tracks → streams in the registry → sources.
  const attached = useRef(new Map<string, string>()) // registry key → fingerprint
  useEffect(() => {
    const byParticipant = new Map<string, RemoteTrack[]>()
    for (const track of snapshot.tracks) {
      const list = byParticipant.get(track.participantId) ?? []
      byParticipant.set(track.participantId, [...list, track])
    }
    const liveKeys = new Set<string>()
    for (const [participantId, tracks] of byParticipant) {
      const guestId = participantToGuest.current.get(participantId)
      if (!guestId) continue
      const faceTracks = tracks.filter((t) => t.source === 'camera' || t.source === 'mic')
      const screenTracks = tracks.filter((t) => t.source === 'screen' || t.source === 'screen-audio')
      if (faceTracks.length > 0) {
        const key = streamKeys.guest(guestId)
        liveKeys.add(key)
        syncStream(key, faceTracks, attached.current, (stream) => attachStream(guestId, stream))
      }
      if (screenTracks.length > 0) {
        const key = streamKeys.guestScreen(guestId)
        liveKeys.add(key)
        syncStream(key, screenTracks, attached.current, (stream) =>
          attachStream(guestId, stream, { screen: true }),
        )
      }
    }
    for (const key of [...attached.current.keys()]) {
      if (liveKeys.has(key)) continue
      attached.current.delete(key)
      const guestId = key.split(':')[1]
      if (!guestId) continue
      detachStream(guestId, { screen: key.startsWith('guest-screen:') })
    }
  }, [attachStream, detachStream, snapshot.tracks])

  // Everything goes when the session does.
  useEffect(
    () => () => {
      for (const [participantId, guestId] of participantToGuest.current) {
        removePeer(participantId)
        removeGuest(guestId)
      }
      participantToGuest.current.clear()
      attached.current.clear()
    },
    [removeGuest, removePeer],
  )
}

function syncStream(
  key: string,
  tracks: RemoteTrack[],
  attached: Map<string, string>,
  attach: (stream: MediaStream) => void,
): void {
  const fingerprint = tracks.map((t) => t.consumerId).sort().join('|')
  if (attached.get(key) === fingerprint) return
  attached.set(key, fingerprint)
  const existing = streamRegistry.getStream(key)
  const stream = new MediaStream()
  for (const t of tracks) stream.addTrack(t.track)
  if (existing) {
    // Swap tracks in place where possible so the source keeps its element.
    for (const track of existing.getTracks()) if (!stream.getTracks().includes(track)) existing.removeTrack(track)
    for (const track of stream.getTracks()) if (!existing.getTracks().includes(track)) existing.addTrack(track)
    attach(existing)
    return
  }
  attach(stream)
}

function describePeer(participant: Participant, tracks: RemoteTrack[], snapshot: SessionSnapshot): PeerState {
  const transport = snapshot.recvTransport
  const status: PeerState['status'] =
    snapshot.status === 'recovering' || transport === 'disconnected'
      ? 'reconnecting'
      : transport === 'failed' || snapshot.status === 'failed'
        ? 'failed'
        : snapshot.status === 'joined'
          ? 'connected'
          : 'connecting'
  return {
    peerId: participant.id,
    role: 'guest',
    status,
    error: snapshot.status === 'failed' ? snapshot.error : null,
    hasRemoteVideo: tracks.some((t) => t.kind === 'video' && !t.producerPaused),
    hasRemoteAudio: tracks.some((t) => t.kind === 'audio' && !t.producerPaused),
    connectedAt: participant.joinedAt,
    transport,
  }
}

function describeControl(participant: Participant, snapshot: SessionSnapshot): ControlChannelState {
  return {
    peerId: participant.id,
    open: snapshot.status === 'joined' && snapshot.signaling === 'connected',
    latencyMs: null,
    reportedMicMuted: participant.micMuted,
    reportedCameraMuted: participant.cameraMuted,
    sharing: participant.sharing,
    onAir: participant.onAir,
    lastMessageAt: null,
  }
}
