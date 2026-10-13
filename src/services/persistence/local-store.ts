/**
 * Versioned localStorage access for *serializable configuration only*.
 *
 * Live objects — MediaStream, HTMLVideoElement, AudioNode, RTCPeerConnection —
 * are never written here. Zustand's persist middleware is configured with
 * explicit `partialize` functions so ephemeral state cannot leak into storage
 * by accident. See README › Persistence.
 */

const NAMESPACE = 'livedeck'
const SCHEMA_VERSION = 1

export function storageKey(name: string): string {
  return `${NAMESPACE}:v${SCHEMA_VERSION}:${name}`
}

/** True when localStorage is both present and writable (Safari private mode). */
export function isStorageAvailable(): boolean {
  try {
    const probe = `${NAMESPACE}:probe`
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

export function readJson<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(name))
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    // Corrupt or inaccessible data must never prevent the studio from opening.
    return fallback
  }
}

export function writeJson(name: string, value: unknown): boolean {
  try {
    localStorage.setItem(storageKey(name), JSON.stringify(value))
    return true
  } catch {
    // Most likely a quota error. Configuration is small, so this is rare, and
    // losing it is strictly better than blocking the UI.
    return false
  }
}

export function removeKey(name: string): void {
  try {
    localStorage.removeItem(storageKey(name))
  } catch {
    // Nothing useful to do.
  }
}

/** Remove every key in this app's namespace. Backs "Reset studio data". */
export function clearNamespace(): void {
  try {
    const prefix = `${NAMESPACE}:`
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && key.startsWith(prefix)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // Nothing useful to do.
  }
}

/**
 * A storage adapter for Zustand's `persist` that degrades to an in-memory map
 * when localStorage is unavailable, so the studio still works in private
 * browsing modes — it just will not remember anything.
 */
export function createSafeStorage(): Storage {
  if (isStorageAvailable()) return localStorage
  const memory = new Map<string, string>()
  return {
    get length() {
      return memory.size
    },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => {
      memory.delete(key)
    },
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
  }
}
