import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { clearNamespace } from '@/services/persistence/local-store'

/**
 * The last line of defence against a blank white page.
 *
 * A render error anywhere below lands here with a description, a reload, and
 * a way out of the one state a reload cannot fix: a persisted document the
 * studio cannot open. "Reset studio state" clears this app's localStorage
 * namespace only — recordings and media assets in IndexedDB are kept.
 *
 * The stack is shown for the operator to copy into a bug report. Nothing in
 * it is secret: room keys live in the server's memory and in a localStorage
 * entry this component never reads.
 */

const RETRY_KEY = 'livedeck:chunk-retry'

/** A stale deploy 404s a lazy chunk; one automatic reload picks up the new build. */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(
    message,
  )
}

function Fallback({ error, resetErrorBoundary }: FallbackProps) {
  const [showDetails, setShowDetails] = useState(false)
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const chunk = isChunkLoadError(error)

  if (chunk && typeof sessionStorage !== 'undefined') {
    try {
      if (!sessionStorage.getItem(RETRY_KEY)) {
        sessionStorage.setItem(RETRY_KEY, '1')
        window.location.reload()
      }
    } catch {
      // Private mode: fall through to the manual controls.
    }
  }

  const resetState = () => {
    clearNamespace()
    try {
      sessionStorage.removeItem(RETRY_KEY)
    } catch {
      // Nothing to clear.
    }
    window.location.href = '/'
  }

  return (
    <main role="alert" className="flex h-full items-center justify-center bg-deck-950 p-6">
      <div className="flex w-full max-w-lg flex-col gap-3 border border-live-500/40 bg-deck-900 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle aria-hidden="true" className="h-5 w-5 text-live-400" />
          <h1 className="text-base font-semibold text-ink-100">
            {chunk ? 'A newer version of the studio is available' : 'The studio hit an error'}
          </h1>
        </div>
        <p className="text-xs leading-relaxed text-ink-300">
          {chunk
            ? 'Part of the app could not be loaded because the site was updated. Reload to pick up the new version.'
            : 'Something went wrong while drawing the interface. A recording in progress is kept in storage and will be recovered on the next load.'}
        </p>
        <p className="break-words font-mono text-[11px] text-live-400">{message}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 bg-accent-500 px-3 py-1.5 text-xs font-semibold text-deck-950"
          >
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            Reload
          </button>
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="flex items-center gap-1.5 border border-deck-600 px-3 py-1.5 text-xs text-ink-200"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={resetState}
            className="flex items-center gap-1.5 border border-live-500/60 px-3 py-1.5 text-xs text-live-400"
            title="Clears saved productions and settings in this browser. Recordings and media files are kept."
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Reset studio state
          </button>
        </div>
        {stack ? (
          <div>
            <button
              type="button"
              onClick={() => setShowDetails((value) => !value)}
              className="text-[11px] text-ink-500 underline"
            >
              {showDetails ? 'Hide details' : 'Show details'}
            </button>
            {showDetails ? (
              <pre className="mt-2 max-h-48 overflow-auto bg-deck-950 p-2 font-mono text-[10px] text-ink-400">
                {stack}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  )
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      FallbackComponent={Fallback}
      onReset={() => {
        try {
          sessionStorage.removeItem(RETRY_KEY)
        } catch {
          // Nothing to clear.
        }
      }}
    >
      {children}
    </ErrorBoundary>
  )
}
