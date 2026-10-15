import { expect, test, type Page } from '@playwright/test'
import { DEPLOYED } from './fixtures'

/**
 * The files a recording produces, checked byte by byte in a real browser.
 *
 * The studio test proves the Record button works; this one proves what lands
 * on disk is a file an editor will open. It drives the recording engine and
 * the finalize step directly against a painted canvas and an oscillator, with
 * the browser's real encoders, then inspects the stored bytes:
 *
 *   - WebCodecs path: a standard MP4 (index present, no fragments left)
 *     with H.264 video and audio, whose length matches what was recorded.
 *   - MediaRecorder path: a WebM with a duration and a cue index.
 *   - Crash recovery: capture that is never stopped still becomes a
 *     complete, playable file.
 */

/* The slices of the app's modules this spec calls inside the page. */
type Format = { mimeType: string; extension: string; label: string }
type CaptureResult = { mimeType: string; durationMs: number; bytes: number }
type Engine = {
  setEvents: (events: {
    onComplete?: (result: CaptureResult) => void
    onError?: (error: { message: string }) => void
  }) => void
  start: (options: {
    canvas: HTMLCanvasElement
    audioStream: MediaStream | null
    frameRate: number
    sink: (index: number, chunk: Blob, at: number) => Promise<void>
    preferMp4?: boolean
  }) => Promise<boolean>
  getFormat: () => Format | null
  getElapsedMs: () => number
  stop: () => void
  cancel: () => void
}
type EngineModule = { RecordingEngine: new () => Engine }
type StoreModule = {
  beginRecording: (entry: Record<string, unknown>, startedAt: number) => Promise<void>
  appendChunk: (id: string, index: number, chunk: Blob, at: number) => Promise<void>
  setRecordingFormat: (id: string, mimeType: string, extension: string) => Promise<void>
  markInterrupted: (id: string) => Promise<void>
  loadRecordingBlob: (id: string) => Promise<Blob | null>
  deleteRecording: (id: string) => Promise<void>
}
type FinalizeModule = {
  finalizeRecording: (input: CaptureResult & { id: string }) => Promise<{ remuxed: boolean; warning: string | null }>
}
type RecoveryModule = {
  recoverInterruptedRecordings: () => Promise<{ recovered: number; failed: Array<{ reason: string }> }>
}
type RemuxModule = {
  describeMedia: (file: Blob) => Promise<{
    mimeType: string
    durationMs: number
    headerDurationMs: number | null
    videoCodec: string | null
    audioCodec: string | null
  }>
}

type Outcome = {
  format: string | null
  container: string
  durationMs: number
  headerDurationMs: number | null
  videoCodec: string | null
  audioCodec: string | null
  remuxed: boolean
  warning: string | null
  /** Top-level MP4 box types, in order; empty for WebM. */
  boxes: string[]
  hasCues: boolean
  recordedMs: number
}

async function record(page: Page, mode: 'mp4' | 'webm' | 'crash', seconds: number): Promise<Outcome> {
  return page.evaluate(
    async ({ mode, seconds }) => {
      // Vite serves the app's modules by path; the types are declared above.
      const load = (path: string) => import(/* @vite-ignore */ `/src/services/${path}.ts`)
      const { RecordingEngine } = (await load('recording/recording-engine')) as EngineModule
      const store = (await load('persistence/recording-store')) as StoreModule
      const { finalizeRecording } = (await load('recording/finalize')) as FinalizeModule
      const { recoverInterruptedRecordings } = (await load('recording/recovery')) as RecoveryModule
      const { describeMedia } = (await load('recording/remux')) as RemuxModule

      // A moving picture, so the encoder produces real frames.
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 360
      const context = canvas.getContext('2d') as CanvasRenderingContext2D
      let frame = 0
      const paint = window.setInterval(() => {
        frame += 1
        context.fillStyle = `hsl(${(frame * 7) % 360} 70% 50%)`
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = '#fff'
        context.font = '48px sans-serif'
        context.fillText(String(frame), 40, 80)
      }, 33)

      const audioContext = new AudioContext({ sampleRate: 48_000 })
      const oscillator = audioContext.createOscillator()
      const destination = audioContext.createMediaStreamDestination()
      oscillator.connect(destination)
      oscillator.start()

      const id = `e2e-${mode}-${Date.now()}`
      const startedAt = Date.now()
      await store.beginRecording(
        {
          id,
          sessionId: 'e2e',
          name: `E2E ${mode}`,
          mimeType: 'video/webm',
          extension: 'webm',
          size: 0,
          durationMs: 0,
          width: canvas.width,
          height: canvas.height,
          frameRate: 30,
          createdAt: startedAt,
          persisted: true,
        },
        startedAt,
      )

      const engine = new RecordingEngine()
      const completion = new Promise<{ mimeType: string; durationMs: number; bytes: number }>((resolve, reject) => {
        engine.setEvents({
          onComplete: (result) => resolve(result),
          onError: (error) => reject(new Error(error.message)),
        })
      })
      const started = await engine.start({
        canvas,
        audioStream: destination.stream,
        frameRate: 30,
        sink: (index, chunk, at) => store.appendChunk(id, index, chunk, at),
        preferMp4: mode !== 'webm',
      })
      if (!started) throw new Error('The engine did not start.')
      const format = engine.getFormat()?.label ?? null
      // The row records what capture writes, as useRecording does.
      const chosen = engine.getFormat()
      if (chosen) await store.setRecordingFormat(id, chosen.mimeType, chosen.extension)

      await new Promise((resolve) => window.setTimeout(resolve, seconds * 1000))
      const recordedMs = engine.getElapsedMs()

      let remuxed = false
      let warning: string | null = null
      if (mode === 'crash') {
        // The page "goes away": capture stops without finishing the file and
        // the row is left unfinished, as after a closed tab.
        engine.cancel()
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        await store.markInterrupted(id)
        const report = await recoverInterruptedRecordings()
        if (report.recovered < 1) {
          throw new Error(`Nothing was recovered: ${report.failed.map((entry) => entry.reason).join('; ')}`)
        }
        remuxed = true
      } else {
        engine.stop()
        const result = await completion
        const final = await finalizeRecording({
          id,
          mimeType: result.mimeType,
          durationMs: result.durationMs,
          bytes: result.bytes,
        })
        remuxed = final.remuxed
        warning = final.warning
      }
      window.clearInterval(paint)
      oscillator.stop()
      await audioContext.close()

      const file = await store.loadRecordingBlob(id)
      if (!file) throw new Error('No file was stored.')
      const description = await describeMedia(file)
      const bytes = new Uint8Array(await file.arrayBuffer())

      // Walk the top-level MP4 boxes: [size:4][type:4].
      const boxes: string[] = []
      if (description.mimeType.includes('mp4')) {
        const view = new DataView(bytes.buffer)
        let offset = 0
        while (offset + 8 <= bytes.length) {
          let size = view.getUint32(offset)
          const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
          if (size === 1) size = Number(view.getBigUint64(offset + 8))
          boxes.push(type)
          if (size < 8) break
          offset += size
        }
      }
      // The Matroska Cues element ID is 0x1C53BB6B.
      let hasCues = false
      for (let index = 0; index + 4 <= bytes.length; index += 1) {
        if (bytes[index] === 0x1c && bytes[index + 1] === 0x53 && bytes[index + 2] === 0xbb && bytes[index + 3] === 0x6b) {
          hasCues = true
          break
        }
      }

      await store.deleteRecording(id)
      return {
        format,
        container: description.mimeType,
        durationMs: description.durationMs,
        headerDurationMs: description.headerDurationMs,
        videoCodec: description.videoCodec,
        audioCodec: description.audioCodec,
        remuxed,
        warning,
        boxes,
        hasCues,
        recordedMs,
      }
    },
    { mode, seconds },
  )
}

test.describe('recorded files', () => {
  test.skip(DEPLOYED, "Loads the app's source modules, which only the dev server serves.")

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('WebCodecs capture becomes a standard MP4 with H.264 and audio', async ({ page }) => {
    const outcome = await record(page, 'mp4', 4)
    expect(outcome.format).toMatch(/^MP4 · H\.264/)
    expect(outcome.remuxed, outcome.warning ?? '').toBe(true)
    expect(outcome.container).toMatch(/video\/mp4/)
    expect(outcome.videoCodec).toBe('avc')
    expect(['aac', 'opus']).toContain(outcome.audioCodec)
    // A standard MP4: one index, no fragments left over from capture.
    expect(outcome.boxes).toContain('moov')
    expect(outcome.boxes).not.toContain('moof')
    expect(outcome.headerDurationMs).not.toBeNull()
    expect(Math.abs(outcome.durationMs - outcome.recordedMs)).toBeLessThan(1000)
  })

  test('MediaRecorder capture becomes a WebM with a duration and cues', async ({ page }) => {
    const outcome = await record(page, 'webm', 4)
    expect(outcome.format).toMatch(/WebM/)
    expect(outcome.remuxed, outcome.warning ?? '').toBe(true)
    expect(outcome.container).toMatch(/video\/webm/)
    expect(outcome.hasCues).toBe(true)
    expect(outcome.headerDurationMs).not.toBeNull()
    expect(Math.abs(outcome.durationMs - outcome.recordedMs)).toBeLessThan(1500)
  })

  test('a capture that never stops is recovered as a standard MP4', async ({ page }) => {
    const outcome = await record(page, 'crash', 4)
    expect(outcome.container).toMatch(/video\/mp4/)
    expect(outcome.boxes).toContain('moov')
    expect(outcome.boxes).not.toContain('moof')
    // Up to the fragment in progress is lost; the rest plays.
    expect(outcome.durationMs).toBeGreaterThan(2000)
    expect(outcome.videoCodec).toBe('avc')
  })
})
