import { randomUUID } from 'node:crypto'
import type { types } from 'mediasoup'
import { canControl, canProduce, hasCapability } from '../../../shared/authorization'
import type {
  ParsedRequest,
  RequestMethod,
  RequestParams,
  ResponseResult,
  Role,
} from '../../../shared/protocol'
import { Peer, type PeerSend } from '../mediasoup/peer'
import { Room, RoomError } from '../mediasoup/room'
import type { RoomManager } from '../rooms/room-manager'
import { DEFAULT_STUN_SERVERS, type TurnProvider } from '../turn/credentials'
import { newResumeToken, type KeyService } from './authorization'

/**
 * One function per request method.
 *
 * Every handler receives the session that sent the request. Identity comes
 * from there, never from the payload: a request names a target participant or
 * a producer id, and the handler resolves authority from `session.peer.role`
 * against the shared capability table.
 */

/** How long a dropped participant's media survives waiting for a resume. */
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
  turn: TurnProvider | null
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

async function issueIceServers(ctx: HandlerContext) {
  if (!ctx.turn) return DEFAULT_STUN_SERVERS
  try {
    const grant = await ctx.turn.issue()
    return [...grant.iceServers, ...DEFAULT_STUN_SERVERS]
  } catch (error) {
    // A lost relay is a weaker connection; a thrown error would abort a join
    // that may never have needed one. Log it and go STUN-only.
    ctx.log('turn-issue-failed', { message: error instanceof Error ? error.message : String(error) })
    return DEFAULT_STUN_SERVERS
  }
}

const join: Handler<'join'> = async (ctx, params) => {
  if (ctx.session.peer) throw new RoomError('already-joined', 'This connection already joined a room.')
  const room = await ctx.rooms.getOrCreate(params.room)

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
        producers: room.producers(),
        iceServers: await issueIceServers(ctx),
        routerRtpCapabilities: room.rtpCapabilities as unknown as Record<string, unknown>,
      }
    }
    // Token unknown or expired: fall through to a fresh join. The client
    // learns this from `resumed: false` and rebuilds its media from scratch.
  }

  const keyRole = ctx.keys.roleForKey(params.room, params.key)
  const role: Role = keyRole ?? params.role ?? 'guest'
  const peer = new Peer({
    id: randomUUID(),
    role,
    label: params.label.trim() || 'Guest',
    resumeToken: newResumeToken(),
    send: ctx.session.send,
  })
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
    producers: room.producers(),
    iceServers: await issueIceServers(ctx),
    routerRtpCapabilities: room.rtpCapabilities as unknown as Record<string, unknown>,
  }
}

const getRouterRtpCapabilities: Handler<'getRouterRtpCapabilities'> = async (ctx) => {
  const { room } = requireJoined(ctx)
  return { rtpCapabilities: room.rtpCapabilities as unknown as Record<string, unknown> }
}

const createWebRtcTransport: Handler<'createWebRtcTransport'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  if (params.direction === 'send' && !hasCapability(peer.role, 'produce')) {
    throw new RoomError('forbidden', 'This role cannot publish media.')
  }
  // One live transport per direction: a retry after a timeout replaces the
  // half-built one rather than leaking it.
  for (const transport of peer.transports.values()) {
    if (transport.appData.direction === params.direction) {
      transport.close()
      peer.transports.delete(transport.id)
    }
  }
  return room.createTransport(peer, params.direction)
}

const connectWebRtcTransport: Handler<'connectWebRtcTransport'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  await room.connectTransport(peer, params.transportId, params.dtlsParameters)
  return {}
}

const restartIce: Handler<'restartIce'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  const iceParameters = await room.restartIce(peer, params.transportId)
  return { iceParameters: iceParameters as unknown as Record<string, unknown> }
}

const produce: Handler<'produce'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  if (!canProduce(peer.role, params.source)) {
    throw new RoomError('forbidden', `This role cannot publish "${params.source}".`)
  }
  const producerId = await room.produce(peer, {
    transportId: params.transportId,
    kind: params.kind as types.MediaKind,
    rtpParameters: params.rtpParameters,
    source: params.source,
  })
  if (params.source === 'screen' && !peer.sharing) {
    peer.sharing = true
    room.announcePeer(peer)
  }
  return { producerId }
}

const consume: Handler<'consume'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  if (!hasCapability(peer.role, 'consume')) throw new RoomError('forbidden', 'This role cannot receive media.')
  return room.consume(peer, params)
}

const resumeConsumer: Handler<'resumeConsumer'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  await room.resumeConsumer(peer, params.consumerId)
  return {}
}

const pauseConsumer: Handler<'pauseConsumer'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  await room.pauseConsumer(peer, params.consumerId)
  return {}
}

const closeConsumer: Handler<'closeConsumer'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  room.closeConsumer(peer, params.consumerId)
  return {}
}

const pauseProducer: Handler<'pauseProducer'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  await room.pauseProducer(peer, params.producerId)
  return {}
}

const resumeProducer: Handler<'resumeProducer'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  await room.resumeProducer(peer, params.producerId)
  return {}
}

const closeProducer: Handler<'closeProducer'> = async (ctx, params) => {
  const { peer, room } = requireJoined(ctx)
  const entry = peer.producers.get(params.producerId)
  room.closeProducer(peer, params.producerId)
  if (entry?.source === 'screen' && peer.sharing) {
    peer.sharing = false
    room.announcePeer(peer)
  }
  return {}
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
  getRouterRtpCapabilities,
  createWebRtcTransport,
  connectWebRtcTransport,
  restartIce,
  produce,
  consume,
  resumeConsumer,
  pauseConsumer,
  closeConsumer,
  pauseProducer,
  resumeProducer,
  closeProducer,
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
export function onSessionClosed(ctx: HandlerContext): void {
  const { peer, room } = ctx.session
  ctx.session.peer = null
  ctx.session.room = null
  if (!peer || !room) return
  // Another socket already owns this participant: nothing to detach.
  if (!peer.isAttachedTo(ctx.session.send)) return
  peer.detach(() => {
    if (room.isClosed || peer.isClosed) return
    room.removePeer(peer.id)
    ctx.rooms.reapIfEmpty(room.name)
    ctx.log('peer-expired', { room: room.name, peerId: peer.id })
  }, ctx.resumeGraceMs ?? RESUME_GRACE_MS)
}
