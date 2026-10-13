const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  // crypto is available in every browser that can run getUserMedia, but guard
  // anyway so unit tests in bare environments still work.
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
    return bytes
  }
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

/** Short, URL-safe, lowercase id — used for sessions so they stay typeable. */
export function shortId(length = 6): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length]
  }
  return out
}

/** Prefixed entity id, e.g. `src_k3f9a1`. Readable in diagnostics output. */
export function createId(prefix: string): string {
  return `${prefix}_${shortId(8)}`
}

export const createSourceId = () => createId('src')
export const createSceneId = () => createId('scn')
export const createGuestId = () => createId('gst')
export const createPeerId = () => createId('peer')
export const createRecordingId = () => createId('rec')
export const createSessionId = () => shortId(6)

/**
 * A room code in the `abc-defg-hij` shape meeting tools use.
 *
 * Grouped in threes because that is what makes a code readable aloud over a
 * phone and typeable from memory, and letters only because a code containing
 * `0`/`o` or `1`/`l` gets mistyped. Rooms are addressed by this string, so it
 * has to survive being dictated.
 *
 * This is a convenience label, **not** a credential — anyone holding it can
 * join the room. 10 letters is roughly 47 bits, which makes it impractical to
 * guess, but that is obscurity, not access control.
 */
export function createRoomCode(): string {
  const letters = 'abcdefghijkmnpqrstuvwxyz'
  const bytes = randomBytes(10)
  const pick = (index: number) => letters[(bytes[index] ?? 0) % letters.length] ?? 'x'
  const group = (start: number, length: number) =>
    Array.from({ length }, (_, offset) => pick(start + offset)).join('')
  return `${group(0, 3)}-${group(3, 4)}-${group(7, 3)}`
}

/** Make `name` unique within `existing` by appending a numeric suffix. */
export function uniqueName(name: string, existing: readonly string[]): string {
  if (!existing.includes(name)) return name
  const base = name.replace(/ (\d+)$/, '')
  let counter = 2
  let candidate = `${base} ${counter}`
  while (existing.includes(candidate)) {
    counter += 1
    candidate = `${base} ${counter}`
  }
  return candidate
}
