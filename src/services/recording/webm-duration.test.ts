import { describe, expect, it } from 'vitest'
import { patchWebmDuration, readWebmDuration } from './webm-duration'

/**
 * A minimal WebM the way MediaRecorder writes it: an EBML header, then a
 * Segment of unknown size whose first child is an Info with a TimecodeScale
 * and no Duration, followed by a Cluster.
 */
function vintSize(value: number, length: number): number[] {
  const out: number[] = []
  let remaining = value
  for (let i = 0; i < length; i += 1) {
    out.unshift(remaining % 256)
    remaining = Math.floor(remaining / 256)
  }
  out[0] = (out[0] ?? 0) | (0x80 >> (length - 1))
  return out
}

function element(id: number[], payload: number[], sizeLength = 1): number[] {
  return [...id, ...vintSize(payload.length, sizeLength), ...payload]
}

function makeWebm(options: { withDuration?: boolean; knownSegmentSize?: boolean } = {}): Blob {
  const ebmlHeader = element([0x1a, 0x45, 0xdf, 0xa3], [...element([0x42, 0x86], [1]), ...element([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])])
  const timecodeScale = element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]) // 1_000_000
  const muxingApp = element([0x4d, 0x80], [0x4c, 0x44]) // "LD"
  const duration = options.withDuration ? [0x44, 0x89, 0x88, 0x40, 0x8f, 0x40, 0, 0, 0, 0, 0] : [] // 1000.0
  const info = element([0x15, 0x49, 0xa9, 0x66], [...timecodeScale, ...muxingApp, ...duration])
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], [...element([0xe7], [0]), 1, 2, 3, 4, 5, 6, 7, 8])
  const segmentPayload = [...info, ...cluster]
  const segment = options.knownSegmentSize
    ? [0x18, 0x53, 0x80, 0x67, ...vintSize(segmentPayload.length, 8), ...segmentPayload]
    : [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...segmentPayload]
  return new Blob([new Uint8Array([...ebmlHeader, ...segment])], { type: 'video/webm' })
}

describe('patchWebmDuration', () => {
  it('inserts a Duration into an Info that has none', async () => {
    const source = makeWebm()
    expect(await readWebmDuration(source)).toBeNull()
    const result = await patchWebmDuration(source, 7_250)
    expect(result.patched).toBe(true)
    expect(await readWebmDuration(result.blob)).toBeCloseTo(7_250, 3)
    // The body after Info is byte-identical.
    const original = new Uint8Array(await source.arrayBuffer())
    const patched = new Uint8Array(await result.blob.arrayBuffer())
    expect([...patched.slice(-12)]).toEqual([...original.slice(-12)])
  })

  it('replaces an existing Duration', async () => {
    const source = makeWebm({ withDuration: true })
    expect(await readWebmDuration(source)).toBe(1000)
    const result = await patchWebmDuration(source, 42_000)
    expect(result.patched).toBe(true)
    expect(await readWebmDuration(result.blob)).toBeCloseTo(42_000, 3)
  })

  it('grows a known Segment size by the inserted bytes', async () => {
    const source = makeWebm({ knownSegmentSize: true })
    const result = await patchWebmDuration(source, 3_000)
    expect(result.patched).toBe(true)
    expect(await readWebmDuration(result.blob)).toBeCloseTo(3_000, 3)
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    // Segment size (8-byte vint at offset after the 4-byte id) equals the remaining length.
    const ebmlLen = 4 + 1 + (bytes[4] ?? 0) - 0x80
    const sizeOffset = ebmlLen + 4
    let size = 0
    for (let i = 1; i < 8; i += 1) size = size * 256 + (bytes[sizeOffset + i] ?? 0)
    expect(size).toBe(bytes.length - sizeOffset - 8)
  })

  it('leaves unrecognised data alone and says why', async () => {
    const result = await patchWebmDuration(new Blob([new Uint8Array([1, 2, 3, 4])]), 1000)
    expect(result.patched).toBe(false)
    expect(result.reason).toBe('not EBML')
    const zero = await patchWebmDuration(makeWebm(), 0)
    expect(zero.patched).toBe(false)
  })
})
