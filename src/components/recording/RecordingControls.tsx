import { Circle, Library, Pause, Play, Square, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useRecording } from '@/hooks/useRecording'
import { useRecordingStore } from '@/stores/recordingStore'
import { useStudioStore } from '@/stores/studioStore'
import { formatDuration } from '@/utils/format'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { Badge, Notice } from '@/components/shared/Status'

/**
 * Transport controls for recording the program output.
 *
 * Status text comes straight from the engine, which only reports `complete`
 * after MediaRecorder has produced a finished blob. "Finalizing" is a real,
 * visible state rather than an instant jump to success.
 */

export function RecordingControls() {
  const recording = useRecording()
  const entryCount = useRecordingStore((state) => state.entries.length)
  const openDialog = useStudioStore((state) => state.openDialog)

  const isRecording = recording.status === 'recording'
  const isPaused = recording.status === 'paused'
  const isBusy = recording.status === 'starting' || recording.status === 'finalizing'

  return (
    <Panel
      title="Recording"
      badge={
        isRecording || isPaused ? (
          <Badge tone={isRecording ? 'live' : 'warn'}>{isRecording ? 'Rec' : 'Paused'}</Badge>
        ) : null
      }
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openDialog('recordings')}
          title="Open the recording library"
        >
          <Library aria-hidden="true" className="h-3.5 w-3.5" />
          {entryCount > 0 ? entryCount : null}
          <span className="sr-only">Open recording library</span>
        </Button>
      }
    >
      <div className="flex flex-col gap-2.5">
        {/* Elapsed time. A live region so the duration is announced
            periodically rather than on every tick. */}
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'font-mono text-2xl tabular-nums',
              isRecording ? 'text-live-400' : 'text-ink-200',
            )}
          >
            {formatDuration(recording.elapsedMs)}
          </span>
          <span className="text-[11px] text-ink-500">{statusLabel(recording.status)}</span>
        </div>
        <span aria-live="polite" className="sr-only-live">
          {isRecording ? `Recording, ${formatDuration(recording.elapsedMs)} elapsed` : ''}
        </span>

        <div className="flex flex-wrap gap-1.5">
          {!isRecording && !isPaused ? (
            <Button
              variant="live"
              size="sm"
              disabled={!recording.canRecord || isBusy}
              onClick={() => void recording.start()}
              className="flex-1"
            >
              <Circle aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              {recording.status === 'starting' ? 'Starting…' : 'Start recording'}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={!recording.canPause}
                onClick={isPaused ? recording.resume : recording.pause}
                title={
                  recording.canPause
                    ? undefined
                    : 'Pausing a recording is not supported in this browser'
                }
              >
                {isPaused ? (
                  <Play aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <Pause aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {isPaused ? 'Resume' : 'Pause'}
              </Button>

              <Button
                variant="primary"
                size="sm"
                disabled={isBusy}
                onClick={recording.stop}
                className="flex-1"
              >
                <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
                {recording.status === 'finalizing' ? 'Finalizing…' : 'Stop & save'}
              </Button>

              <Button
                variant="ghost"
                size="icon-sm"
                onClick={recording.cancel}
                aria-label="Discard this recording"
                title="Discard without saving"
                className="hover:text-live-400"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>

        {/* Negotiated format — shown because it varies by browser. */}
        {recording.format ? (
          <p className="text-[10px] text-ink-500">
            Format: <span className="text-ink-400">{recording.format.label}</span>
            {' · .'}
            {recording.format.extension}
          </p>
        ) : null}

        {!recording.canRecord ? (
          <Notice tone="warning">
            No recording format is supported by this browser, so recording is unavailable.
            Composition, preview and the audio mixer all still work.
          </Notice>
        ) : null}

        {recording.error ? (
          <div className="flex flex-col gap-2">
            <Notice tone="error">{recording.error.message}</Notice>
            <div className="flex gap-1.5">
              {recording.error.recoverable ? (
                <Button variant="outline" size="sm" onClick={() => void recording.start()}>
                  Try again
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={recording.dismissError}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}

        <Notice>
          Recordings stay on this device — nothing is uploaded. The file captures the composed
          program output, so scene switches, transforms, hidden sources and mixer changes are all
          included.
        </Notice>
      </div>
    </Panel>
  )
}

function statusLabel(status: ReturnType<typeof useRecording>['status']): string {
  switch (status) {
    case 'idle':
      return 'Ready'
    case 'starting':
      return 'Starting'
    case 'recording':
      return 'Recording the program output'
    case 'paused':
      return 'Paused'
    case 'finalizing':
      return 'Writing the file'
    case 'complete':
      return 'Saved to the library'
    case 'error':
      return 'Error'
  }
}
