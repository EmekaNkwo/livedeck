import { z } from 'zod'

/**
 * The signaling protocol between the studio and the SFU server.
 *
 * One definition, consumed by both halves, so the two cannot drift. Every
 * inbound message is validated on both ends: the server does not trust
 * browsers, and browsers do not trust the server.
 *
 * SHAPE
 * -----
 * Three message kinds travel over one WebSocket:
 *
 *   request       client → server, carries an `id` the response echoes
 *   response      server → client, `ok` with a result or an error
 *   notification  server → client, unsolicited room events
 *
 * Every media operation is a request. Room events (someone joined, a producer
 * appeared) are notifications. The client never has to guess what a server
 * message is answering.
 *
 * IDENTITY
 * --------
 * The server assigns every participant id. Nothing on the wire from a client
 * carries its own id or role: the server knows which socket sent a message
 * and derives both from the session. A client claiming "I am the director"
 * has no field to put that claim in. Roles are earned by presenting a room
 * key on join, and the keys are issued by the server.
 */

export const PROTOCOL_VERSION = 2

/** Largest frame accepted, in bytes. Enforced by the WebSocket server too. */
export const MAX_MESSAGE_BYTES = 256 * 1024
export const MAX_ROOM_LENGTH = 40
export const MAX_LABEL_LENGTH = 60
export const MAX_CUE_LENGTH = 280
/** Server-issued ids: UUIDs and mediasoup ids, never longer than this. */
const MAX_ID_LENGTH = 64
const MAX_KEY_LENGTH = 128

/* ------------------------------------------------------------------- roles */

export const ROLES = ['director', 'producer', 'guest', 'viewer'] as const
export type Role = (typeof ROLES)[number]
export const RoleSchema = z.enum(ROLES)

/** What a client may ask to be on join without a key. */
export const RequestableRoleSchema = z.enum(['guest', 'viewer'])

/* --------------------------------------------------------------- primitives */

/** Rooms appear in URLs and in server logs, so the charset is restricted. */
export const RoomNameSchema = z
  .string()
  .min(1)
  .max(MAX_ROOM_LENGTH)
  .regex(/^[a-z0-9-]+$/, 'Room names are lower-case letters, digits and dashes.')

export function isValidRoom(value: unknown): value is string {
  return RoomNameSchema.safeParse(value).success
}

const IdSchema = z.string().min(1).max(MAX_ID_LENGTH)
const LabelSchema = z.string().max(MAX_LABEL_LENGTH)

/**
 * mediasoup parameter blobs.
 *
 * These are validated structurally for being objects of a bounded size, not
 * field by field: mediasoup itself validates them exhaustively and throws, and
 * duplicating its schema here would drift from the version installed. The
 * frame-size limit bounds the cost of a hostile blob before it reaches
 * mediasoup.
 */
const OpaqueParamsSchema = z.record(z.string(), z.unknown())

export const MediaSourceSchema = z.enum([
  'mic',
  'camera',
  'screen',
  'screen-audio',
  'program',
  'program-audio',
])
export type MediaSource = z.infer<typeof MediaSourceSchema>

export const MediaKindSchema = z.enum(['audio', 'video'])
export type MediaKind = z.infer<typeof MediaKindSchema>

export const TransportDirectionSchema = z.enum(['send', 'recv'])
export type TransportDirection = z.infer<typeof TransportDirectionSchema>

/* -------------------------------------------------------------- participant */

export const ParticipantSchema = z.object({
  id: IdSchema,
  role: RoleSchema,
  label: LabelSchema,
  micMuted: z.boolean(),
  cameraMuted: z.boolean(),
  sharing: z.boolean(),
  /** Set by the director; the guest sees an on-air tally. */
  onAir: z.boolean(),
  joinedAt: z.number(),
})
export type Participant = z.infer<typeof ParticipantSchema>

export const ProducerInfoSchema = z.object({
  id: IdSchema,
  participantId: IdSchema,
  kind: MediaKindSchema,
  source: MediaSourceSchema,
  paused: z.boolean(),
})
export type ProducerInfo = z.infer<typeof ProducerInfoSchema>

export const IceServerSchema = z.object({
  urls: z.array(z.string().max(512)).min(1),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
})
export type IceServer = z.infer<typeof IceServerSchema>

/* -------------------------------------------------------- control messages */

/**
 * Director → participant commands.
 *
 * Carried through the server so it can authorize them. The target is named
 * by the caller; the sender is whoever owns the socket. The server checks the
 * sender's role against the capability table before forwarding.
 */
export const ControlActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mute-mic'), muted: z.boolean() }),
  z.object({ action: z.literal('mute-camera'), muted: z.boolean() }),
  z.object({ action: z.literal('cue'), text: z.string().max(MAX_CUE_LENGTH) }),
  z.object({ action: z.literal('on-air'), onAir: z.boolean() }),
  z.object({ action: z.literal('label'), label: LabelSchema }),
  z.object({ action: z.literal('kick') }),
])
export type ControlAction = z.infer<typeof ControlActionSchema>
export type ControlActionName = ControlAction['action']

/* ------------------------------------------------------------- requests */

export const RequestSchemas = {
  join: z.object({
    room: RoomNameSchema,
    label: LabelSchema,
    /** A room key issued by the server. Determines role; absent means guest. */
    key: z.string().max(MAX_KEY_LENGTH).optional(),
    /** Without a key, a client may ask for a lesser role than guest. */
    role: RequestableRoleSchema.optional(),
    /**
     * Claim an empty room as its director.
     *
     * There are no accounts, so the first studio to open a room that nobody
     * is in becomes its director and is handed the room keys. Once a room has
     * participants, only a key grants the role.
     */
    claim: z.boolean().optional(),
    /**
     * Resume a previous session after a dropped socket. The server reclaims
     * the same participant and its transports if they are still alive.
     */
    resumeToken: z.string().max(MAX_KEY_LENGTH).optional(),
  }),
  getRouterRtpCapabilities: z.object({}),
  createWebRtcTransport: z.object({
    direction: TransportDirectionSchema,
  }),
  connectWebRtcTransport: z.object({
    transportId: IdSchema,
    dtlsParameters: OpaqueParamsSchema,
  }),
  restartIce: z.object({ transportId: IdSchema }),
  produce: z.object({
    transportId: IdSchema,
    kind: MediaKindSchema,
    rtpParameters: OpaqueParamsSchema,
    source: MediaSourceSchema,
  }),
  consume: z.object({
    producerId: IdSchema,
    rtpCapabilities: OpaqueParamsSchema,
  }),
  resumeConsumer: z.object({ consumerId: IdSchema }),
  pauseConsumer: z.object({ consumerId: IdSchema }),
  closeConsumer: z.object({ consumerId: IdSchema }),
  pauseProducer: z.object({ producerId: IdSchema }),
  resumeProducer: z.object({ producerId: IdSchema }),
  closeProducer: z.object({ producerId: IdSchema }),
  /** Report own track state; broadcast to the room. */
  updateState: z.object({
    micMuted: z.boolean().optional(),
    cameraMuted: z.boolean().optional(),
    sharing: z.boolean().optional(),
  }),
  control: z.object({
    target: IdSchema,
    command: ControlActionSchema,
  }),
  /** Director only: the keys that grant producer and director roles. */
  getRoomKeys: z.object({}),
  leave: z.object({}),
  ping: z.object({ at: z.number() }),
} as const

export type RequestMethod = keyof typeof RequestSchemas
export const REQUEST_METHODS = Object.keys(RequestSchemas) as RequestMethod[]

export type RequestParams<M extends RequestMethod> = z.infer<(typeof RequestSchemas)[M]>

/* ------------------------------------------------------------- responses */

export const ResponseSchemas = {
  join: z.object({
    participantId: IdSchema,
    role: RoleSchema,
    room: RoomNameSchema,
    resumeToken: z.string().max(MAX_KEY_LENGTH),
    /** True when a previous session was reclaimed and transports survived. */
    resumed: z.boolean(),
    participants: z.array(ParticipantSchema),
    producers: z.array(ProducerInfoSchema),
    /** Short-lived, issued for this session only. */
    iceServers: z.array(IceServerSchema),
    routerRtpCapabilities: OpaqueParamsSchema,
  }),
  getRouterRtpCapabilities: z.object({ rtpCapabilities: OpaqueParamsSchema }),
  createWebRtcTransport: z.object({
    id: IdSchema,
    iceParameters: OpaqueParamsSchema,
    iceCandidates: z.array(OpaqueParamsSchema),
    dtlsParameters: OpaqueParamsSchema,
    sctpParameters: OpaqueParamsSchema.optional(),
  }),
  connectWebRtcTransport: z.object({}),
  restartIce: z.object({ iceParameters: OpaqueParamsSchema }),
  produce: z.object({ producerId: IdSchema }),
  consume: z.object({
    consumerId: IdSchema,
    producerId: IdSchema,
    participantId: IdSchema,
    kind: MediaKindSchema,
    source: MediaSourceSchema,
    rtpParameters: OpaqueParamsSchema,
    producerPaused: z.boolean(),
  }),
  resumeConsumer: z.object({}),
  pauseConsumer: z.object({}),
  closeConsumer: z.object({}),
  pauseProducer: z.object({}),
  resumeProducer: z.object({}),
  closeProducer: z.object({}),
  updateState: z.object({}),
  control: z.object({}),
  getRoomKeys: z.object({
    directorKey: z.string().max(MAX_KEY_LENGTH),
    producerKey: z.string().max(MAX_KEY_LENGTH),
  }),
  leave: z.object({}),
  ping: z.object({ at: z.number() }),
} as const satisfies Record<RequestMethod, z.ZodType>

export type ResponseResult<M extends RequestMethod> = z.infer<(typeof ResponseSchemas)[M]>

/* --------------------------------------------------------- notifications */

export const NotificationSchemas = {
  participantJoined: z.object({ participant: ParticipantSchema }),
  participantLeft: z.object({ participantId: IdSchema }),
  participantUpdated: z.object({ participant: ParticipantSchema }),
  newProducer: z.object({ producer: ProducerInfoSchema }),
  producerPaused: z.object({ producerId: IdSchema }),
  producerResumed: z.object({ producerId: IdSchema }),
  producerClosed: z.object({ producerId: IdSchema, participantId: IdSchema }),
  consumerClosed: z.object({ consumerId: IdSchema }),
  consumerPaused: z.object({ consumerId: IdSchema }),
  consumerResumed: z.object({ consumerId: IdSchema }),
  /** A control command addressed to this participant, already authorized. */
  control: z.object({ from: IdSchema, command: ControlActionSchema }),
  /** The server is closing this session; `code` says why. */
  closed: z.object({
    code: z.enum(['kicked', 'room-closed', 'replaced', 'server-shutdown']),
    message: z.string().max(400),
  }),
} as const

export type NotificationEvent = keyof typeof NotificationSchemas
export type NotificationData<E extends NotificationEvent> = z.infer<
  (typeof NotificationSchemas)[E]
>

/* -------------------------------------------------------------- envelopes */

export const ERROR_CODES = [
  'bad-message',
  'unknown-method',
  'not-joined',
  'already-joined',
  'room-full',
  'server-full',
  'forbidden',
  'unknown-participant',
  'unknown-transport',
  'unknown-producer',
  'unknown-consumer',
  'rate-limited',
  'protocol-version',
  'media-error',
  'timeout',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
export const ErrorCodeSchema = z.enum(ERROR_CODES)

export const RequestEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('request'),
  id: z.number().int().nonnegative(),
  method: z.string().max(64),
  params: z.unknown(),
})
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>

export const ResponseEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('response'),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({ code: ErrorCodeSchema, message: z.string().max(400) })
    .optional(),
})
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>

export const NotificationEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('notification'),
  event: z.string().max(64),
  data: z.unknown(),
})
export type NotificationEnvelope = z.infer<typeof NotificationEnvelopeSchema>

export const ServerEnvelopeSchema = z.discriminatedUnion('kind', [
  ResponseEnvelopeSchema,
  NotificationEnvelopeSchema,
])
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>

/* -------------------------------------------------------------- parsing */

export type ParsedRequest = {
  [M in RequestMethod]: { id: number; method: M; params: RequestParams<M> }
}[RequestMethod]

export type ParseFailure = { ok: false; code: ErrorCode; message: string; id: number | null }
export type ParseRequestResult = { ok: true; request: ParsedRequest } | ParseFailure

/**
 * Parse an inbound client frame.
 *
 * Returns the request id with every failure where one could be read, so the
 * server can answer the specific request rather than leaving it hanging.
 */
export function parseRequest(raw: string): ParseRequestResult {
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: 'bad-message', message: 'Message too large.', id: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'bad-message', message: 'Message is not JSON.', id: null }
  }
  const envelope = RequestEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    const id =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { id?: unknown }).id === 'number'
        ? (parsed as { id: number }).id
        : null
    const version = (parsed as { v?: unknown } | null)?.v
    if (version !== undefined && version !== PROTOCOL_VERSION) {
      return { ok: false, code: 'protocol-version', message: 'Unsupported protocol version.', id }
    }
    return { ok: false, code: 'bad-message', message: 'Malformed request envelope.', id }
  }
  const { id, method } = envelope.data
  if (!(method in RequestSchemas)) {
    return { ok: false, code: 'unknown-method', message: `Unknown method "${method}".`, id }
  }
  const schema = RequestSchemas[method as RequestMethod]
  const params = schema.safeParse(envelope.data.params)
  if (!params.success) {
    return {
      ok: false,
      code: 'bad-message',
      message: `Invalid parameters for "${method}": ${params.error.issues[0]?.message ?? 'invalid'}.`,
      id,
    }
  }
  return { ok: true, request: { id, method, params: params.data } as ParsedRequest }
}

export type ParsedServerMessage =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: { code: ErrorCode; message: string } }
  | {
      [E in NotificationEvent]: { kind: 'notification'; event: E; data: NotificationData<E> }
    }[NotificationEvent]

/** Parse an inbound server frame. Browsers do not trust the server either. */
export function parseServerMessage(raw: string): ParsedServerMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const envelope = ServerEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) return null
  const message = envelope.data
  if (message.kind === 'response') {
    if (message.ok) return { kind: 'response', id: message.id, ok: true, result: message.result }
    if (!message.error) return null
    return { kind: 'response', id: message.id, ok: false, error: message.error }
  }
  if (!(message.event in NotificationSchemas)) return null
  const event = message.event as NotificationEvent
  const data = NotificationSchemas[event].safeParse(message.data)
  if (!data.success) return null
  return { kind: 'notification', event, data: data.data } as ParsedServerMessage
}

/** Validate a response result against the method's schema. */
export function parseResponseResult<M extends RequestMethod>(
  method: M,
  result: unknown,
): ResponseResult<M> | null {
  const parsed = ResponseSchemas[method].safeParse(result)
  return parsed.success ? (parsed.data as ResponseResult<M>) : null
}

/* ------------------------------------------------------------- builders */

export function requestEnvelope<M extends RequestMethod>(
  id: number,
  method: M,
  params: RequestParams<M>,
): RequestEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'request', id, method, params }
}

export function okResponse(id: number, result: unknown): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'response', id, ok: true, result }
}

export function errorResponse(id: number, code: ErrorCode, message: string): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'response', id, ok: false, error: { code, message } }
}

export function notification<E extends NotificationEvent>(
  event: E,
  data: NotificationData<E>,
): NotificationEnvelope {
  return { v: PROTOCOL_VERSION, kind: 'notification', event, data }
}

/** Human-readable text for an error code, for the UI. */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  'bad-message': 'The server rejected a message as malformed.',
  'unknown-method': 'The server does not understand that request.',
  'not-joined': 'Join a room first.',
  'already-joined': 'This connection has already joined a room.',
  'room-full': 'This room has reached its participant limit.',
  'server-full': 'The server is at capacity. Try again shortly.',
  forbidden: 'You are not allowed to do that.',
  'unknown-participant': 'That participant is no longer in the room.',
  'unknown-transport': 'That transport no longer exists.',
  'unknown-producer': 'That media stream no longer exists.',
  'unknown-consumer': 'That media stream no longer exists.',
  'rate-limited': 'Too many requests. Slow down and retry.',
  'protocol-version':
    'This build speaks a different signaling protocol than the server. Reload to pick up the current version.',
  'media-error': 'The media server could not complete that operation.',
  timeout: 'The server did not answer in time.',
  internal: 'The server hit an unexpected error.',
}
