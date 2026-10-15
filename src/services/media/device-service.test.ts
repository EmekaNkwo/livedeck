import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { toMediaError } from '@/utils/errors'
import {
  EMPTY_DEVICE_LIST,
  assertCaptureSupported,
  enumerateDevices,
  onDeviceChange,
  queryPermission,
  watchPermission,
} from './device-service'

/* ------------------------------------------------------------------ fakes */

type DeviceStub = { deviceId: string; kind: MediaDeviceKind; label: string; groupId: string }

class FakeMediaDevices extends EventTarget {
  enumerateDevices = vi.fn<() => Promise<DeviceStub[]>>(() => Promise.resolve([]))
  getUserMedia = vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>()
  getDisplayMedia = vi.fn<(options?: DisplayMediaStreamOptions) => Promise<MediaStream>>()
}

class FakePermissionStatus extends EventTarget {
  state: PermissionState
  constructor(state: PermissionState) {
    super()
    this.state = state
  }
  change(state: PermissionState): void {
    this.state = state
    this.dispatchEvent(new Event('change'))
  }
}

type PermissionQuery = (descriptor: { name: string }) => Promise<FakePermissionStatus>

function installNavigatorProperty(name: 'mediaDevices' | 'permissions', value: unknown): void {
  Object.defineProperty(navigator, name, { configurable: true, value })
}

function removeNavigatorProperty(name: 'mediaDevices' | 'permissions'): void {
  Reflect.deleteProperty(navigator, name)
}

function installMediaDevices(): FakeMediaDevices {
  const devices = new FakeMediaDevices()
  installNavigatorProperty('mediaDevices', devices)
  return devices
}

function installPermissions(query: PermissionQuery): void {
  installNavigatorProperty('permissions', { query })
}

function device(kind: MediaDeviceKind, deviceId: string, label = ''): DeviceStub {
  return { deviceId, kind, label, groupId: `group-${deviceId}` }
}

beforeEach(() => {
  resetCapabilitiesCache()
})

afterEach(() => {
  removeNavigatorProperty('mediaDevices')
  removeNavigatorProperty('permissions')
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------ enumeration */

describe('enumerateDevices', () => {
  it('returns the empty list when enumeration is unsupported', async () => {
    expect(await enumerateDevices()).toBe(EMPTY_DEVICE_LIST)
  })

  it('buckets devices by kind and keeps real labels', async () => {
    const media = installMediaDevices()
    media.enumerateDevices.mockResolvedValue([
      device('videoinput', 'cam-1', 'FaceTime HD'),
      device('audioinput', 'mic-1', 'Built-in Mic'),
      device('audiooutput', 'spk-1', 'Speakers'),
    ])
    const list = await enumerateDevices()
    expect(list.cameras).toEqual([
      { deviceId: 'cam-1', label: 'FaceTime HD', kind: 'videoinput', groupId: 'group-cam-1' },
    ])
    expect(list.microphones.map((d) => d.label)).toEqual(['Built-in Mic'])
    expect(list.speakers.map((d) => d.label)).toEqual(['Speakers'])
  })

  it('substitutes positional names before permission and drops placeholder entries', async () => {
    const media = installMediaDevices()
    media.enumerateDevices.mockResolvedValue([
      device('videoinput', ''),
      device('videoinput', 'cam-1'),
      device('videoinput', 'cam-2'),
      device('audioinput', 'mic-1'),
      device('audiooutput', 'spk-1'),
      device('audioinput', ''),
    ])
    const list = await enumerateDevices()
    expect(list.cameras.map((d) => d.label)).toEqual(['Camera 1', 'Camera 2'])
    expect(list.microphones.map((d) => d.label)).toEqual(['Microphone 1'])
    expect(list.speakers.map((d) => d.label)).toEqual(['Speaker 1'])
  })

  it('propagates an enumeration failure', async () => {
    const media = installMediaDevices()
    media.enumerateDevices.mockRejectedValue(new DOMException('nope', 'NotAllowedError'))
    await expect(enumerateDevices()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})

describe('onDeviceChange', () => {
  it('is an inert subscription when devicechange is unsupported', () => {
    const listener = vi.fn()
    const unsubscribe = onDeviceChange(listener)
    expect(() => unsubscribe()).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('delivers devicechange events until unsubscribed', () => {
    const media = installMediaDevices()
    const listener = vi.fn()
    const unsubscribe = onDeviceChange(listener)
    media.dispatchEvent(new Event('devicechange'))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    media.dispatchEvent(new Event('devicechange'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------ permissions */

describe('queryPermission', () => {
  it('is unknown without a Permissions API', async () => {
    expect(await queryPermission('camera')).toBe('unknown')
    installNavigatorProperty('permissions', {})
    expect(await queryPermission('camera')).toBe('unknown')
  })

  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['prompt', 'prompt'],
  ] as const)('maps %s to %s and queries the right name', async (state, expected) => {
    const query = vi.fn<PermissionQuery>(() => Promise.resolve(new FakePermissionStatus(state)))
    installPermissions(query)
    expect(await queryPermission('microphone')).toBe(expected)
    expect(query).toHaveBeenCalledWith({ name: 'microphone' })
  })

  it('is unknown when the browser rejects the query (Firefox camera)', async () => {
    installPermissions(() => Promise.reject(new TypeError('camera is not a valid PermissionName')))
    expect(await queryPermission('camera')).toBe('unknown')
  })
})

describe('watchPermission', () => {
  it('returns a no-op cleanup without a Permissions API', async () => {
    const stop = await watchPermission('camera', vi.fn())
    expect(() => stop()).not.toThrow()
  })

  it('reports each change, mapped, until stopped', async () => {
    const status = new FakePermissionStatus('prompt')
    installPermissions(() => Promise.resolve(status))
    const listener = vi.fn()
    const stop = await watchPermission('camera', listener)

    status.change('granted')
    status.change('denied')
    status.change('prompt')
    expect(listener.mock.calls).toEqual([['granted'], ['denied'], ['prompt']])

    stop()
    status.change('granted')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('returns a no-op cleanup when the query rejects', async () => {
    installPermissions(() => Promise.reject(new TypeError('unsupported')))
    const listener = vi.fn()
    const stop = await watchPermission('microphone', listener)
    expect(() => stop()).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})

/* ----------------------------------------------------------------- guards */

describe('assertCaptureSupported', () => {
  it('throws an insecure-context error first, whatever else is available', () => {
    vi.stubGlobal('isSecureContext', false)
    installMediaDevices()
    let caught: unknown
    try {
      assertCaptureSupported('user')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(toMediaError(caught).code).toBe('insecure-context')
  })

  it.each(['user', 'display'] as const)(
    'throws an unsupported error for %s capture without the API',
    (kind) => {
      vi.stubGlobal('isSecureContext', true)
      let caught: unknown
      try {
        assertCaptureSupported(kind)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ name: 'TypeError' })
      expect(toMediaError(caught).code).toBe('unsupported')
    },
  )

  it('passes in a secure context with the API present', () => {
    vi.stubGlobal('isSecureContext', true)
    installMediaDevices()
    expect(() => assertCaptureSupported('user')).not.toThrow()
    expect(() => assertCaptureSupported('display')).not.toThrow()
  })

  it('checks the API that matches the capture kind', () => {
    vi.stubGlobal('isSecureContext', true)
    const media = { getUserMedia: vi.fn() }
    installNavigatorProperty('mediaDevices', media)
    expect(() => assertCaptureSupported('user')).not.toThrow()
    expect(() => assertCaptureSupported('display')).toThrow(/does not support/)
  })
})
