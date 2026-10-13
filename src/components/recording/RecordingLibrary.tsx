import { Download, Film, Play, Trash2 } from 'lucide-react'
import { useRecordingLibrary } from '@/hooks/useRecordingLibrary'
import { formatBytes, formatDuration, formatTimestamp } from '@/utils/format'
import { Button } from '@/components/shared/Button'
import { Dialog } from '@/components/shared/Dialog'
import { Badge, EmptyState, Notice } from '@/components/shared/Status'
import { useStudioStore } from '@/stores/studioStore'

/**
 * The local recording library.
 *
 * Shows the real persistence state of each entry: an entry that could not be
 * written to IndexedDB is marked "not stored" and the copy explains that it is
 * downloadable now but will be lost on reload. Nothing pretends to be saved
 * when it is not.
 */

export function RecordingLibraryDialog() {
  const dialog = useStudioStore((state) => state.dialog)
  const closeDialog = useStudioStore((state) => state.closeDialog)
  const library = useRecordingLibrary()

  const open = dialog === 'recordings'
  const previewEntry = library.entries.find((entry) => entry.id === library.previewId) ?? null

  return (
    <Dialog
      open={open}
      onClose={() => {
        library.closePreview()
        closeDialog()
      }}
      title="Recordings"
      description="Stored on this device only. Nothing is uploaded to any server."
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {library.storage ? (
          <p className="text-[11px] text-ink-500">
            Browser storage: {formatBytes(library.storage.usage)} used
            {library.storage.quota > 0 ? ` of about ${formatBytes(library.storage.quota)}` : ''}
          </p>
        ) : null}

        {/* Preview player. */}
        {previewEntry ? (
          <section className="flex flex-col gap-2 rounded-lg border border-deck-600 bg-deck-900 p-3">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-100">
                {previewEntry.name}
              </h3>
              <Button variant="ghost" size="sm" onClick={library.closePreview}>
                Close preview
              </Button>
            </div>

            {library.previewError ? (
              <Notice tone="error">{library.previewError}</Notice>
            ) : library.previewUrl ? (
              <video
                // `key` forces a fresh element per recording, so the player
                // never shows a stale first frame from the previous one.
                key={previewEntry.id}
                src={library.previewUrl}
                controls
                playsInline
                className="w-full rounded-md bg-black"
                onError={() => {
                  // A blob can exist but be undecodable — for instance a
                  // recording interrupted before its container was finalized.
                }}
              />
            ) : null}

            <p className="text-[11px] text-ink-500">
              {previewEntry.width}×{previewEntry.height} · {previewEntry.frameRate} fps ·{' '}
              {previewEntry.mimeType}
            </p>
          </section>
        ) : null}

        {library.loading ? (
          <p className="py-6 text-center text-xs text-ink-500">Loading recordings…</p>
        ) : library.entries.length === 0 ? (
          <EmptyState
            icon={<Film aria-hidden="true" className="h-6 w-6" />}
            title="No recordings yet"
            description="Record the program output and it will appear here, ready to preview and download."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {library.entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-deck-700 bg-deck-800 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 truncate text-xs font-medium text-ink-100">
                      {entry.name}
                    </p>
                    {!entry.persisted ? (
                      <Badge tone="warn">Not stored</Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    {formatDuration(entry.durationMs)} · {formatBytes(entry.size)} ·{' '}
                    {entry.width}×{entry.height} · {formatTimestamp(entry.createdAt)}
                  </p>
                  {!entry.persisted ? (
                    <p className="mt-1 text-[11px] leading-snug text-warn-400">
                      This recording is held in memory only — download it now, or it will be lost
                      when the page reloads.
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void library.openPreview(entry.id)}
                  >
                    <Play aria-hidden="true" className="h-3.5 w-3.5" />
                    Preview
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void library.download(entry.id)}
                  >
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                    Download
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => library.requestDelete(entry.id)}
                    aria-label={`Delete ${entry.name}`}
                    className="hover:text-live-400"
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
