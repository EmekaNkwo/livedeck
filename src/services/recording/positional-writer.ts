/**
 * A file written by position, stored as a run of chunks.
 *
 * Muxers write mostly by appending, but a standard MP4 or a seekable WebM
 * also goes back and patches its header when it finalizes (the size of the
 * media box, the duration, the location of the index). Recordings live in
 * IndexedDB as numbered chunks, never as one buffer in memory, so this maps
 * each positional write onto those chunks: an append becomes a new chunk, a
 * patch rewrites the chunk or chunks it lands in.
 *
 * Only the chunk layout (start and length of each) is held in memory.
 */

export type ChunkIO = {
  write: (index: number, blob: Blob) => Promise<void>
  read: (index: number) => Promise<Blob | null>
}

type Span = { start: number; length: number }

export type PositionalWrite = { data: Uint8Array; position: number }

export class PositionalChunkWriter {
  private readonly io: ChunkIO
  private readonly spans: Span[] = []
  private end = 0

  constructor(io: ChunkIO) {
    this.io = io
  }

  /** Total bytes in the file. */
  get bytes(): number {
    return this.end
  }

  get chunkCount(): number {
    return this.spans.length
  }

  async write(data: Uint8Array, position: number): Promise<void> {
    if (!Number.isInteger(position) || position < 0) {
      throw new Error(`Invalid write position ${position}.`)
    }
    if (position > this.end) {
      // Muxers never leave holes; a gap means a write was lost.
      throw new Error(`Write at ${position} would leave a gap; the file ends at ${this.end}.`)
    }
    let offset = 0
    // Overwrite whatever part of the write lands on existing bytes.
    while (offset < data.length && position + offset < this.end) {
      const at = position + offset
      const index = this.spanAt(at)
      const span = this.spans[index] as Span
      const stored = await this.io.read(index)
      if (!stored) throw new Error(`Chunk ${index} is missing; cannot patch the file.`)
      const bytes = new Uint8Array(await stored.arrayBuffer())
      const within = at - span.start
      const take = Math.min(data.length - offset, span.length - within)
      bytes.set(data.subarray(offset, offset + take), within)
      await this.io.write(index, new Blob([toBuffer(bytes)]))
      offset += take
    }
    // Anything past the current end is an append.
    if (offset < data.length) {
      const rest = data.slice(offset)
      this.spans.push({ start: this.end, length: rest.length })
      await this.io.write(this.spans.length - 1, new Blob([toBuffer(rest)]))
      this.end += rest.length
    }
  }

  /** A `WritableStream` view for muxers that write `{ data, position }` chunks. */
  stream(): WritableStream<PositionalWrite> {
    return new WritableStream<PositionalWrite>({
      write: (chunk) => this.write(chunk.data, chunk.position),
    })
  }

  /** Index of the span containing byte `at`. Spans are contiguous and sorted. */
  private spanAt(at: number): number {
    let low = 0
    let high = this.spans.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const span = this.spans[middle] as Span
      if (at < span.start) high = middle - 1
      else if (at >= span.start + span.length) low = middle + 1
      else return middle
    }
    throw new Error(`No chunk holds byte ${at}.`)
  }
}

function toBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}
