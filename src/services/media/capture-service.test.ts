import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { createFakeStream, FakeMediaStreamTrack } from '@/test/setup'
import type { MediaErrorCode } from '@/types/media'
import { toMediaError } from '@/utils/errors'
import {
  applyVideoConstraints,
  describeDisplaySurface,
  requestCamera,
  requestMicrophone,
  requestScreenShare,
  toCameraRequest,
  trackDimensions,
} from './capture-service'

/* ------------------------------------------------------------------ fakes */

class FakeMediaDevices extends EventTarget {
  enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>(() => Promise.resolve([]))
  getUserMedia = vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>()
  getDisplayMedia = vi.fn<(options?: DisplayMediaStreamOptions) => Promise<MediaStream>>()
}

function installMediaDevices(): FakeMediaDevices {
  const devices = new FakeMediaDevices()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices })
  return devices
}

function asTrack(track: FakeMediaStreamTrack): MediaStreamTrack {
  return track as unknown as MediaStreamTrack
}

/** A video track whose settings report what a real browser would. */
function trackWithSettings(settings: MediaTrackSettings & { displaySurface?: string }) {
  const track = new FakeMediaStreamTrack('video')
  track.getSettings = () => settings
  return asTrack(track)
}

let media: FakeMediaDevices

beforeEach(() => {
  resetCapabilitiesCache()
  vi.stubGlobal('isSecureContext', true)
  media = installMediaDevices()
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices')
  vi.unstubAllGlobals()
})

/* --------------------------------------------------------------- requests */

describe('requestCamera', () => {
  it('asks for video only, with every constraint as an ideal', async () => {
    const stream = createFakeStream(['video'])
    media.getUserMedia.mockResolvedValue(stream)
    const result = await requestCamera({ deviceId: 'cam-1', width: 1920, height: 1080, frameRate: 30 })
    expect(result).toBe(stream)
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
        deviceId: { ideal: 'cam-1' },
      },
    })
  })

  it('omits deviceId for the default camera', async () => {
    media.getUserMedia.mockResolvedValue(createFakeStream(['video']))
    await requestCamera({ deviceId: null, width: 1280, height: 720, frameRate: 24 })
    const constraints = media.getUserMedia.mock.calls[0]?.[0]
    expect(constraints?.video).not.toHaveProperty('deviceId')
  })

  it('refuses before prompting in an insecure context', async () => {
    vi.stubGlobal('isSecureContext', false)
    resetCapabilitiesCache()
    await expect(requestCamera({ deviceId: null, width: 1, height: 1, frameRate: 1 })).rejects.toMatchObject({
      name: 'InsecureContextError',
    })
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })
})

describe('requestMicrophone', () => {
  it('asks for audio with browser processing left on', async () => {
    media.getUserMedia.mockResolvedValue(createFakeStream(['audio']))
    await requestMicrophone('mic-1')
    expect(media.getUserMedia).toHaveBeenCalledWith({
      video: false,
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        deviceId: { ideal: 'mic-1' },
      },
    })
  })

  it('omits deviceId for the default microphone', async () => {
    media.getUserMedia.mockResolvedValue(createFakeStream(['audio']))
    await requestMicrophone(null)
    expect(media.getUserMedia.mock.calls[0]?.[0]?.audio).not.toHaveProperty('deviceId')
  })
})

describe('requestScreenShare', () => {
  it.each([true, false])('passes audio=%s as a request and a 30fps ideal', async (withAudio) => {
    const stream = createFakeStream(['video'])
    media.getDisplayMedia.mockResolvedValue(stream)
    expect(await requestScreenShare(withAudio)).toBe(stream)
    expect(media.getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 30 } },
      audio: withAudio,
    })
  })

  it('refuses when getDisplayMedia is missing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    })
    resetCapabilitiesCache()
    const caught: unknown = await requestScreenShare(false).catch((error: unknown) => error)
    expect(toMediaError(caught).code).toBe('unsupported')
  })
})

/* --------------------------------------------------------- error mapping */

describe('capture failures reach callers as mappable errors', () => {
  const cases: Array<[string, MediaErrorCode]> = [
    ['NotAllowedError', 'not-allowed'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'not-readable'],
    ['OverconstrainedError', 'overconstrained'],
    ['AbortError', 'aborted'],
    ['SomethingNewError', 'unknown'],
  ]

  it.each(cases)('camera %s → %s', async (name, code) => {
    media.getUserMedia.mockRejectedValue(new DOMException('raw browser text', name))
    const caught: unknown = await requestCamera({
      deviceId: null,
      width: 1280,
      height: 720,
      frameRate: 30,
    }).catch((error: unknown) => error)
    const mapped = toMediaError(caught)
    expect(mapped.code).toBe(code)
    expect(mapped.technical).toBe(`${name}: raw browser text`)
    expect(mapped.message).not.toContain('raw browser text')
  })

  it.each(cases)('microphone %s → %s', async (name, code) => {
    media.getUserMedia.mockRejectedValue(new DOMException('x', name))
    const caught: unknown = await requestMicrophone(null).catch((error: unknown) => error)
    expect(toMediaError(caught).code).toBe(code)
  })

  it.each(cases)('screen %s → %s', async (name, code) => {
    media.getDisplayMedia.mockRejectedValue(new DOMException('x', name))
    const caught: unknown = await requestScreenShare(true).catch((error: unknown) => error)
    expect(toMediaError(caught).code).toBe(code)
  })

  it('maps a non-Error rejection to unknown', async () => {
    media.getUserMedia.mockImplementation(() => Promise.reject('weird'))
    const caught: unknown = await requestMicrophone(null).catch((error: unknown) => error)
    expect(toMediaError(caught)).toMatchObject({ code: 'unknown', technical: 'weird' })
  })
})

/* ------------------------------------------------------------ live tracks */

describe('toCameraRequest', () => {
  it('copies the preference into a request', () => {
    expect(toCameraRequest({ deviceId: 'cam', width: 640, height: 480, frameRate: 15 })).toEqual({
      deviceId: 'cam',
      width: 640,
      height: 480,
      frameRate: 15,
    })
  })
})

describe('applyVideoConstraints', () => {
  it('applies ideals to the live track and reports success', async () => {
    const track = new FakeMediaStreamTrack('video')
    const apply = vi.spyOn(track, 'applyConstraints')
    expect(await applyVideoConstraints(asTrack(track), 1920, 1080, 60)).toBe(true)
    expect(apply).toHaveBeenCalledWith({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    })
  })

  it('reports failure when the browser rejects the constraints', async () => {
    const track = new FakeMediaStreamTrack('video')
    vi.spyOn(track, 'applyConstraints').mockRejectedValue(
      new DOMException('no', 'OverconstrainedError'),
    )
    expect(await applyVideoConstraints(asTrack(track), 8000, 8000, 240)).toBe(false)
  })

  it('reports failure when the track cannot apply constraints at all', async () => {
    const track = new FakeMediaStreamTrack('video')
    Object.defineProperty(track, 'applyConstraints', { value: undefined })
    expect(await applyVideoConstraints(asTrack(track), 1, 1, 1)).toBe(false)
  })
})

describe('trackDimensions', () => {
  it('reads the settled size', () => {
    expect(trackDimensions(asTrack(new FakeMediaStreamTrack('video')))).toEqual({
      width: 1280,
      height: 720,
    })
  })

  it('reports zero when the browser has not settled a size', () => {
    expect(trackDimensions(asTrack(new FakeMediaStreamTrack('audio')))).toEqual({
      width: 0,
      height: 0,
    })
  })
})

describe('describeDisplaySurface', () => {
  it.each([
    ['monitor', 'Entire screen'],
    ['window', 'Application window'],
    ['browser', 'Browser tab'],
    ['something-else', null],
  ])('%s → %s', (displaySurface, label) => {
    expect(describeDisplaySurface(trackWithSettings({ displaySurface }))).toBe(label)
  })

  it('is null when the browser does not report a surface', () => {
    expect(describeDisplaySurface(trackWithSettings({}))).toBeNull()
  })
})
