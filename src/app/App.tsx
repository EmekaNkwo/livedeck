import { Suspense, lazy, useEffect } from 'react'
import { onPersistenceIssue } from '@/services/persistence/issues'
import { useStudioStore } from '@/stores/studioStore'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Toast } from '@/components/shared/Toast'
import { LandingPage } from './pages/LandingPage'

/**
 * Role-based routing.
 *
 * Every path *is* a role, the way VDO.Ninja's URLs are — the page you get is
 * decided by which one you opened, not by a mode toggle inside one app shell:
 *
 *   /director/:room   the control room
 *   /push/:room       a guest's sender
 *   /scene/:room      a clean program output, for screen capture
 *   /solo/:room/:id   one guest's feed, clean
 *
 * Each role view is a separate chunk. A guest opening an invite link should not
 * download the mixer, the recorder or the scene editor, none of which their
 * page can even use.
 *
 * The confirmation dialog and the toast live at this level so a destructive
 * action from the landing page (deleting a saved room) gets the same treatment.
 */

const DirectorPage = lazy(() =>
  import('./pages/DirectorPage').then((module) => ({ default: module.DirectorPage })),
)
const PushPage = lazy(() =>
  import('./pages/PushPage').then((module) => ({ default: module.PushPage })),
)
const ScenePage = lazy(() =>
  import('./pages/ScenePage').then((module) => ({ default: module.ScenePage })),
)
const SoloPage = lazy(() =>
  import('./pages/SoloPage').then((module) => ({ default: module.SoloPage })),
)

export function App() {
  const showToast = useStudioStore((state) => state.showToast)
  useEffect(
    () =>
      onPersistenceIssue((issue) =>
        showToast(`Saved ${issue.record} could not be used (${issue.message}). Defaults were restored.`, 'error'),
      ),
    [showToast],
  )
  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />

          <Route path="/director/:room" element={<DirectorPage />} />
          <Route path="/push/:room" element={<PushPage />} />
          <Route path="/scene/:room" element={<ScenePage />} />
          <Route path="/solo/:room/:sourceId" element={<SoloPage />} />

          {/* Older links pointed at a session rather than a room; both map to
              the control room so a bookmark keeps working. */}
          <Route path="/studio/:room" element={<DirectorPage />} />
          <Route path="/lobby/:room" element={<DirectorPage />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>

      <ConfirmDialog />
      <Toast />
    </>
  )
}

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-deck-950">
      <p role="status" className="text-sm text-ink-400">
        Loading…
      </p>
    </div>
  )
}
