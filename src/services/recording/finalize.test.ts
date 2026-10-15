import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaDescription } from './remux'

/**
 * The finalize step's decisions: which container, when to trust the
 * rewrite, and what to keep when it fails. The rewrite itself runs on real
 * encoders in `e2e/recording-files.spec.ts`; here the store and the muxer
 * are doubles so each branch can be forced.
 */

const store = vi.hoisted(() => ({
  chunks: new Map<string, Blob>(),
  appendChunk: vi.fn(),
  deleteChunks: vi.fn(),
  loadChunk: vi.fn(),
  loadRecordingBlob: vi.fn(),
  putScratchChunk: vi.fn(),
  replaceChunks: vi.fn(),
}))
vi.mock('@/services/persistence/recording-store', () => store)

const media = vi.hoisted(() => ({
  remux: vi.fn(),
  describeMedia: vi.fn(),
}))
vi.mock('./remux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remux')>()
  return { ...actual, remux: media.remux, describeMedia: media.describeMedia }
})

const patch = vi.hoisted(() => ({ patchWebmDuration: vi.fn() }))
vi.mock('./webm-duration', () => patch)

import { finalizeRecording, scratchIdFor } from './finalize'

const describe_ = (overrides: Partial<MediaDescription>): MediaDescription => ({
  mimeType: 'video/webm',
  durationMs: 4000,
  headerDurationMs: null,
  videoCodec: 'vp9',
  audioCodec: 'opus',
  ...overrides,
})

const captured = new Blob(['captured-bytes'])
const rewritten = new Blob(['rewritten'])

beforeEach(() => {
  vi.clearAllMocks()
  store.deleteChunks.mockResolvedValue(undefined)
  store.putScratchChunk.mockResolvedValue(undefined)
  store.replaceChunks.mockResolvedValue(undefined)
  store.appendChunk.mockResolvedValue(undefined)
  store.loadChunk.mockResolvedValue(new Blob(['captured']))
  store.loadRecordingBlob.mockImplementation(async (id: string) => (id.endsWith('~final') ? rewritten : captured))
  media.remux.mockImplementation(async (_source: Blob, _container: string, sink: WritableStream) => {
    const writer = sink.getWriter()
    await writer.write({ data: new TextEncoder().encode('rewritten'), position: 0 })
    await writer.close()
    return { durationMs: 4012, discarded: [] }
  })
})

const input = { id: 'r1', mimeType: 'video/webm;codecs=vp9,opus', durationMs: 3900, bytes: 14 }

describe('finalizeRecording', () => {
  it('rewrites a WebM capture into WebM and swaps it in', async () => {
    media.describeMedia.mockResolvedValueOnce(describe_({})).mockResolvedValueOnce(describe_({ headerDurationMs: 4012 }))
    const result = await finalizeRecording(input)

    expect(media.remux.mock.calls[0]?.[1]).toBe('webm')
    expect(store.deleteChunks).toHaveBeenCalledWith(scratchIdFor('r1'))
    expect(store.putScratchChunk).toHaveBeenCalledWith('r1~final', 0, expect.any(Blob))
    expect(store.replaceChunks).toHaveBeenCalledWith('r1', 'r1~final')
    expect(result).toEqual({
      mimeType: 'video/webm',
      extension: 'webm',
      durationMs: 4012,
      size: 9,
      remuxed: true,
      warning: null,
    })
  })

  it('chooses the container from the bytes, not the row', async () => {
    // The row says WebM, but capture wrote MP4.
    media.describeMedia
      .mockResolvedValueOnce(describe_({ mimeType: 'video/mp4; codecs="avc1.42c01f, mp4a.40.2"', videoCodec: 'avc', audioCodec: 'aac' }))
      .mockResolvedValueOnce(describe_({ mimeType: 'video/mp4', videoCodec: 'avc', audioCodec: 'aac' }))
    const result = await finalizeRecording(input)
    expect(media.remux.mock.calls[0]?.[1]).toBe('mp4')
    expect(result).toMatchObject({ mimeType: 'video/mp4', extension: 'mp4', remuxed: true })
  })

  it('keeps the capture, with its duration patched, when the rewrite loses a track', async () => {
    media.describeMedia.mockResolvedValueOnce(describe_({})).mockResolvedValueOnce(describe_({ audioCodec: null }))
    patch.patchWebmDuration.mockResolvedValue({ patched: true, blob: new Blob(['HEADER-captured-bytes']) })

    const result = await finalizeRecording(input)

    expect(store.replaceChunks).not.toHaveBeenCalled()
    expect(store.deleteChunks).toHaveBeenLastCalledWith('r1~final')
    expect(patch.patchWebmDuration).toHaveBeenCalledWith(captured, 3900)
    // The new header plus the rest of the original first chunk.
    const rewrittenHead = store.appendChunk.mock.calls[0]?.[2] as Blob
    expect(await rewrittenHead.text()).toBe('HEADER-captured')
    expect(result).toMatchObject({ remuxed: false, durationMs: 3900, size: 21, extension: 'webm' })
    expect(result.warning).toMatch(/audio track was lost/)
  })

  it('keeps the capture when the muxer throws, and says why', async () => {
    media.describeMedia.mockResolvedValue(describe_({ mimeType: 'video/mp4', videoCodec: 'avc' }))
    media.remux.mockRejectedValue(new Error('unsupported codec'))
    const result = await finalizeRecording({ ...input, mimeType: 'video/mp4' })
    expect(patch.patchWebmDuration).not.toHaveBeenCalled()
    expect(result).toMatchObject({ remuxed: false, mimeType: 'video/mp4', size: 14, durationMs: 3900 })
    expect(result.warning).toMatch(/unsupported codec/)
  })

  it('rejects a rewrite with no duration', async () => {
    media.describeMedia.mockResolvedValueOnce(describe_({})).mockResolvedValueOnce(describe_({ durationMs: 0 }))
    patch.patchWebmDuration.mockResolvedValue({ patched: false, blob: captured })
    const result = await finalizeRecording(input)
    expect(result.remuxed).toBe(false)
    expect(result.warning).toMatch(/no duration/)
  })

  it('reports tracks the muxer had to leave out', async () => {
    media.describeMedia.mockResolvedValue(describe_({}))
    media.remux.mockImplementation(async (_source: Blob, _container: string, sink: WritableStream) => {
      const writer = sink.getWriter()
      await writer.write({ data: new Uint8Array([1]), position: 0 })
      return { durationMs: 0, discarded: ['subtitle: unsupported'] }
    })
    const result = await finalizeRecording(input)
    expect(result).toMatchObject({ remuxed: true, durationMs: 3900 })
    expect(result.warning).toMatch(/subtitle: unsupported/)
  })

  it('fails when nothing was stored', async () => {
    store.loadRecordingBlob.mockResolvedValue(null)
    await expect(finalizeRecording(input)).rejects.toThrow(/no stored data/)
  })
})
