/**
 * The wire protocol shared by the signaling server and the browser adapter.
 *
 * This file is deliberately dependency-free so the Next.js server can import it
 * verbatim. One definition of the messages means the two halves cannot drift —
 * a signaling mismatch is miserable to debug, because it surfaces as "the
 * connection just doesn't work".
 *
 * Every message is validated on **both** ends. The server does not trust
 * browsers, and browsers do not trust the server.
 */
export const PROTOCOL_VERSION = 1;
/** Maximum SDP size accepted, as a crude abuse guard. 256 KB is generous. */
export const MAX_SDP_BYTES = 256 * 1024;
export const MAX_ROOM_LENGTH = 40;
export const MAX_LABEL_LENGTH = 60;
/* ----------------------------------------------------------------- validation */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value, max) {
    if (typeof value !== 'string')
        return null;
    return value.length > max ? value.slice(0, max) : value;
}
/** Rooms appear in URLs and in server logs, so the charset is restricted. */
export function isValidRoom(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_ROOM_LENGTH &&
        /^[a-z0-9-]+$/.test(value));
}
function parseCandidate(value) {
    if (!isObject(value))
        return null;
    if (typeof value.candidate !== 'string')
        return null;
    // An SDP fragment should never be enormous; a huge one is either a bug or
    // an attempt to use the relay as free storage.
    if (value.candidate.length > 4096)
        return null;
    return {
        candidate: value.candidate,
        sdpMid: typeof value.sdpMid === 'string' ? value.sdpMid : null,
        sdpMLineIndex: typeof value.sdpMLineIndex === 'number' && Number.isInteger(value.sdpMLineIndex)
            ? value.sdpMLineIndex
            : null,
        usernameFragment: typeof value.usernameFragment === 'string' ? value.usernameFragment : null,
    };
}
/**
 * Parse an inbound client message.
 *
 * Returns null for anything malformed. The server replies with `bad-message`
 * rather than guessing, because a silently-dropped signaling message produces
 * a connection that hangs with no explanation.
 */
export function parseClientMessage(raw) {
    if (raw.length > MAX_SDP_BYTES)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isObject(parsed))
        return null;
    if (parsed.v !== PROTOCOL_VERSION || typeof parsed.type !== 'string')
        return null;
    switch (parsed.type) {
        case 'join': {
            if (!isValidRoom(parsed.room))
                return null;
            if (parsed.role !== 'director' && parsed.role !== 'guest')
                return null;
            const label = str(parsed.label, MAX_LABEL_LENGTH);
            return {
                v: 1,
                type: 'join',
                room: parsed.room,
                role: parsed.role,
                label: label ?? 'Peer',
            };
        }
        case 'offer':
        case 'answer': {
            const to = str(parsed.to, 64);
            if (!to)
                return null;
            if (typeof parsed.sdp !== 'string' || !parsed.sdp.includes('v=0'))
                return null;
            if (parsed.sdp.length > MAX_SDP_BYTES)
                return null;
            return { v: 1, type: parsed.type, to, sdp: parsed.sdp };
        }
        case 'candidate': {
            const to = str(parsed.to, 64);
            if (!to)
                return null;
            const candidate = parseCandidate(parsed.candidate);
            if (!candidate)
                return null;
            return { v: 1, type: 'candidate', to, candidate };
        }
        case 'leave':
            return { v: 1, type: 'leave' };
        case 'ping':
            return typeof parsed.at === 'number' ? { v: 1, type: 'ping', at: parsed.at } : null;
        default:
            return null;
    }
}
/** Parse an inbound server message. Browsers do not trust the server either. */
export function parseServerMessage(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isObject(parsed))
        return null;
    if (parsed.v !== PROTOCOL_VERSION || typeof parsed.type !== 'string')
        return null;
    const peer = (value) => {
        if (!isObject(value))
            return null;
        const peerId = str(value.peerId, 64);
        if (!peerId)
            return null;
        if (value.role !== 'director' && value.role !== 'guest')
            return null;
        return { peerId, role: value.role, label: str(value.label, MAX_LABEL_LENGTH) ?? 'Peer' };
    };
    switch (parsed.type) {
        case 'joined': {
            const peerId = str(parsed.peerId, 64);
            if (!peerId || !isValidRoom(parsed.room))
                return null;
            const peers = Array.isArray(parsed.peers)
                ? parsed.peers.map(peer).filter((entry) => entry !== null)
                : [];
            return { v: 1, type: 'joined', peerId, room: parsed.room, peers };
        }
        case 'peer-joined': {
            const entry = peer(parsed.peer);
            return entry ? { v: 1, type: 'peer-joined', peer: entry } : null;
        }
        case 'peer-left': {
            const peerId = str(parsed.peerId, 64);
            return peerId ? { v: 1, type: 'peer-left', peerId } : null;
        }
        case 'offer':
        case 'answer': {
            const from = str(parsed.from, 64);
            if (!from)
                return null;
            if (typeof parsed.sdp !== 'string' || !parsed.sdp.includes('v=0'))
                return null;
            return { v: 1, type: parsed.type, from, sdp: parsed.sdp };
        }
        case 'candidate': {
            const from = str(parsed.from, 64);
            const candidate = parseCandidate(parsed.candidate);
            return from && candidate ? { v: 1, type: 'candidate', from, candidate } : null;
        }
        case 'error': {
            const message = str(parsed.message, 400);
            const codes = [
                'bad-message',
                'not-joined',
                'room-full',
                'unknown-peer',
                'rate-limited',
                'protocol-version',
            ];
            const code = codes.find((candidate) => candidate === parsed.code);
            return code
                ? { v: 1, type: 'error', code, message: message ?? code, fatal: parsed.fatal === true }
                : null;
        }
        case 'pong':
            return typeof parsed.at === 'number' ? { v: 1, type: 'pong', at: parsed.at } : null;
        default:
            return null;
    }
}
/**
 * Convert a browser candidate into a wire payload.
 *
 * Takes a structural type rather than `RTCIceCandidate` so this module stays
 * free of DOM lib types — the server compiles it too, and pulling `lib.dom`
 * into a Node build to describe one argument would be the wrong trade.
 */
export function toCandidatePayload(candidate) {
    return {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        usernameFragment: candidate.usernameFragment ?? null,
    };
}
/** Human-readable text for a server error code. */
export const SERVER_ERROR_TEXT = {
    'bad-message': 'The signaling server rejected a message as malformed.',
    'not-joined': 'A signaling message was sent before joining a room.',
    'room-full': 'This room has reached its participant limit.',
    'unknown-peer': 'That participant is no longer in the room.',
    'rate-limited': 'Too many signaling messages were sent. Slow down and retry.',
    'protocol-version': 'This build speaks a different signaling protocol than the server. Reload to pick up the current version.',
};
