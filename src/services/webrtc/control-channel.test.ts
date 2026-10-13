import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlChannelState, GuestMessage } from '@/types/room'
import { CONTROL_CHANNEL_LABEL, ControlChannel } from './control-channel'

/**
 * The director ↔ guest control channel.
 *
 * This is the path that makes a remote mute genuinely reach the guest, so the
 * things worth proving are: a command is only claimed delivered when the
 * channel is actually open, hostile payloads are dropped, and the heartbeat
 * timer never outlives the channel.
 */

/** A scriptable RTCDataChannel double. */
class FakeChannel {
  readyState: RTCDataChannelState = 'connecting'
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  readonly sent: string[] = []
  closed = false
  /** Set to make `send` throw, as a full buffer would. */
  failSend = false

  readonly label: string

  constructor(label = CONTROL_CHANNEL_LABEL) {
    this.label = label
  }

  send(data: string): void {
    if (this.failSend) throw new Error('buffer full')
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 'closed'
  }

  /* ---- test helpers ---- */

  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent)
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  parsedSent(): unknown[] {
    return this.sent.map((entry) => JSON.parse(entry))
  }
}

let channel: ControlChannel
let states: ControlChannelState[]

beforeEach(() => {
  channel = new ControlChannel('peer_1')
  states = []
  channel.setEvents({ onStateChange: (state) => states.push(state) })
})

describe('open and close', () => {
  it('starts closed', () => {
    expect(channel.isOpen()).toBe(false)
    expect(channel.getState().open).toBe(false)
  })

  it('reports open once the channel opens', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    expect(channel.isOpen()).toBe(false)

    fake.open()
    expect(channel.isOpen()).toBe(true)
    expect(states.at(-1)?.open).toBe(true)
  })

  it('handles a channel that is already open on attach', () => {
    // The answering side often receives a channel that has already opened, so
    // `onopen` never fires for it.
    const fake = new FakeChannel()
    fake.readyState = 'open'
    channel.attach(fake as unknown as RTCDataChannel)
    expect(channel.isOpen()).toBe(true)
  })

  it('reports closed and clears latency on close', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()
    fake.readyState = 'closed'
    fake.onclose?.()

    expect(states.at(-1)?.open).toBe(false)
    expect(states.at(-1)?.latencyMs).toBeNull()
  })

  it('treats an errored channel as unusable rather than live', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()
    fake.onerror?.()
    expect(states.at(-1)?.open).toBe(false)
  })
})

describe('send', () => {
  it('refuses to send before the channel is open', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)

    // Returning false is what lets the UI say the command did not land.
    expect(channel.send({ v: 1, type: 'mute-mic', muted: true })).toBe(false)
    expect(fake.sent).toHaveLength(0)
  })

  it('sends once open', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    expect(channel.send({ v: 1, type: 'mute-mic', muted: true })).toBe(true)
    expect(fake.parsedSent()).toContainEqual({ v: 1, type: 'mute-mic', muted: true })
  })

  it('reports failure when the underlying send throws', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()
    fake.failSend = true

    expect(channel.send({ v: 1, type: 'cue', text: 'hi' })).toBe(false)
  })

  it('refuses to send with no channel attached at all', () => {
    expect(channel.send({ v: 1, type: 'on-air', onAir: true })).toBe(false)
  })
})

describe('receiving', () => {
  it('answers a ping with the sender’s timestamp', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()
    fake.sent.length = 0

    fake.receive({ v: 1, type: 'ping', at: 4242 })

    // Echoing the sender's clock avoids needing synchronized clocks.
    expect(fake.parsedSent()).toContainEqual({ v: 1, type: 'pong', at: 4242 })
  })

  it('measures latency from a pong', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fake.receive({ v: 1, type: 'pong', at: 900 })
    now.mockRestore()

    expect(states.at(-1)?.latencyMs).toBe(100)
  })

  it('records a guest’s reported track state', () => {
    const fake = new FakeChannel()
    const guestMessages: GuestMessage[] = []
    channel.setEvents({
      onStateChange: (state) => states.push(state),
      onGuestMessage: (message) => guestMessages.push(message),
    })
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    fake.receive({ v: 1, type: 'state', micMuted: true, cameraMuted: false })

    // The director's UI reads these, so they must reflect the guest's report
    // rather than what the director last asked for.
    expect(states.at(-1)?.reportedMicMuted).toBe(true)
    expect(states.at(-1)?.reportedCameraMuted).toBe(false)
    expect(guestMessages).toHaveLength(1)
  })

  it('routes a director command to the control handler', () => {
    const fake = new FakeChannel()
    const commands: unknown[] = []
    channel.setEvents({ onControl: (message) => commands.push(message) })
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    fake.receive({ v: 1, type: 'mute-mic', muted: true })
    expect(commands).toEqual([{ v: 1, type: 'mute-mic', muted: true }])
  })

  it('drops a malformed payload without invoking any handler', () => {
    const fake = new FakeChannel()
    const commands: unknown[] = []
    channel.setEvents({ onControl: (message) => commands.push(message) })
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    // A peer can send anything; none of it may reach a MediaStreamTrack.
    fake.receiveRaw('not json')
    fake.receive({ v: 1, type: 'mute-mic', muted: 'yes' })
    fake.receive({ v: 99, type: 'mute-mic', muted: true })
    fake.receive({ v: 1, type: 'exec', cmd: 'rm -rf /' })

    expect(commands).toHaveLength(0)
  })

  it('ignores non-string data', () => {
    const fake = new FakeChannel()
    const commands: unknown[] = []
    channel.setEvents({ onControl: (message) => commands.push(message) })
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    fake.receiveRaw(new ArrayBuffer(8))
    expect(commands).toHaveLength(0)
  })
})

describe('heartbeat', () => {
  it('pings periodically while open, and stops on close', () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeChannel()
      channel.attach(fake as unknown as RTCDataChannel)
      fake.open()
      fake.sent.length = 0

      vi.advanceTimersByTime(11_000)
      const pings = fake.parsedSent().filter((m) => (m as { type: string }).type === 'ping')
      expect(pings.length).toBeGreaterThanOrEqual(2)

      // A closed channel must not keep a timer alive.
      fake.readyState = 'closed'
      fake.onclose?.()
      const afterClose = fake.sent.length
      vi.advanceTimersByTime(20_000)
      expect(fake.sent.length).toBe(afterClose)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the heartbeat on dispose', () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeChannel()
      channel.attach(fake as unknown as RTCDataChannel)
      fake.open()

      channel.dispose()
      const afterDispose = fake.sent.length
      vi.advanceTimersByTime(30_000)

      expect(fake.sent.length).toBe(afterDispose)
      expect(fake.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('teardown', () => {
  it('detaching closes the channel and clears its handlers', () => {
    const fake = new FakeChannel()
    channel.attach(fake as unknown as RTCDataChannel)
    fake.open()

    channel.detach()

    expect(fake.closed).toBe(true)
    expect(fake.onmessage).toBeNull()
    expect(fake.onopen).toBeNull()
  })

  it('attaching a second channel replaces the first', () => {
    const first = new FakeChannel()
    const second = new FakeChannel()
    channel.attach(first as unknown as RTCDataChannel)
    channel.attach(second as unknown as RTCDataChannel)

    expect(first.closed).toBe(true)
    second.open()
    expect(channel.isOpen()).toBe(true)
  })

  it('is safe to detach when nothing is attached', () => {
    expect(() => channel.detach()).not.toThrow()
  })
})
