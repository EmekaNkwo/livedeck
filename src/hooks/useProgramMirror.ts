import { useEffect, useState } from 'react'
import { compositor } from '@/services/composition/compositor'
import { audioMixer } from '@/services/audio/audio-mixer'
import { streamRegistry } from '@/services/media/stream-registry'
import {
  PROGRAM_TARGET,
  ProgramLinkPublisher,
  ProgramLinkSubscriber,
  type ProgramLinkState,
  type ProgramTarget,
} from '@/services/composition/program-link'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSourceStore } from '@/stores/sourceStore'

/**
 * The two ends of the mirror that feeds the scene and solo windows.
 *
 * See `services/composition/program-link.ts` for why this exists at all: a
 * `MediaStream` cannot cross a browsing context, so those windows have to be
 * *sent* their feed rather than rebuilding it.
 */

/**
 * Publish this window's program output, and any of its sources, to the mirror
 * windows open on this room.
 *
 * Mounted by the control room, not by a panel — a scene or solo window must
 * keep working while the operator is on the Mixer tab.
 */
export function useProgramPublisher(room: string | null): void {
  const frameRate = useSettingsStore((state) => state.settings.output.frameRate)
  const resolution = useSettingsStore((state) => state.settings.output.resolution)
  const aspectRatio = useSettingsStore((state) => state.settings.output.aspectRatio)

  /*
   * A fingerprint of which sources currently hold a capture.
   *
   * Drives the re-resolve below, so a solo window opened before its source was
   * started picks up the track the moment it exists — and loses it again when
   * the capture stops, instead of freezing on the last frame.
   */
  const liveStreamKeys = useSourceStore((state) =>
    Object.values(state.sources)
      .map((source) => `${source.id}:${source.streamKey ?? ''}`)
      .sort()
      .join('|'),
  )

  useEffect(() => {
    if (!room) return

    let programStream: MediaStream | null = null

    /**
     * Resolve a subscriber's target into a stream.
     *
     * Reads the source store directly rather than closing over a rendered
     * snapshot, because this is called from the publisher's message handler at
     * arbitrary times, not during a render.
     */
    const resolve = (target: ProgramTarget): MediaStream | null => {
      if (target === PROGRAM_TARGET) return programStream
      const source = useSourceStore.getState().sources[target]
      if (!source?.streamKey) return null
      // A reader, never an owner: the registry's refcount governs these tracks.
      return streamRegistry.getStream(source.streamKey)
    }

    const publisher = new ProgramLinkPublisher(room, resolve)
    publisher.start()

    let frame: number | null = null

    /**
     * Attach the program capture once the compositor owns a canvas.
     *
     * The canvas is attached by `ProgramCanvas` on its own schedule, which may
     * be after this effect runs, so this retries on animation frames instead
     * of assuming it is ready. A mirror window that opened first is already
     * saying hello on a timer, so there is no race to lose.
     */
    const attach = () => {
      const canvas = compositor.getCanvas()
      if (!canvas) {
        frame = requestAnimationFrame(attach)
        return
      }
      try {
        programStream = canvas.captureStream(frameRate)
        for (const track of audioMixer.getProgramStream()?.getAudioTracks() ?? []) {
          programStream.addTrack(track)
        }
        publisher.refresh()
      } catch {
        // Capture unsupported in this browser: the scene window falls back to
        // its own compositor and says so, rather than showing nothing.
      }
    }

    attach()

    // Re-resolve when a capture starts or stops.
    publisher.refresh()

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      publisher.stop()
      // The program video track was created here, so stopping it is this
      // effect's job. Audio and source tracks belong elsewhere.
      for (const track of programStream?.getVideoTracks() ?? []) track.stop()
    }
    // The output settings rebuild the capture, because the frame rate is baked
    // into `captureStream` and the canvas is resized by the other two.
  }, [room, frameRate, resolution, aspectRatio, liveStreamKeys])
}

export type ProgramMirror = {
  stream: MediaStream | null
  state: ProgramLinkState
}

/**
 * Receive a feed from a control room on this room.
 *
 * `target` is `'program'` for the composed output, or a source id for a solo
 * feed. `state` is reported honestly so the view can distinguish "no control
 * room is open" from "connecting" from "live" — a permanently black window
 * gave the operator nothing to act on.
 */
export function useProgramMirror(
  room: string | null,
  target: ProgramTarget = PROGRAM_TARGET,
): ProgramMirror {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [state, setState] = useState<ProgramLinkState>('waiting')

  useEffect(() => {
    if (!room) return

    // `setStream`/`setState` are stable for the life of the component, so the
    // subscriber is built exactly once per room and target.
    const subscriber = new ProgramLinkSubscriber(
      room,
      { onStream: setStream, onState: setState },
      target,
    )
    subscriber.start()

    return () => {
      subscriber.stop()
      setStream(null)
    }
  }, [room, target])

  return { stream, state }
}
