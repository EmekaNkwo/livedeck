import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeStream } from '@/test/setup'

/**
 * The capture module's own logic: the encodability probe and the guard that
 * stored bytes are only ever appended. The muxer is a double that records
 * how it was configured and lets a test push writes through its target.
 */

const mb = vi.hoisted(() => ({
  canEncodeVideo: vi.fn(),
  getFirstEncodableAudioCodec: vi.fn(),
  outputs: [] as Array<{ options: { format: unknown; target: { writable: WritableStream } }; video: unknown; audio: unknown }>,
  sources: [] as Array<{ kind: string; config: Record<string, unknown>; paused: boolean; rejectWith: (error: Error) => void }>,
}))

vi.mock('mediabunny', () => {
  class Source {
    kind: string
    config: Record<string, unknown>
    paused = false
    errorPromise: Promise<void>
    rejectWith: (error: Error) => void = () => undefined
    constructor(kind: string, config: Record<string, unknown>) {
      this.kind = kind
      this.config = config
      this.errorPromise = new Promise<void>((_resolve, reject) => {
        this.rejectWith = reject
      })
      mb.sources.push(this)
    }
    pause() {
      this.paused = true
    }
    resume() {
      this.paused = false
    }
  }
  return {
    canEncodeVideo: mb.canEncodeVideo,
    getFirstEncodableAudioCodec: mb.getFirstEncodableAudioCodec,
    Mp4OutputFormat: class {
      options: unknown
      constructor(options: unknown) {
        this.options = options
      }
    },
    StreamTarget: class {
      writable: WritableStream
      constructor(writable: WritableStream) {
        this.writable = writable
      }
    },
    MediaStreamVideoTrackSource: class extends Source {
      constructor(_track: unknown, config: Record<string, unknown>) {
        super('video', config)
      }
    },
    MediaStreamAudioTrackSource: class extends Source {
      constructor(_track: unknown, config: Record<string, unknown>) {
        super('audio', config)
      }
    },
    Output: class {
      entry: (typeof mb.outputs)[number]
      constructor(options: (typeof mb.outputs)[number]['options']) {
        this.entry = { options, video: null, audio: null }
        mb.outputs.push(this.entry)
      }
      addVideoTrack(source: unknown) {
        this.entry.video = source
      }
      addAudioTrack(source: unknown) {
        this.entry.audio = source
      }
      start = vi.fn(async () => undefined)
      finalize = vi.fn(async () => undefined)
      cancel = vi.fn(async () => undefined)
    },
  }
})

import { Mp4Capture, hasWebCodecs, planMp4Capture } from './mp4-capture'

beforeEach(() => {
  vi.unstubAllGlobals()
  mb.canEncodeVideo.mockReset()
  mb.getFirstEncodableAudioCodec.mockReset()
  mb.outputs.length = 0
  mb.sources.length = 0
})

const withWebCodecs = () => {
  vi.stubGlobal('VideoEncoder', class {})
  vi.stubGlobal('AudioEncoder', class {})
}

describe('planMp4Capture', () => {
  it('declines without WebCodecs', async () => {
    expect(hasWebCodecs()).toBe(false)
    expect(await planMp4Capture(1280, 720, 30, 2_000_000, true)).toBeNull()
    expect(mb.canEncodeVideo).not.toHaveBeenCalled()
  })

  it('declines when H.264 cannot be encoded at this size', async () => {
    withWebCodecs()
    mb.canEncodeVideo.mockResolvedValue(false)
    expect(await planMp4Capture(3840, 2160, 60, 12_000_000, true)).toBeNull()
    expect(mb.canEncodeVideo).toHaveBeenCalledWith('avc', { width: 3840, height: 2160, frameRate: 60, bitrate: 12_000_000 })
  })

  it('prefers AAC, accepts Opus, and needs no audio codec for silent video', async () => {
    withWebCodecs()
    mb.canEncodeVideo.mockResolvedValue(true)
    mb.getFirstEncodableAudioCodec.mockResolvedValueOnce('opus')
    expect(await planMp4Capture(1280, 720, 30, 2_000_000, true)).toEqual({ audioCodec: 'opus' })
    expect(mb.getFirstEncodableAudioCodec.mock.calls[0]?.[0]).toEqual(['aac', 'opus'])
    expect(await planMp4Capture(1280, 720, 30, 2_000_000, false)).toEqual({ audioCodec: null })
  })

  it('declines when no audio codec is available, or the probe throws', async () => {
    withWebCodecs()
    mb.canEncodeVideo.mockResolvedValue(true)
    mb.getFirstEncodableAudioCodec.mockResolvedValue(null)
    expect(await planMp4Capture(1280, 720, 30, 2_000_000, true)).toBeNull()
    mb.canEncodeVideo.mockRejectedValue(new Error('probe failed'))
    expect(await planMp4Capture(1280, 720, 30, 2_000_000, true)).toBeNull()
  })
})

describe('Mp4Capture', () => {
  const tracks = () => {
    const stream = createFakeStream(['video', 'audio'])
    return { video: stream.getVideoTracks()[0] as MediaStreamVideoTrack, audio: stream.getAudioTracks()[0] as MediaStreamAudioTrack }
  }

  const begin = async (audioCodec: 'aac' | null = 'aac') => {
    const received: string[] = []
    const failures: string[] = []
    const { video, audio } = tracks()
    const capture = await Mp4Capture.start({
      video,
      audio,
      plan: { audioCodec },
      frameRate: 30,
      videoBitrate: 3_000_000,
      onData: (blob) => void blob.text().then((text) => received.push(text)),
      onError: (error) => failures.push(error.message),
    })
    const writer = mb.outputs[0]?.options.target.writable.getWriter() as WritableStreamDefaultWriter
    return { capture, received, failures, writer }
  }

  it('configures fragmented MP4 with H.264 at the requested bitrate', async () => {
    await begin()
    const format = mb.outputs[0]?.options.format as { options: Record<string, unknown> }
    expect(format.options).toMatchObject({ fastStart: 'fragmented', minimumFragmentDuration: 1 })
    expect(mb.sources[0]).toMatchObject({ kind: 'video', config: { codec: 'avc', bitrate: 3_000_000, keyFrameInterval: 2 } })
    expect(mb.sources[1]).toMatchObject({ kind: 'audio', config: { codec: 'aac' } })
  })

  it('adds no audio track when the plan has no audio codec', async () => {
    await begin(null)
    expect(mb.outputs[0]?.audio).toBeNull()
    expect(mb.sources).toHaveLength(1)
  })

  it('passes appended bytes on and counts them', async () => {
    const { capture, received, writer } = await begin()
    await writer.write({ type: 'write', data: new TextEncoder().encode('ftyp'), position: 0 })
    await writer.write({ type: 'write', data: new TextEncoder().encode('moof'), position: 4 })
    await Promise.resolve()
    expect(received).toEqual(['ftyp', 'moof'])
    expect(capture.bytesWritten).toBe(8)
  })

  it('refuses a write that goes back into the file', async () => {
    const { writer } = await begin()
    await writer.write({ type: 'write', data: new Uint8Array(4), position: 0 })
    await expect(writer.write({ type: 'write', data: new Uint8Array(2), position: 1 })).rejects.toThrow(/Unexpected write at 1/)
  })

  it('pauses and resumes both sources', async () => {
    const { capture } = await begin()
    capture.pause()
    expect(mb.sources.every((source) => source.paused)).toBe(true)
    capture.resume()
    expect(mb.sources.some((source) => source.paused)).toBe(false)
  })

  it('reports the first encoder error once', async () => {
    const { failures } = await begin()
    mb.sources[0]?.rejectWith(new Error('EncodingError'))
    mb.sources[1]?.rejectWith(new Error('second'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failures).toEqual(['EncodingError'])
  })

  it('stays quiet about errors after it was cancelled', async () => {
    const { capture, failures } = await begin()
    await capture.cancel()
    mb.sources[0]?.rejectWith(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failures).toEqual([])
  })
})
