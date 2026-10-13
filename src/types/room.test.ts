import { describe, expect, it } from 'vitest'
import { normalizeRoomName, parseChannelMessage } from './room'

/**
 * The control protocol and room naming.
 *
 * Data-channel payloads are remote input from a peer that could send anything,
 * so validation here is the boundary that protects local state and — more
 * importantly — `MediaStreamTrack.enabled`. A malformed message must be
 * dropped, never partially applied.
 */

describe('normalizeRoomName', () => {
  it('lowercases and slugifies', () => {
    expect(normalizeRoomName('Sunday Service')).toBe('sunday-service')
    expect(normalizeRoomName('Episode #14!')).toBe('episode-14')
  })

  it('collapses and trims separators', () => {
    expect(normalizeRoomName('a   b')).toBe('a-b')
    expect(normalizeRoomName('--a--b--')).toBe('a-b')
    expect(normalizeRoomName('  room  ')).toBe('room')
  })

  it('bounds the length so a room name stays usable in a URL', () => {
    expect(normalizeRoomName('x'.repeat(200)).length).toBe(40)
  })

  it('returns an empty string for input with nothing usable', () => {
    expect(normalizeRoomName('')).toBe('')
    expect(normalizeRoomName('!!!')).toBe('')
    expect(normalizeRoomName('   ')).toBe('')
  })

  it('preserves an already-valid name unchanged', () => {
    expect(normalizeRoomName('sunday-service-2')).toBe('sunday-service-2')
  })
})

describe('parseChannelMessage', () => {
  const parse = (value: unknown) => parseChannelMessage(JSON.stringify(value))

  it('accepts a well-formed mute command', () => {
    expect(parse({ v: 1, type: 'mute-mic', muted: true })).toEqual({
      v: 1,
      type: 'mute-mic',
      muted: true,
    })
    expect(parse({ v: 1, type: 'mute-camera', muted: false })).toEqual({
      v: 1,
      type: 'mute-camera',
      muted: false,
    })
  })

  it('rejects a mute command with a non-boolean payload', () => {
    // `muted: "true"` would be truthy — coercing it would let a peer flip a
    // track with a value it never meant as a boolean.
    expect(parse({ v: 1, type: 'mute-mic', muted: 'true' })).toBeNull()
    expect(parse({ v: 1, type: 'mute-mic', muted: 1 })).toBeNull()
    expect(parse({ v: 1, type: 'mute-mic' })).toBeNull()
  })

  it('accepts and bounds a cue', () => {
    expect(parse({ v: 1, type: 'cue', text: 'go in 30' })).toEqual({
      v: 1,
      type: 'cue',
      text: 'go in 30',
    })
    const long = parse({ v: 1, type: 'cue', text: 'x'.repeat(5000) })
    // Bounded so a hostile peer cannot push an unbounded string into the DOM.
    expect(long).not.toBeNull()
    expect((long as { text: string }).text.length).toBe(280)
  })

  it('accepts and bounds a label', () => {
    const labelled = parse({ v: 1, type: 'label', label: 'y'.repeat(500) })
    expect((labelled as { label: string }).label.length).toBe(60)
  })

  it('accepts on-air, ping and pong', () => {
    expect(parse({ v: 1, type: 'on-air', onAir: true })).toEqual({
      v: 1,
      type: 'on-air',
      onAir: true,
    })
    expect(parse({ v: 1, type: 'ping', at: 1234 })).toEqual({ v: 1, type: 'ping', at: 1234 })
    expect(parse({ v: 1, type: 'pong', at: 1234 })).toEqual({ v: 1, type: 'pong', at: 1234 })
  })

  it('accepts a guest hello and state report', () => {
    expect(parse({ v: 1, type: 'hello', label: 'Ana', hasVideo: true, hasAudio: false })).toEqual({
      v: 1,
      type: 'hello',
      label: 'Ana',
      hasVideo: true,
      hasAudio: false,
    })
    expect(parse({ v: 1, type: 'state', micMuted: true, cameraMuted: false })).toEqual({
      v: 1,
      type: 'state',
      micMuted: true,
      cameraMuted: false,
    })
  })

  it('rejects a state report with missing fields', () => {
    expect(parse({ v: 1, type: 'state', micMuted: true })).toBeNull()
    expect(parse({ v: 1, type: 'hello', label: 'Ana' })).toBeNull()
  })

  it('rejects an unknown message type', () => {
    expect(parse({ v: 1, type: 'reboot-their-computer' })).toBeNull()
  })

  it('rejects a mismatched protocol version', () => {
    expect(parse({ v: 2, type: 'mute-mic', muted: true })).toBeNull()
    expect(parse({ type: 'mute-mic', muted: true })).toBeNull()
  })

  it('rejects anything that is not an object', () => {
    expect(parse('hello')).toBeNull()
    expect(parse(42)).toBeNull()
    expect(parse(null)).toBeNull()
    expect(parse([{ v: 1, type: 'ping', at: 1 }])).toBeNull()
  })

  it('rejects malformed JSON rather than throwing', () => {
    expect(parseChannelMessage('not json at all')).toBeNull()
    expect(parseChannelMessage('')).toBeNull()
    expect(parseChannelMessage('{"v":1,')).toBeNull()
  })

  it('ignores extra properties instead of passing them through', () => {
    // A peer cannot smuggle fields into the object the app then acts on.
    const result = parse({ v: 1, type: 'ping', at: 5, evil: 'payload' })
    expect(result).toEqual({ v: 1, type: 'ping', at: 5 })
  })

  it('rejects a ping without a numeric timestamp', () => {
    expect(parse({ v: 1, type: 'ping', at: 'now' })).toBeNull()
  })
})
