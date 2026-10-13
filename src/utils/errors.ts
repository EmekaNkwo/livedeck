import type { MediaError, MediaErrorCode } from '@/types/media'

const MESSAGES: Record<MediaErrorCode, string> = {
  'not-allowed':
    'Permission was denied. Allow access in your browser’s site settings, then retry.',
  'not-found': 'No matching device was found. Connect a device or choose another one.',
  'not-readable':
    'The device is in use by another application, or the operating system blocked it.',
  overconstrained:
    'The device cannot satisfy the requested resolution or frame rate. Try a lower setting.',
  aborted: 'The request was interrupted before the device started.',
  'insecure-context':
    'Media capture requires a secure context. Open the app over HTTPS or on localhost.',
  unsupported: 'This browser does not support the media API this feature needs.',
  cancelled: 'The request was cancelled.',
  unknown: 'The device could not be started.',
}

/**
 * Map a DOMException from getUserMedia/getDisplayMedia onto a stable code and
 * a message that is safe to put in front of a user.
 *
 * Stack traces and raw exception text are kept in `technical` and surfaced only
 * in the diagnostics panel.
 */
export function toMediaError(error: unknown): MediaError {
  const at = Date.now()
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    const code = mapDomExceptionName(error.name)
    return { code, message: MESSAGES[code], technical: `${error.name}: ${error.message}`, at }
  }
  if (error instanceof Error) {
    // Our own guard clauses throw plain Errors with a recognizable name.
    const code = mapDomExceptionName(error.name)
    return {
      code,
      message: code === 'unknown' ? error.message || MESSAGES.unknown : MESSAGES[code],
      technical: `${error.name}: ${error.message}`,
      at,
    }
  }
  return { code: 'unknown', message: MESSAGES.unknown, technical: String(error), at }
}

function mapDomExceptionName(name: string): MediaErrorCode {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'not-allowed'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'not-readable'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'overconstrained'
    case 'AbortError':
      return 'aborted'
    case 'InsecureContextError':
      return 'insecure-context'
    case 'TypeError':
      return 'unsupported'
    default:
      return 'unknown'
  }
}

export function mediaError(code: MediaErrorCode, override?: string): MediaError {
  return { code, message: override ?? MESSAGES[code], technical: null, at: Date.now() }
}

/** True when the user dismissed the screen-share picker rather than failing. */
export function isUserCancellation(error: MediaError): boolean {
  // Chrome reports a dismissed getDisplayMedia picker as NotAllowedError, which
  // is indistinguishable from a blocked permission at the API level. Both are
  // non-fatal for screen share, so the caller treats them the same way.
  return error.code === 'not-allowed' || error.code === 'cancelled' || error.code === 'aborted'
}
