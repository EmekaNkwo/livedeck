import { useEffect, useState } from 'react'
import { compositor } from '@/services/composition/compositor'
import { audioMixer } from '@/services/audio/audio-mixer'
import {
  ProgramLinkPublisher,
  ProgramLinkSubscriber,
  type ProgramLinkState,
} from '@/services/composition/program-link'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * The two ends of the scene-window mirror.
 *
 * See `services/composition/program-link.ts` for why this exists at all: a
 * `MediaStream` cannot cross a browsing context, so the scene window has to be
 * *sent* the program rather than rebuilding it.
 */

/**
 * Publish this window's program output to any scene window on the same room.
 *
 * Mounted by the control room, not by a panel — a scene window must keep
 * working while the operator is on the Mixer tab.
 */
export function useProgramPublisher(room: string | null): void {
  const frameRate = useSettingsStore((state) => state.settings.output.frameRate)
  const resolution = useSettingsStore((state) => state.settings.output.resolution)
  const aspectRatio = useSettingsStore((state) => state.settings.output.aspectRatio)

  useEffect(() => {
    if (!room) return

    const publisher = new ProgramLinkPublisher(room)
    publisher.start()

    let stream: MediaStream | null = null
    let frame: number | null = null

    /**
     * Attach the program capture once the compositor owns a canvas.
     *
     * The canvas is attached by `ProgramCanvas` on its own schedule, which may
     * be after this effect runs, so this retries on animation frames instead
     * of assuming it is ready. A scene window that opened first is already
     * saying hello on a timer, so there is no race to lose.
     */
    const attach = () => {
      const canvas = compositor.getCanvas()
      if (!canvas) {
        frame = requestAnimationFrame(attach)
        return
      }
      try {
        stream = canvas.captureStream(frameRate)
        for (const track of audioMixer.getProgramStream()?.getAudioTracks() ?? []) {
          stream.addTrack(track)
        }
        publisher.setStream(stream)
      } catch {
        // Capture unsupported in this browser: the scene window falls back to
        // its own compositor and says so, rather than showing nothing.
      }
    }

    attach()

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      publisher.stop()
      // The video track was created here, so stopping it is this effect's
      // job. Audio tracks belong to the mixer and are left alone.
      for (const track of stream?.getVideoTracks() ?? []) track.stop()
    }
    // The output settings rebuild the capture, because the frame rate is baked
    // into `captureStream` and the canvas is resized by the other two.
  }, [room, frameRate, resolution, aspectRatio])
}

export type ProgramMirror = {
  stream: MediaStream | null
  state: ProgramLinkState
}

/**
 * Receive the program output from a director window on this room.
 *
 * `state` is reported honestly so the view can distinguish "no control room is
 * open" from "connecting" from "live" — the previous behaviour, a permanently
 * black canvas, gave the operator nothing to act on.
 */
export function useProgramMirror(room: string | null): ProgramMirror {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [state, setState] = useState<ProgramLinkState>('waiting')

  useEffect(() => {
    if (!room) return

    // `setStream`/`setState` are stable for the life of the component, so the
    // subscriber is built exactly once per room without latching them in refs.
    const subscriber = new ProgramLinkSubscriber(room, {
      onStream: setStream,
      onState: setState,
    })
    subscriber.start()

    return () => {
      subscriber.stop()
      setStream(null)
    }
  }, [room])

  return { stream, state }
}
