import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Toast } from '@/components/shared/Toast'
import { LobbyPage } from './pages/LobbyPage'

/**
 * Routes and the app-level overlays.
 *
 * The studio is loaded lazily. It pulls in the whole production surface —
 * compositor, mixer, recorder, WebRTC, the animation library — none of which
 * the lobby needs, so splitting here keeps the first paint small for someone
 * who is only picking a session.
 *
 * The confirmation dialog and the toast live at this level rather than inside
 * the studio, so a destructive action triggered from the lobby (deleting a
 * saved session) gets the same confirmation treatment.
 */
const StudioPage = lazy(() =>
  import('./pages/StudioPage').then((module) => ({ default: module.StudioPage })),
)

export function App() {
  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LobbyPage />} />
          {/* `/lobby/:sessionId` is kept as an alias so older links still work. */}
          <Route path="/lobby/:sessionId" element={<StudioPage />} />
          <Route path="/studio/:sessionId" element={<StudioPage />} />
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
        Loading the studio…
      </p>
    </div>
  )
}
