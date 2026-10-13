export type RecordingStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'complete'
  | 'error'

/** The negotiated container/codec actually accepted by MediaRecorder. */
export type RecordingFormat = {
  mimeType: string
  /** File extension matching `mimeType`, without the dot. */
  extension: string
  /** Short label for the UI, e.g. "WebM · VP9 + Opus". */
  label: string
}

/** Serializable metadata about a finished recording. */
export type RecordingEntry = {
  id: string
  sessionId: string
  name: string
  mimeType: string
  extension: string
  /** Bytes. */
  size: number
  durationMs: number
  width: number
  height: number
  frameRate: number
  createdAt: number
  /**
   * True when the blob was written to IndexedDB and can survive a reload.
   * False for recordings kept only in memory (e.g. quota exceeded), which are
   * download-only and vanish on refresh.
   */
  persisted: boolean
}

export type RecordingError = {
  code:
    | 'unsupported'
    | 'no-video-track'
    | 'quota-exceeded'
    | 'recorder-error'
    | 'finalize-failed'
    | 'persist-failed'
    | 'simulated'
  message: string
  recoverable: boolean
  at: number
}
