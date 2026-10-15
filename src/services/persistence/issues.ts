import type { ValidationIssue } from './schemas'

/**
 * Where persistence problems are reported.
 *
 * Stores and loaders run before any React tree exists, so they cannot show
 * a toast themselves. They report here; the studio subscribes once mounted
 * and tells the operator what was discarded. Issues raised before anyone
 * subscribes are replayed to the first subscriber.
 */

type Listener = (issue: ValidationIssue) => void

const listeners = new Set<Listener>()
const backlog: ValidationIssue[] = []

export function reportPersistenceIssue(issue: ValidationIssue): void {
  if (listeners.size === 0) {
    backlog.push(issue)
    return
  }
  for (const listener of listeners) listener(issue)
}

export function onPersistenceIssue(listener: Listener): () => void {
  listeners.add(listener)
  for (const issue of backlog.splice(0)) listener(issue)
  return () => listeners.delete(listener)
}

/** Test seam. */
export function resetPersistenceIssues(): void {
  listeners.clear()
  backlog.length = 0
}
