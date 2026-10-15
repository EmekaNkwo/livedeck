import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTrackedUrl,
  downloadBlob,
  getTrackedUrl,
  revokeAllTrackedUrls,
  revokeTrackedUrl,
  toSafeFilename,
  trackedUrlCount,
} from './object-urls'

let counter = 0
beforeEach(() => {
  counter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:fake/${++counter}`),
    revokeObjectURL: vi.fn(),
  })
  revokeAllTrackedUrls()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('tracked object URLs', () => {
  it('reuses a key by revoking the previous URL first', () => {
    const first = createTrackedUrl('preview', new Blob(['a']))
    const second = createTrackedUrl('preview', new Blob(['b']))
    expect(first).not.toBe(second)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first)
    expect(getTrackedUrl('preview')).toBe(second)
    expect(trackedUrlCount()).toBe(1)
  })

  it('revokes one or all', () => {
    createTrackedUrl('a', new Blob())
    createTrackedUrl('b', new Blob())
    revokeTrackedUrl('a')
    revokeTrackedUrl('missing')
    expect(trackedUrlCount()).toBe(1)
    revokeAllTrackedUrls()
    expect(trackedUrlCount()).toBe(0)
    expect(getTrackedUrl('b')).toBeNull()
  })

  it('downloads through a hidden anchor and revokes later', () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadBlob(new Blob(['x']), 'take-1.webm')
    expect(click).toHaveBeenCalled()
    expect(document.querySelector('a[download]')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake/1')
  })

  it('sanitizes filenames', () => {
    expect(toSafeFilename('Show #3: "Live" / 2026', 'webm')).toBe('Show-3-Live-2026.webm')
    expect(toSafeFilename('   ', 'mp4')).toBe('livedeck-recording.mp4')
    expect(toSafeFilename('x'.repeat(100), 'webm')).toHaveLength(60 + 5)
  })
})
