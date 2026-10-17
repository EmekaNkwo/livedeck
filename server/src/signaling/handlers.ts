import { randomUUID } from 'node:crypto'
import { canControl, hasCapability } from '../../../shared/authorization'
import type {
  MediaGrant,
  ParsedRequest,
  RequestMethod,
  RequestParams,
  ResponseResult,
  Role,
} from '../../../shared/protocol'
import type { GrantIssuer } from '../jitsi/grants'
import { Peer, type PeerSend } from '../rooms/peer'
import { Room, RoomError } from '../rooms/room'
import type { RoomManager } from '../rooms/room-manager'
import { newResumeToken, type KeyService } from './authorization'

/**
 * One function per request method.
 *
 * Every handler receives the session that sent the request. Identity comes
 * from there, never from the payload: a request names a target participant,
 * and the handler resolves authority from `session.peer.role` against the
 * shared capability table.
 */

/** How long a dropped participant is held waiting for a resume. */
export const RESUME_GRACE_MS = 30_000

export type Session = {
  id: string
  address: string
  peer: Peer | null
  room: Room | null
  send: PeerSend
}

export type HandlerContext = {
  session: Session
  rooms: RoomManager
  keys: KeyService
  /** Signs Jitsi tokens; null when no media backend is configured. */
  grants: GrantIssuer | null
  log: (event: string, detail?: Record<string, unknown>) => void
  /** Overridable for tests; defaults to {@link RESUME_GRACE_MS}. */
  resumeGraceMs?: number
}

type Handler<M extends RequestMethod> = (
  ctx: HandlerContext,
  params: RequestParams<M>,
) => Promise<ResponseResult<M>>

function requireJoined(ctx: HandlerContext): { peer: Peer; room: Room } {
  const { peer, room } = ctx.session
  if (!peer || !room || room.isClosed) {
    throw new RoomError('not-joined', 'Join a room first.')
  }
  // A session whose participant was resumed elsewhere has been told so; it
  // may not keep acting on the participant's behalf.
  if (!peer.isAttachedTo(ctx.session.send)) {
    ctx.session.peer = null
    ctx.session.room = null
    throw new RoomError('not-joined', 'This session was resumed elsewhere.')
  }
  return { peer, room }
}

function issueGrant(ctx: HandlerContext, peer: Peer, room: Room): MediaGrant {
  if (!ctx.grants) {
    throw new RoomError('media-error', 'This server has no media backend configured.')
  }
  return ctx.grants.issue({ participantId: peer.id, label: peer.label, role: peer.role, room: room.name })
}

const join: Handler<'join'> = async (ctx, params) => {
  if (ctx.session.peer) throw new RoomError('already-joined', 'This connection already joined a room.')
  const room = ctx.rooms.getOrCreate(params.room)

  // Resume: reclaim the participant whose token matches, if still alive.
  if (params.resumeToken) {
    const existing = [...room.peers.values()].find(
      (candidate) => candidate.resumeToken === params.resumeToken && !candidate.isClosed,
    )
    if (existing) {
      if (existing.isConnected) {
        // The previous socket is still open: a duplicate tab, or a reconnect
        // that raced its own close. The newest wins and the old one is told.
        existing.send('closed', { code: 'replaced', message: 'This session was resumed elsewhere.' })
      }
      const resumeToken = newResumeToken()
      existing.attach(ctx.session.send, resumeToken)
      ctx.session.peer = existing
      ctx.session.room = room
      ctx.log('peer-resumed', { room: room.name, peerId: existing.id })
      return {
        participantId: existing.id,
        role: existing.role,
        room: room.name,
        resumeToken,
        resumed: true,
        participants: room.participants(),
        media: issueGrant(ctx, existing, room),
      }
    }
    // Token unknown or expired: fall through to a fresh join. The client
    // learns this from `resumed: false` and rebuilds its media from scratch.
  }

  const keyRole = ctx.keys.roleForKey(params.room, params.key)
  // The first studio to claim a room owns it, even when guests opened the
  // link first. After that, the director key is the only way to the role.
  const claimed = params.claim === true && keyRole === null && room.claim() ? 'director' : null
  const role: Role = keyRole ?? claimed ?? params.role ?? 'guest'
  if (claimed) ctx.log('room-claimed', { room: room.name })
  const peer = new Peer({
    id: randomUUID(),
    role,
    label: params.label.trim() || 'Guest',
    resumeToken: newResumeToken(),
    send: ctx.session.send,
  })
  // Signed before the peer is added, so a misconfigured backend refuses the
  // join instead of leaving a participant who can never have media.
  const media = issueGrant(ctx, peer, room)
  room.addPeer(peer)
  ctx.session.peer = peer
  ctx.session.room = room

  return {
    participantId: peer.id,
    role,
    room: room.name,
    resumeToken: peer.resumeToken,
    resumed: false,
    participants: room.participants().filter((participant) => participant.id !== peer.id),
    media,
  }
}

const getMediaGrant: Handler<'getMediaGrant'> = async (ctx) => {
  const { peer, room } = requireJoined(ctx)
  return issueGrant(ctx, peer, room)
}

const updateState: Handler<'updateState'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  if (params.micMuted !== undefined) peer.micMuted = params.micMuted
  if (params.cameraMuted !== undefined) peer.cameraMuted = params.cameraMuted
  if (params.sharing !== undefined) peer.sharing = params.sharing
  room.announcePeer(peer)
  return {}
}

const control: Handler<'control'> = async (ctx, params) => {
  const { peer: actor, room } = requireJoined(ctx)
  const target = room.getPeer(params.target)
  const action = params.command.action
  if (!canControl(actor, target, action)) {
    ctx.log('control-refused', { room: room.name, actor: actor.id, role: actor.role, target: target.id, action })
    throw new RoomError('forbidden', `A ${actor.role} may not "${action}" that participant.`)
  }
  switch (params.command.action) {
    case 'on-air':
      target.onAir = params.command.onAir
      room.announcePeer(target)
      break
    case 'label':
      target.label = params.command.label.trim() || target.label
      room.announcePeer(target)
      break
    case 'kick':
      target.send('closed', { code: 'kicked', message: 'You were removed from the room.' })
      room.removePeer(target.id)
      ctx.rooms.reapIfEmpty(room.name)
      return {}
    default:
      break
  }
  target.send('control', { from: actor.id, command: params.command })
  return {}
}

const getRoomKeys: Handler<'getRoomKeys'> = async (ctx) => {
  const { peer, room } = requireJoined(ctx)
  if (!hasCapability(peer.role, 'read-room-keys')) {
    throw new RoomError('forbidden', 'Only the director can read room keys.')
  }
  return ctx.keys.keysFor(room.name)
}

const leave: Handler<'leave'> = async (ctx) => {
  const { peer, room } = requireJoined(ctx)
  room.removePeer(peer.id)
  ctx.rooms.reapIfEmpty(room.name)
  ctx.session.peer = null
  ctx.session.room = null
  return {}
}

const ping: Handler<'ping'> = async (_ctx, params) => ({ at: params.at })

const HANDLERS: { [M in RequestMethod]: Handler<M> } = {
  join,
  getMediaGrant,
  updateState,
  control,
  getRoomKeys,
  leave,
  ping,
}

export async function dispatch(ctx: HandlerContext, request: ParsedRequest): Promise<unknown> {
  const handler = HANDLERS[request.method] as Handler<typeof request.method>
  return handler(ctx, request.params as never)
}

/** The socket went away: keep the participant for a grace period. */
export function onSessionClosed(ctx: HandlerContext, options: { intentional?: boolean } = {}): void {
  const { peer, room } = ctx.session
  ctx.session.peer = null
  ctx.session.room = null
  if (!peer || !room) return
  // Another socket already owns this participant: nothing to detach.
  if (!peer.isAttachedTo(ctx.session.send)) return
  if (options.intentional) {
    room.removePeer(peer.id)
    ctx.rooms.reapIfEmpty(room.name)
    return
  }
  peer.detach(() => {
    if (room.isClosed || peer.isClosed) return
    room.removePeer(peer.id)
    ctx.rooms.reapIfEmpty(room.name)
    ctx.log('peer-expired', { room: room.name, peerId: peer.id })
  }, ctx.resumeGraceMs ?? RESUME_GRACE_MS)
}
