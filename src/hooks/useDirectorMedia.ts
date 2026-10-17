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
 * The first control room to open a room claims it and is handed the
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
  const guests = useGuests()
  const participantToGuest = useRef(new Map<string, string>())

  /*
   * The guest helpers are rebuilt whenever the source list changes, and the
   * effects below *change* the source list. Depending on them directly made
   * the effect re-run on its own output: a render loop that React stops with
   * "maximum update depth exceeded" the moment two guests were in the room.
   * The latest helpers are read through a ref instead; the snapshot slices
   * are the only inputs.
   */
  const helpers = useRef(guests)
  helpers.current = guests

  const guestFor = useCallback((participant: Participant): string => {
    const existing = participantToGuest.current.get(participant.id)
    if (existing) return existing
    const guest = helpers.current.addPeerGuest(participant.label)
    participantToGuest.current.set(participant.id, guest.id)
    useGuestStore.getState().bindPeer(guest.id, participant.id)
    return guest.id
  }, [])

  const { participants, tracks, status, signaling, recvTransport, error } = snapshot

  // Roster → rows and live state.
  useEffect(() => {
    const store = useGuestStore.getState()
    const present = new Set<string>()
    for (const participant of participants) {
      if (participant.role === 'director') continue
      present.add(participant.id)
      const guestId = guestFor(participant)
      const current = useGuestStore.getState().guests[guestId]
      if (current && current.name !== participant.label) {
        store.renameGuest(guestId, participant.label)
      }
      const mine = tracks.filter((t) => t.participantId === participant.id)
      const nextPeer = describePeer(participant, mine, { status, recvTransport, error })
      if (!shallowEqual(useGuestStore.getState().peerStates[participant.id], nextPeer)) store.setPeerState(nextPeer)
      const nextControl = describeControl(participant, { status, signaling })
      if (!shallowEqual(useGuestStore.getState().controlStates[participant.id], nextControl)) {
        store.setControlState(nextControl)
      }
    }
    for (const [participantId, guestId] of [...participantToGuest.current]) {
      if (present.has(participantId)) continue
      participantToGuest.current.delete(participantId)
      store.removePeer(participantId)
      helpers.current.removeGuest(guestId)
    }
  }, [error, guestFor, participants, recvTransport, signaling, status, tracks])

  // Tracks → streams in the registry → sources.
  const attached = useRef(new Map<string, string>()) // registry key → fingerprint
  useEffect(() => {
    const byParticipant = new Map<string, RemoteTrack[]>()
    for (const track of snapshot.tracks) {
      const list = byParticipant.get(track.participantId) ?? []
      byParticipant.set(track.participantId, [...list, track])
    }
    const liveKeys = new Set<string>()
    for (const [participantId, mine] of byParticipant) {
      const guestId = participantToGuest.current.get(participantId)
      if (!guestId) continue
      const faceTracks = mine.filter((t) => t.source === 'camera' || t.source === 'mic')
      const screenTracks = mine.filter((t) => t.source === 'screen' || t.source === 'screen-audio')
      if (faceTracks.length > 0) {
        const key = streamKeys.guest(guestId)
        liveKeys.add(key)
        syncStream(key, faceTracks, attached.current, (stream) => helpers.current.attachStream(guestId, stream))
      }
      if (screenTracks.length > 0) {
        const key = streamKeys.guestScreen(guestId)
        liveKeys.add(key)
        syncStream(key, screenTracks, attached.current, (stream) =>
          helpers.current.attachStream(guestId, stream, { screen: true }),
        )
      }
    }
    for (const key of [...attached.current.keys()]) {
      if (liveKeys.has(key)) continue
      attached.current.delete(key)
      const guestId = key.split(':')[1]
      if (!guestId) continue
      helpers.current.detachStream(guestId, { screen: key.startsWith('guest-screen:') })
    }
  }, [tracks])

  // Everything goes when the session does.
  useEffect(
    () => () => {
      const store = useGuestStore.getState()
      for (const [participantId, guestId] of participantToGuest.current) {
        store.removePeer(participantId)
        helpers.current.removeGuest(guestId)
      }
      participantToGuest.current.clear()
      attached.current.clear()
    },
    [],
  )
}

function shallowEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  if (!a) return false
  const keys = Object.keys(b)
  if (keys.length !== Object.keys(a).length) return false
  return keys.every((key) => a[key] === b[key])
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

function describePeer(
  participant: Participant,
  tracks: RemoteTrack[],
  session: Pick<SessionSnapshot, 'status' | 'recvTransport' | 'error'>,
): PeerState {
  const transport = session.recvTransport
  const status: PeerState['status'] =
    session.status === 'recovering' || transport === 'disconnected'
      ? 'reconnecting'
      : transport === 'failed' || session.status === 'failed'
        ? 'failed'
        : session.status === 'joined'
          ? 'connected'
          : 'connecting'
  return {
    peerId: participant.id,
    role: 'guest',
    status,
    error: session.status === 'failed' ? session.error : null,
    hasRemoteVideo: tracks.some((t) => t.kind === 'video' && !t.producerPaused),
    hasRemoteAudio: tracks.some((t) => t.kind === 'audio' && !t.producerPaused),
    connectedAt: participant.joinedAt,
    transport,
  }
}

function describeControl(
  participant: Participant,
  session: Pick<SessionSnapshot, 'status' | 'signaling'>,
): ControlChannelState {
  return {
    peerId: participant.id,
    open: session.status === 'joined' && session.signaling === 'connected',
    latencyMs: null,
    reportedMicMuted: participant.micMuted,
    reportedCameraMuted: participant.cameraMuted,
    sharing: participant.sharing,
    onAir: participant.onAir,
    lastMessageAt: null,
  }
}
