import type { JitsiMeetJS } from './lib-types'

/**
 * Load lib-jitsi-meet from the Jitsi deployment that will carry the media.
 *
 * Every Jitsi deployment serves its own build at `/libs/lib-jitsi-meet.min.js`
 * (JaaS at https://8x8.vc/libs/…). Loading that build, rather than bundling
 * one, keeps the client protocol in step with the backend it talks to.
 * The URL comes from the server's media grant, never from the page.
 */

const LOAD_TIMEOUT_MS = 20_000

let loading: { url: string; promise: Promise<JitsiMeetJS> } | null = null
let initialized = false

export class JitsiLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JitsiLoadError'
  }
}

export function loadJitsi(libraryUrl: string): Promise<JitsiMeetJS> {
  if (loading?.url === libraryUrl) return loading.promise
  const url = new URL(libraryUrl)
  if (url.protocol !== 'https:') {
    return Promise.reject(new JitsiLoadError('Refusing to load the media library over plain HTTP.'))
  }
  const promise = new Promise<JitsiMeetJS>((resolve, reject) => {
    const existing = window.JitsiMeetJS
    if (existing) {
      resolve(existing)
      return
    }
    const script = document.createElement('script')
    script.src = url.href
    script.async = true
    const timer = window.setTimeout(() => {
      script.remove()
      reject(new JitsiLoadError('The media library took too long to load.'))
    }, LOAD_TIMEOUT_MS)
    script.onload = () => {
      window.clearTimeout(timer)
      const api = window.JitsiMeetJS
      if (api) resolve(api)
      else reject(new JitsiLoadError('The media library loaded but did not start.'))
    }
    script.onerror = () => {
      window.clearTimeout(timer)
      script.remove()
      reject(new JitsiLoadError(`The media library could not be loaded from ${url.host}.`))
    }
    document.head.append(script)
  }).then((api) => {
    if (!initialized) {
      // Peer-to-peer is off below; quiet logs keep the console usable.
      api.init({})
      api.setLogLevel(api.logLevels.ERROR)
      initialized = true
    }
    return api
  })
  // A failed load can be retried with the next grant.
  promise.catch(() => {
    if (loading?.promise === promise) loading = null
  })
  loading = { url: libraryUrl, promise }
  return promise
}

/** Test seam. */
export function resetJitsiLoader(): void {
  loading = null
  initialized = false
}
