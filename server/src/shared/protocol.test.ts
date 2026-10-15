import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  notification,
  okResponse,
  errorResponse,
  parseRequest,
  parseResponseResult,
  parseServerMessage,
  requestEnvelope,
} from '../../../shared/protocol'

describe('parseRequest', () => {
  it('accepts a well-formed join', () => {
    const raw = JSON.stringify(requestEnvelope(1, 'join', { room: 'studio-1', label: 'Ada' }))
    const result = parseRequest(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.method).toBe('join')
    expect(result.request.id).toBe(1)
  })

  it('rejects non-JSON', () => {
    const result = parseRequest('not json')
    expect(result).toMatchObject({ ok: false, code: 'bad-message', id: null })
  })

  it('rejects an oversized frame before parsing it', () => {
    const result = parseRequest('x'.repeat(MAX_MESSAGE_BYTES + 1))
    expect(result).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('reports a protocol version mismatch with the request id', () => {
    const raw = JSON.stringify({ v: 1, kind: 'request', id: 7, method: 'join', params: {} })
    expect(parseRequest(raw)).toMatchObject({ ok: false, code: 'protocol-version', id: 7 })
  })

  it('rejects unknown methods', () => {
    const raw = JSON.stringify({ v: PROTOCOL_VERSION, kind: 'request', id: 2, method: 'becomeDirector', params: {} })
    expect(parseRequest(raw)).toMatchObject({ ok: false, code: 'unknown-method', id: 2 })
  })

  it('has no field through which a client can claim a role above guest', () => {
    const raw = JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'request',
      id: 3,
      method: 'join',
      params: { room: 'studio', label: 'x', role: 'director' },
    })
    expect(parseRequest(raw)).toMatchObject({ ok: false, code: 'bad-message', id: 3 })
  })

  it('rejects a room name outside the charset', () => {
    const raw = JSON.stringify(requestEnvelope(4, 'join', { room: 'Bad Room!', label: 'x' }))
    expect(parseRequest(raw)).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('rejects control commands with unknown actions or bad payloads', () => {
    const bad = JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'request',
      id: 5,
      method: 'control',
      params: { target: 'abc', command: { action: 'explode' } },
    })
    expect(parseRequest(bad)).toMatchObject({ ok: false, code: 'bad-message' })
    const wrongType = JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'request',
      id: 6,
      method: 'control',
      params: { target: 'abc', command: { action: 'mute-mic', muted: 'yes' } },
    })
    expect(parseRequest(wrongType)).toMatchObject({ ok: false, code: 'bad-message' })
  })

  it('bounds cue text', () => {
    const raw = JSON.stringify(
      requestEnvelope(8, 'control', {
        target: 'abc',
        command: { action: 'cue', text: 'x'.repeat(281) },
      }),
    )
    expect(parseRequest(raw)).toMatchObject({ ok: false, code: 'bad-message' })
  })
})

describe('parseServerMessage', () => {
  it('round-trips responses and notifications', () => {
    expect(parseServerMessage(JSON.stringify(okResponse(1, { at: 5 })))).toEqual({
      kind: 'response',
      id: 1,
      ok: true,
      result: { at: 5 },
    })
    expect(parseServerMessage(JSON.stringify(errorResponse(2, 'forbidden', 'no')))).toEqual({
      kind: 'response',
      id: 2,
      ok: false,
      error: { code: 'forbidden', message: 'no' },
    })
    const parsed = parseServerMessage(
      JSON.stringify(notification('participantLeft', { participantId: 'p1' })),
    )
    expect(parsed).toEqual({ kind: 'notification', event: 'participantLeft', data: { participantId: 'p1' } })
  })

  it('rejects notifications with unknown events or malformed data', () => {
    expect(
      parseServerMessage(JSON.stringify({ v: 2, kind: 'notification', event: 'nope', data: {} })),
    ).toBeNull()
    expect(
      parseServerMessage(
        JSON.stringify({ v: 2, kind: 'notification', event: 'participantLeft', data: {} }),
      ),
    ).toBeNull()
  })

  it('validates response results per method', () => {
    expect(parseResponseResult('ping', { at: 1 })).toEqual({ at: 1 })
    expect(parseResponseResult('ping', { nope: 1 })).toBeNull()
    expect(parseResponseResult('produce', { producerId: 'x' })).toEqual({ producerId: 'x' })
  })
})
