/**
 * Write the duration into a WebM produced by MediaRecorder.
 *
 * MediaRecorder streams the file as it goes, so it cannot know the duration
 * when it writes the header, and leaves the `Duration` element out (or sets
 * the Segment size to "unknown"). Players then show `Infinity` and cannot
 * seek. Editors such as Premiere and Resolve refuse the file outright.
 *
 * This rewrites only the `Info` element at the start of the file: it reads
 * the first few hundred kilobytes, inserts (or replaces) `Duration`, and
 * returns a Blob that is the patched header followed by the untouched rest.
 * The body is never read into memory, so this is cheap for a long file.
 *
 * Cues (an index for seeking) are not added; that needs a full re-mux, which
 * a WebCodecs path does properly. Duration alone fixes playback and makes
 * browsers scrub the file; editors import it.
 */

const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067
const ID_INFO = 0x1549a966
const ID_DURATION = 0x4489
const ID_TIMECODE_SCALE = 0x2ad7b1
/** How much of the file to read looking for Info. Headers are a few KB. */
const HEADER_SCAN_BYTES = 512 * 1024

type Element = { id: number; idSize: number; sizeSize: number; dataSize: number; dataStart: number; unknownSize: boolean }

function readVint(bytes: Uint8Array, offset: number): { value: number; length: number; allOnes: boolean } | null {
  const first = bytes[offset]
  if (first === undefined) return null
  let length = 1
  let mask = 0x80
  while (length <= 8 && (first & mask) === 0) {
    length += 1
    mask >>= 1
  }
  if (length > 8 || offset + length > bytes.length) return null
  let value = first & (mask - 1)
  let allOnes = value === mask - 1
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[offset + i] ?? 0
    value = value * 256 + byte
    if (byte !== 0xff) allOnes = false
  }
  return { value, length, allOnes }
}

function readId(bytes: Uint8Array, offset: number): { id: number; length: number } | null {
  const first = bytes[offset]
  if (first === undefined) return null
  let length = 1
  let mask = 0x80
  while (length <= 4 && (first & mask) === 0) {
    length += 1
    mask >>= 1
  }
  if (length > 4 || offset + length > bytes.length) return null
  let id = 0
  for (let i = 0; i < length; i += 1) id = id * 256 + (bytes[offset + i] ?? 0)
  return { id, length }
}

function readElement(bytes: Uint8Array, offset: number): Element | null {
  const id = readId(bytes, offset)
  if (!id) return null
  const size = readVint(bytes, offset + id.length)
  if (!size) return null
  return {
    id: id.id,
    idSize: id.length,
    sizeSize: size.length,
    dataSize: size.value,
    dataStart: offset + id.length + size.length,
    unknownSize: size.allOnes,
  }
}

/** Encode a size as an 8-byte vint so the Info size never has to grow again. */
function encodeSize8(value: number): Uint8Array {
  const out = new Uint8Array(8)
  out[0] = 0x01
  let remaining = value
  for (let i = 7; i >= 1; i -= 1) {
    out[i] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  return out
}

function encodeDuration(durationTicks: number): Uint8Array {
  // Duration is a float; 8 bytes (double) is always accepted.
  const out = new Uint8Array(2 + 1 + 8)
  out[0] = 0x44
  out[1] = 0x89
  out[2] = 0x88
  new DataView(out.buffer).setFloat64(3, durationTicks)
  return out
}

export type PatchResult = { blob: Blob; patched: boolean; reason?: string }

/**
 * Return a Blob whose header carries `durationMs`. When the structure is not
 * recognised the original is returned with `patched: false` and a reason.
 */
export async function patchWebmDuration(source: Blob, durationMs: number): Promise<PatchResult> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { blob: source, patched: false, reason: 'no duration' }
  const headBlob = source.slice(0, Math.min(source.size, HEADER_SCAN_BYTES))
  const head = new Uint8Array(await headBlob.arrayBuffer())

  const ebml = readElement(head, 0)
  if (!ebml || ebml.id !== ID_EBML) return { blob: source, patched: false, reason: 'not EBML' }
  const segment = readElement(head, ebml.dataStart + ebml.dataSize)
  if (!segment || segment.id !== ID_SEGMENT) return { blob: source, patched: false, reason: 'no Segment' }

  // Walk the Segment's children looking for Info.
  let offset = segment.dataStart
  let info: Element | null = null
  while (offset < head.length) {
    const element = readElement(head, offset)
    if (!element) break
    if (element.id === ID_INFO) {
      info = element
      break
    }
    if (element.unknownSize) break
    offset = element.dataStart + element.dataSize
  }
  if (!info || info.unknownSize || info.dataStart + info.dataSize > head.length) {
    return { blob: source, patched: false, reason: 'Info not found in header' }
  }

  // Rebuild Info's children: keep everything except an existing Duration.
  const children: Uint8Array[] = []
  let timecodeScale = 1_000_000
  let cursor = info.dataStart
  const infoEnd = info.dataStart + info.dataSize
  while (cursor < infoEnd) {
    const child = readElement(head, cursor)
    if (!child || child.unknownSize) return { blob: source, patched: false, reason: 'malformed Info' }
    const childEnd = child.dataStart + child.dataSize
    if (child.id === ID_TIMECODE_SCALE) {
      let scale = 0
      for (let i = child.dataStart; i < childEnd; i += 1) scale = scale * 256 + (head[i] ?? 0)
      if (scale > 0) timecodeScale = scale
    }
    if (child.id !== ID_DURATION) children.push(head.slice(cursor, childEnd))
    cursor = childEnd
  }
  const durationTicks = (durationMs * 1_000_000) / timecodeScale
  children.push(encodeDuration(durationTicks))

  const payloadSize = children.reduce((sum, part) => sum + part.length, 0)
  const infoHeader = head.slice(info.dataStart - info.sizeSize - info.idSize, info.dataStart - info.sizeSize)
  const newInfo = concat([infoHeader, encodeSize8(payloadSize), ...children])

  const infoStart = info.dataStart - info.sizeSize - info.idSize
  const before = head.slice(0, infoStart)

  // The Segment's own size, if known, must grow by the difference.
  const delta = newInfo.length - (infoEnd - infoStart)
  if (!segment.unknownSize) {
    const segmentSizeOffset = segment.dataStart - segment.sizeSize
    const resized = encodeSizeFixed(segment.dataSize + delta, segment.sizeSize)
    if (!resized) return { blob: source, patched: false, reason: 'Segment size would not fit' }
    before.set(resized, segmentSizeOffset)
  }

  const patched = new Blob([toBuffer(before), toBuffer(newInfo), source.slice(infoEnd)], { type: source.type })
  return { blob: patched, patched: true }
}

/** A standalone ArrayBuffer for a view, for Blob construction. */
function toBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

function encodeSizeFixed(value: number, length: number): Uint8Array | null {
  const max = 2 ** (7 * length) - 2
  if (value > max) return null
  const out = new Uint8Array(length)
  let remaining = value
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  out[0] = (out[0] ?? 0) | (0x80 >> (length - 1))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Read the Duration (ms) back out of a WebM header. Null when absent. */
export async function readWebmDuration(source: Blob): Promise<number | null> {
  const head = new Uint8Array(await source.slice(0, Math.min(source.size, HEADER_SCAN_BYTES)).arrayBuffer())
  const ebml = readElement(head, 0)
  if (!ebml || ebml.id !== ID_EBML) return null
  const segment = readElement(head, ebml.dataStart + ebml.dataSize)
  if (!segment || segment.id !== ID_SEGMENT) return null
  let offset = segment.dataStart
  while (offset < head.length) {
    const element = readElement(head, offset)
    if (!element) return null
    if (element.id === ID_INFO) {
      let scale = 1_000_000
      let duration: number | null = null
      let cursor = element.dataStart
      const end = element.dataStart + element.dataSize
      while (cursor < end) {
        const child = readElement(head, cursor)
        if (!child) return null
        const childEnd = child.dataStart + child.dataSize
        if (child.id === ID_TIMECODE_SCALE) {
          let value = 0
          for (let i = child.dataStart; i < childEnd; i += 1) value = value * 256 + (head[i] ?? 0)
          scale = value || scale
        }
        if (child.id === ID_DURATION) {
          const view = new DataView(head.buffer, head.byteOffset + child.dataStart, child.dataSize)
          duration = child.dataSize === 8 ? view.getFloat64(0) : view.getFloat32(0)
        }
        cursor = childEnd
      }
      return duration === null ? null : (duration * scale) / 1_000_000
    }
    if (element.unknownSize) return null
    offset = element.dataStart + element.dataSize
  }
  return null
}
