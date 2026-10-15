import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaError, MediaErrorCode } from '@/types/media'
import { isUserCancellation, mediaError, toMediaError } from './errors'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NAME_TO_CODE: Array<[string, MediaErrorCode]> = [
  ['NotAllowedError', 'not-allowed'],
  ['SecurityError', 'not-allowed'],
  ['PermissionDeniedError', 'not-allowed'],
  ['NotFoundError', 'not-found'],
  ['DevicesNotFoundError', 'not-found'],
  ['NotReadableError', 'not-readable'],
  ['TrackStartError', 'not-readable'],
  ['OverconstrainedError', 'overconstrained'],
  ['ConstraintNotSatisfiedError', 'overconstrained'],
  ['AbortError', 'aborted'],
  ['InsecureContextError', 'insecure-context'],
  ['TypeError', 'unsupported'],
  ['InvalidStateError', 'unknown'],
]

describe('toMediaError — DOMException', () => {
  it.each(NAME_TO_CODE)('%s → %s with a safe message and technical detail', (name, code) => {
    const mapped = toMediaError(new DOMException('raw detail', name))
    expect(mapped.code).toBe(code)
    expect(mapped.technical).toBe(`${name}: raw detail`)
    // The user-facing message is always the curated one, never the raw text.
    expect(mapped.message).toBe(mediaError(code).message)
    expect(mapped.message).not.toContain('raw detail')
  })

  it('stamps the time of mapping', () => {
    vi.useFakeTimers()
    vi.setSystemTime(123_456)
    expect(toMediaError(new DOMException('x', 'AbortError')).at).toBe(123_456)
  })
})

describe('toMediaError — plain Error', () => {
  it('maps a recognised name to the curated message', () => {
    const error = Object.assign(new Error('internal text'), { name: 'InsecureContextError' })
    expect(toMediaError(error)).toMatchObject({
      code: 'insecure-context',
      message: mediaError('insecure-context').message,
      technical: 'InsecureContextError: internal text',
    })
  })

  it('keeps an unrecognised error’s own message', () => {
    expect(toMediaError(new Error('Camera exploded'))).toMatchObject({
      code: 'unknown',
      message: 'Camera exploded',
      technical: 'Error: Camera exploded',
    })
  })

  it('falls back to the generic message when an unknown error has none', () => {
    expect(toMediaError(new Error(''))).toMatchObject({
      code: 'unknown',
      message: mediaError('unknown').message,
    })
  })

  it('maps a TypeError (missing API) to unsupported', () => {
    expect(toMediaError(new TypeError('not a function')).code).toBe('unsupported')
  })
})

describe('toMediaError — non-errors', () => {
  it.each([['a string'], [42], [null], [undefined]])('%s → unknown', (value) => {
    expect(toMediaError(value)).toMatchObject({
      code: 'unknown',
      message: mediaError('unknown').message,
      technical: String(value),
    })
  })

  it('handles an environment without DOMException', () => {
    vi.stubGlobal('DOMException', undefined)
    expect(toMediaError(new Error('plain')).code).toBe('unknown')
  })
})

describe('mediaError', () => {
  it('builds an error with the curated message and no technical detail', () => {
    vi.useFakeTimers()
    vi.setSystemTime(99)
    expect(mediaError('not-found')).toEqual({
      code: 'not-found',
      message: 'No matching device was found. Connect a device or choose another one.',
      technical: null,
      at: 99,
    })
  })

  it('accepts a message override', () => {
    expect(mediaError('cancelled', 'Picker closed').message).toBe('Picker closed')
  })

  it('has a distinct non-empty message for every code', () => {
    const codes: MediaErrorCode[] = [
      'not-allowed',
      'not-found',
      'not-readable',
      'overconstrained',
      'aborted',
      'insecure-context',
      'unsupported',
      'cancelled',
      'unknown',
    ]
    const messages = codes.map((code) => mediaError(code).message)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(codes.length)
  })
})

describe('isUserCancellation', () => {
  const of = (code: MediaErrorCode): MediaError => mediaError(code)

  it.each(['not-allowed', 'cancelled', 'aborted'] as const)('%s is a cancellation', (code) => {
    expect(isUserCancellation(of(code))).toBe(true)
  })

  it.each(['not-found', 'not-readable', 'overconstrained', 'unsupported', 'unknown'] as const)(
    '%s is a real failure',
    (code) => {
      expect(isUserCancellation(of(code))).toBe(false)
    },
  )
})
