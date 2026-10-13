import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useStudioStore } from '@/stores/studioStore'
import { StudioShell } from '@/components/layout/StudioShell'

/**
 * The studio route.
 *
 * Resolves `/studio/:sessionId` into a loaded session before mounting the
 * shell, so the shell never has to cope with a null session. An unknown id
 * redirects to the lobby rather than rendering an empty studio.
 */
export function StudioPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const session = useStudioSession()
  const currentId = useStudioStore((state) => state.session?.id ?? null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    if (currentId === sessionId) return
    // The session may already be loaded (navigated from the lobby) or may need
    // hydrating from local storage (direct link, page reload).
    const opened = session.openSession(sessionId)
    if (!opened) setNotFound(true)
    // `session` is recreated each render; depending on it would loop. The id is
    // the only input that should re-trigger a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, sessionId])

  if (!sessionId || notFound) return <Navigate to="/" replace />

  if (currentId !== sessionId) {
    return (
      <div className="flex h-full items-center justify-center bg-deck-950">
        <p className="text-sm text-ink-400">Opening session…</p>
      </div>
    )
  }

  return <StudioShell />
}
