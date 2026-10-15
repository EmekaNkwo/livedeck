/// <reference types="node" />
import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom's Blob cannot be structured-cloned by Node; the store itself only
// needs the standard Blob contract, which Node's implementation provides.
vi.stubGlobal('Blob', NodeBlob)
import type { RecordingEntry } from '@/types/recording'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import {
  QuotaExceededError,
  appendChunk,
  beginRecording,
  deleteAllRecordings,
  deleteChunks,
  deleteRecording,
  describeChunks,
  finishRecording,
  listRecordings,
  listUnfinishedRecordings,
  loadChunk,
  loadRecordingBlob,
  markInterrupted,
  putScratchChunk,
  replaceChunks,
  resetRecordingStore,
  setRecordingFormat,
} from './recording-store'

const entry = (id: string): RecordingEntry => ({
  id,
  sessionId: 's',
  name: id,
  mimeType: 'video/webm',
  extension: 'webm',
  size: 0,
  durationMs: 0,
  width: 1280,
  height: 720,
  frameRate: 30,
  createdAt: 1000,
  persisted: false,
})

beforeEach(async () => {
  resetRecordingStore()
  resetCapabilitiesCache()
  // Dexie binds to the IndexedDB implementation at import time, so the
  // database is shared across tests and emptied instead of replaced.
  await deleteAllRecordings()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('chunked recording store', () => {
  it('appends chunks in order and assembles them into one blob', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['abc']), 1001)
    await appendChunk('r1', 1, new Blob(['def']), 1002)
    await appendChunk('r1', 2, new Blob(['g']), 1003)
    expect(await describeChunks('r1')).toEqual({ count: 3, bytes: 7, firstAt: 1001, lastAt: 1003 })
    const blob = await loadRecordingBlob('r1')
    expect(await blob?.text()).toBe('abcdefg')
    expect(blob?.type).toBe('video/webm')
  })

  it('lists only finished recordings, and unfinished ones separately', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['x']), 1001)
    expect(await listRecordings()).toEqual([])
    expect((await listUnfinishedRecordings()).map((r) => r.id)).toEqual(['r1'])

    await finishRecording('r1', { durationMs: 5000, size: 1 })
    const listed = await listRecordings()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: 'r1', durationMs: 5000, size: 1, persisted: true })
    expect(await listUnfinishedRecordings()).toEqual([])
  })

  it('marks an interrupted recording and keeps its chunks', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['x']), 1001)
    await markInterrupted('r1')
    const unfinished = await listUnfinishedRecordings()
    expect(unfinished[0]?.status).toBe('interrupted')
    expect(unfinished[0]?.lastChunkIndex).toBe(0)
    expect(await loadRecordingBlob('r1')).not.toBeNull()
  })

  it('replaces a chunk when written again at the same index', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['old']), 1001)
    await appendChunk('r1', 1, new Blob(['tail']), 1002)
    await appendChunk('r1', 0, new Blob(['NEW-HEADER']), 1003)
    expect(await (await loadChunk('r1', 0))?.text()).toBe('NEW-HEADER')
    expect(await (await loadRecordingBlob('r1'))?.text()).toBe('NEW-HEADERtail')
  })

  it('deletes a recording with all its chunks', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['x']), 1001)
    await deleteRecording('r1')
    expect(await describeChunks('r1')).toMatchObject({ count: 0 })
    expect(await listUnfinishedRecordings()).toEqual([])
  })

  it('reports quota exhaustion as a typed error', async () => {
    await beginRecording(entry('r1'), 1000)
    const store = await import('./recording-store')
    const quotaError = Object.assign(new Error('QuotaExceededError: full'), { name: 'QuotaExceededError' })
    vi.spyOn(store, 'appendChunk').mockRejectedValueOnce(new QuotaExceededError('full'))
    await expect(store.appendChunk('r1', 0, new Blob(['x']), 1)).rejects.toBeInstanceOf(QuotaExceededError)
    void quotaError
  })
})

describe('rewriting a recording through a scratch file', () => {
  it('swaps the scratch chunks in as the recording, and leaves no scratch behind', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['cap']), 1001)
    await appendChunk('r1', 1, new Blob(['tured']), 1002)
    await appendChunk('r1', 2, new Blob(['!']), 1003)
    await putScratchChunk('r1~final', 0, new Blob(['FINAL-']))
    await putScratchChunk('r1~final', 1, new Blob(['FILE']))

    await replaceChunks('r1', 'r1~final')

    expect(await (await loadRecordingBlob('r1'))?.text()).toBe('FINAL-FILE')
    expect(await describeChunks('r1')).toMatchObject({ count: 2, bytes: 10 })
    expect(await describeChunks('r1~final')).toMatchObject({ count: 0 })
    // Scratch chunks never appear as library rows.
    expect((await listUnfinishedRecordings()).map((row) => row.id)).toEqual(['r1'])
  })

  it('keeps the captured chunks when the scratch file is empty', async () => {
    await beginRecording(entry('r1'), 1000)
    await appendChunk('r1', 0, new Blob(['captured']), 1001)
    await expect(replaceChunks('r1', 'r1~final')).rejects.toThrow(/empty/)
    expect(await (await loadRecordingBlob('r1'))?.text()).toBe('captured')
  })

  it('deletes chunks under an id without touching any row', async () => {
    await beginRecording(entry('r1'), 1000)
    await putScratchChunk('r1~final', 0, new Blob(['partial']))
    await deleteChunks('r1~final')
    expect(await describeChunks('r1~final')).toMatchObject({ count: 0 })
    expect(await listUnfinishedRecordings()).toHaveLength(1)
  })

  it('records the format capture chose', async () => {
    await beginRecording(entry('r1'), 1000)
    await setRecordingFormat('r1', 'video/mp4;codecs=avc1,mp4a.40.2', 'mp4')
    const [row] = await listUnfinishedRecordings()
    expect(row).toMatchObject({ mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4', status: 'recording' })
  })
})
