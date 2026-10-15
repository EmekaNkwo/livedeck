import { beforeEach, describe, expect, it } from 'vitest'
import type { RecordingEntry, RecordingError, RecordingStatus } from '@/types/recording'
import {
  selectEntryCount,
  selectIsBusy,
  selectIsRecording,
  selectPreviewEntry,
  useRecordingStore,
} from './recordingStore'

const store = () => useRecordingStore.getState()

function entry(id: string, createdAt: number, name = id): RecordingEntry {
  return {
    id,
    sessionId: 'abc123',
    name,
    mimeType: 'video/webm',
    extension: 'webm',
    size: 1024,
    durationMs: 1000,
    width: 1280,
    height: 720,
    frameRate: 30,
    createdAt,
    persisted: true,
  }
}

const recorderError: RecordingError = {
  code: 'recorder-error',
  message: 'boom',
  recoverable: true,
  at: 1,
}

beforeEach(() => {
  useRecordingStore.setState({
    status: 'idle',
    elapsedMs: 0,
    format: null,
    error: null,
    entries: [],
    volatileBlobs: new Map(),
    previewId: null,
    libraryLoaded: false,
  })
})

describe('in-flight recording state', () => {
  it('sets status, elapsed time, format and error', () => {
    const format = { mimeType: 'video/mp4', extension: 'mp4', label: 'MP4 · H.264 + AAC' }
    store().setStatus('recording')
    store().setElapsed(4200)
    store().setFormat(format)
    store().setError(recorderError)
    expect(store()).toMatchObject({
      status: 'recording',
      elapsedMs: 4200,
      format,
      error: recorderError,
    })
  })

  it('reset clears in-flight state but keeps the library and format', () => {
    const format = { mimeType: 'video/webm', extension: 'webm', label: 'WebM' }
    store().setStatus('error')
    store().setElapsed(999)
    store().setError(recorderError)
    store().setFormat(format)
    store().addEntry(entry('rec_1', 1))
    store().setLibraryLoaded(true)

    store().reset()

    expect(store().status).toBe('idle')
    expect(store().elapsedMs).toBe(0)
    expect(store().error).toBeNull()
    expect(store().format).toEqual(format)
    expect(store().entries).toHaveLength(1)
    expect(store().libraryLoaded).toBe(true)
  })
})

describe('library', () => {
  it('setEntries sorts newest first without mutating the input', () => {
    const input = [entry('a', 1), entry('c', 3), entry('b', 2)]
    store().setEntries(input)
    expect(store().entries.map((e) => e.id)).toEqual(['c', 'b', 'a'])
    expect(input.map((e) => e.id)).toEqual(['a', 'c', 'b'])
  })

  it('addEntry prepends, replaces an entry with the same id, and keeps volatile blobs', () => {
    const blob = new Blob(['x'], { type: 'video/webm' })
    store().addEntry(entry('a', 1))
    store().addEntry(entry('b', 2), blob)
    store().addEntry(entry('a', 3, 'renamed'))

    expect(store().entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(store().entries[0]?.name).toBe('renamed')
    expect(store().volatileBlobs.get('b')).toBe(blob)
    expect(store().volatileBlobs.has('a')).toBe(false)
  })

  it('addEntry with a null blob stores nothing volatile and copies the map', () => {
    const before = store().volatileBlobs
    store().addEntry(entry('a', 1), null)
    expect(store().volatileBlobs.size).toBe(0)
    expect(store().volatileBlobs).not.toBe(before)
  })

  it('removeEntry drops the entry, its blob, and closes its preview', () => {
    store().addEntry(entry('a', 1), new Blob(['a']))
    store().addEntry(entry('b', 2))
    store().setPreview('a')
    store().removeEntry('a')
    expect(store().entries.map((e) => e.id)).toEqual(['b'])
    expect(store().volatileBlobs.has('a')).toBe(false)
    expect(store().previewId).toBeNull()
  })

  it('removeEntry keeps a preview of a different entry open', () => {
    store().addEntry(entry('a', 1))
    store().addEntry(entry('b', 2))
    store().setPreview('b')
    store().removeEntry('a')
    expect(store().previewId).toBe('b')
  })

  it('renameEntry trims, renames only the matching entry, and ignores blanks', () => {
    store().setEntries([entry('a', 1, 'A'), entry('b', 2, 'B')])
    store().renameEntry('a', '  Take 2  ')
    expect(store().entries.find((e) => e.id === 'a')?.name).toBe('Take 2')
    expect(store().entries.find((e) => e.id === 'b')?.name).toBe('B')

    const before = store()
    store().renameEntry('a', '   ')
    expect(store()).toBe(before)
  })

  it('tracks library loading', () => {
    store().setLibraryLoaded(true)
    expect(store().libraryLoaded).toBe(true)
  })
})

describe('selectors', () => {
  const recordingStatuses: Array<[RecordingStatus, boolean, boolean]> = [
    ['idle', false, false],
    ['starting', false, true],
    ['recording', true, false],
    ['paused', true, false],
    ['finalizing', false, true],
    ['complete', false, false],
    ['error', false, false],
  ]

  it.each(recordingStatuses)('%s → recording=%s busy=%s', (status, recording, busy) => {
    store().setStatus(status)
    expect(selectIsRecording(store())).toBe(recording)
    expect(selectIsBusy(store())).toBe(busy)
  })

  it('selectPreviewEntry resolves the open entry, or null', () => {
    store().setEntries([entry('a', 1)])
    expect(selectPreviewEntry(store())).toBeNull()
    store().setPreview('a')
    expect(selectPreviewEntry(store())?.id).toBe('a')
    store().setPreview('missing')
    expect(selectPreviewEntry(store())).toBeNull()
  })

  it('selectEntryCount counts entries', () => {
    expect(selectEntryCount(store())).toBe(0)
    store().setEntries([entry('a', 1), entry('b', 2)])
    expect(selectEntryCount(store())).toBe(2)
  })
})
