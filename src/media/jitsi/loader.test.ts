import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JitsiLoadError, loadJitsi, resetJitsiLoader } from './loader'
import type { JitsiMeetJS } from './lib-types'

const fakeApi = (): JitsiMeetJS =>
  ({ init: vi.fn(), setLogLevel: vi.fn(), logLevels: { ERROR: 'e' } }) as unknown as JitsiMeetJS

let appended: HTMLScriptElement[]

beforeEach(() => {
  resetJitsiLoader()
  delete window.JitsiMeetJS
  appended = []
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    appended.push(...(nodes as HTMLScriptElement[]))
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete window.JitsiMeetJS
})

const URL_ = 'https://8x8.vc/libs/lib-jitsi-meet.min.js'

describe('loadJitsi', () => {
  it('loads the library once from the grant’s deployment and initializes it quietly', async () => {
    const first = loadJitsi(URL_)
    expect(loadJitsi(URL_)).toBe(first)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.src).toBe(URL_)
    const api = fakeApi()
    window.JitsiMeetJS = api
    appended[0]?.onload?.(new Event('load'))
    await expect(first).resolves.toBe(api)
    expect(api.init).toHaveBeenCalledWith({})
    expect(api.setLogLevel).toHaveBeenCalledWith('e')
  })

  it('uses a library already on the page', async () => {
    const api = fakeApi()
    window.JitsiMeetJS = api
    await expect(loadJitsi(URL_)).resolves.toBe(api)
    expect(appended).toHaveLength(0)
  })

  it('refuses plain HTTP', async () => {
    await expect(loadJitsi('http://8x8.vc/libs/lib-jitsi-meet.min.js')).rejects.toBeInstanceOf(JitsiLoadError)
  })

  it('reports a script that fails, or loads without the API, and allows a retry', async () => {
    const failed = loadJitsi(URL_)
    appended[0]?.onerror?.(new Event('error'))
    await expect(failed).rejects.toThrow('could not be loaded from 8x8.vc')
    const empty = loadJitsi(URL_)
    expect(appended).toHaveLength(2)
    appended[1]?.onload?.(new Event('load'))
    await expect(empty).rejects.toThrow('did not start')
  })

  it('gives up on a script that never arrives', async () => {
    vi.useFakeTimers()
    const pending = loadJitsi(URL_)
    const assertion = expect(pending).rejects.toThrow('took too long')
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
  })
})
