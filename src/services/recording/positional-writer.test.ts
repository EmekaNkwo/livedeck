import { describe, expect, it } from 'vitest'
import { PositionalChunkWriter, type ChunkIO } from './positional-writer'

function memoryIO(): ChunkIO & { chunks: Map<number, Blob>; writes: number } {
  const chunks = new Map<number, Blob>()
  const io = {
    chunks,
    writes: 0,
    write: async (index: number, blob: Blob) => {
      io.writes += 1
      chunks.set(index, blob)
    },
    read: async (index: number) => chunks.get(index) ?? null,
  }
  return io
}

async function assemble(io: ReturnType<typeof memoryIO>): Promise<string> {
  const ordered = [...io.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, blob]) => blob)
  return new Blob(ordered).text()
}

const bytes = (text: string) => new TextEncoder().encode(text)

describe('PositionalChunkWriter', () => {
  it('turns appends into one chunk each', async () => {
    const io = memoryIO()
    const writer = new PositionalChunkWriter(io)
    await writer.write(bytes('abc'), 0)
    await writer.write(bytes('defg'), 3)
    expect(writer.bytes).toBe(7)
    expect(writer.chunkCount).toBe(2)
    expect(await assemble(io)).toBe('abcdefg')
  })

  it('patches bytes inside an existing chunk', async () => {
    const io = memoryIO()
    const writer = new PositionalChunkWriter(io)
    await writer.write(bytes('header....'), 0)
    await writer.write(bytes('payload'), 10)
    await writer.write(bytes('HEAD'), 0)
    expect(await assemble(io)).toBe('HEADer....payload')
    expect(writer.chunkCount).toBe(2)
  })

  it('patches across a chunk boundary and appends any overhang', async () => {
    const io = memoryIO()
    const writer = new PositionalChunkWriter(io)
    await writer.write(bytes('aaaa'), 0)
    await writer.write(bytes('bbbb'), 4)
    await writer.write(bytes('XXXXXXX'), 2)
    expect(await assemble(io)).toBe('aaXXXXXXX')
    expect(writer.bytes).toBe(9)
    expect(writer.chunkCount).toBe(3)
  })

  it('refuses a write that would leave a gap or has a bad position', async () => {
    const writer = new PositionalChunkWriter(memoryIO())
    await writer.write(bytes('ab'), 0)
    await expect(writer.write(bytes('z'), 5)).rejects.toThrow(/gap/)
    await expect(writer.write(bytes('z'), -1)).rejects.toThrow(/Invalid/)
  })

  it('fails loudly if a chunk it must patch has gone missing', async () => {
    const io = memoryIO()
    const writer = new PositionalChunkWriter(io)
    await writer.write(bytes('abcd'), 0)
    io.chunks.delete(0)
    await expect(writer.write(bytes('Z'), 1)).rejects.toThrow(/missing/)
  })

  it('exposes a WritableStream for muxers', async () => {
    const io = memoryIO()
    const writer = new PositionalChunkWriter(io)
    const stream = writer.stream().getWriter()
    await stream.write({ data: bytes('hello '), position: 0 })
    await stream.write({ data: bytes('world'), position: 6 })
    await stream.write({ data: bytes('H'), position: 0 })
    await stream.close()
    expect(await assemble(io)).toBe('Hello world')
  })
})
