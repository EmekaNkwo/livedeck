import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  deleteRecording: vi.fn(),
  describeChunks: vi.fn(),
  finishRecording: vi.fn(),
  listUnfinishedRecordings: vi.fn(),
}))
vi.mock('@/services/persistence/recording-store', () => store)
const finalize = vi.hoisted(() => ({ finalizeRecording: vi.fn() }))
vi.mock('./finalize', () => finalize)

import { recoverInterruptedRecordings } from './recovery'

const row = (id: string, name = id) => ({ id, name, mimeType: 'video/mp4', startedAt: 10_000 })

beforeEach(() => {
  vi.clearAllMocks()
  store.deleteRecording.mockResolvedValue(undefined)
  store.finishRecording.mockResolvedValue(undefined)
})

describe('recoverInterruptedRecordings', () => {
  it('finalizes an interrupted recording and marks it recovered', async () => {
    store.listUnfinishedRecordings.mockResolvedValue([row('r1', 'Show')])
    store.describeChunks.mockResolvedValue({ count: 5, bytes: 500, firstAt: 11_000, lastAt: 14_000 })
    finalize.finalizeRecording.mockResolvedValue({
      mimeType: 'video/mp4',
      extension: 'mp4',
      durationMs: 4200,
      size: 480,
      remuxed: true,
      warning: null,
    })

    expect(await recoverInterruptedRecordings()).toEqual({ recovered: 1, failed: [] })
    // The chunk timestamps give the fallback estimate: last chunk + one slice.
    expect(finalize.finalizeRecording).toHaveBeenCalledWith({ id: 'r1', mimeType: 'video/mp4', durationMs: 5000, bytes: 500 })
    expect(store.finishRecording).toHaveBeenCalledWith('r1', {
      durationMs: 4200,
      size: 480,
      mimeType: 'video/mp4',
      extension: 'mp4',
      name: 'Show (recovered)',
    })
  })

  it('drops a row with no chunks', async () => {
    store.listUnfinishedRecordings.mockResolvedValue([row('empty')])
    store.describeChunks.mockResolvedValue({ count: 0, bytes: 0, firstAt: null, lastAt: null })
    expect(await recoverInterruptedRecordings()).toEqual({ recovered: 0, failed: [] })
    expect(store.deleteRecording).toHaveBeenCalledWith('empty')
  })

  it('reports a recording it could not recover and keeps going', async () => {
    store.listUnfinishedRecordings.mockResolvedValue([row('bad', 'Broken (recovered)'), row('good')])
    store.describeChunks.mockResolvedValue({ count: 1, bytes: 10, firstAt: 10_000, lastAt: 10_000 })
    finalize.finalizeRecording
      .mockRejectedValueOnce(new Error('disk read failed'))
      .mockResolvedValueOnce({ mimeType: 'video/webm', extension: 'webm', durationMs: 1000, size: 10, remuxed: false, warning: 'kept' })

    const report = await recoverInterruptedRecordings()

    expect(report).toEqual({ recovered: 1, failed: [{ id: 'bad', name: 'Broken (recovered)', reason: 'disk read failed' }] })
    expect(store.deleteRecording).not.toHaveBeenCalled()
  })

  it('lets a storage failure reach the caller', async () => {
    store.listUnfinishedRecordings.mockRejectedValue(new Error('IndexedDB is unavailable in this browser.'))
    await expect(recoverInterruptedRecordings()).rejects.toThrow(/unavailable/)
  })
})
