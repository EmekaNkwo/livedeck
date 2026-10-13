/**
 * Synthetic media for Local Studio Mode.
 *
 * Demo guests need real MediaStreams — not placeholder `<div>`s — so that they
 * flow through the identical code path as a real peer: the stream registry,
 * the compositor, the audio mixer and the recorder all treat them as ordinary
 * sources. That is what makes the demo exercise the actual pipeline.
 *
 * Every stream produced here is tagged, and the UI labels these guests as
 * simulated so a reviewer is never misled into thinking a remote participant
 * is connected.
 */

export type SyntheticVideoOptions = {
  label: string
  width: number
  height: number
  frameRate: number
  /** Base hue in degrees; each guest gets a distinct colour. */
  hue: number
}

export type SyntheticStream = {
  stream: MediaStream
  /** Stops the generator loop and releases the backing nodes. */
  stop: () => void
}

/**
 * Generate an animated video track from a canvas.
 *
 * `canvas.captureStream(fps)` gives a genuine video track, so this is real
 * media the browser encodes like any other — it just happens to be drawn by us
 * rather than decoded from a camera.
 */
export function createSyntheticVideoStream(options: SyntheticVideoOptions): SyntheticStream {
  const canvas = document.createElement('canvas')
  canvas.width = options.width
  canvas.height = options.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D is unavailable, so simulated guest video cannot be generated.')
  }

  const stream = canvas.captureStream(options.frameRate)
  let frame = 0
  let rafId = 0
  let stopped = false
  const startedAt = performance.now()

  const draw = () => {
    if (stopped) return
    frame += 1
    const elapsed = (performance.now() - startedAt) / 1000
    paintFrame(ctx, canvas, options, elapsed, frame)
    rafId = requestAnimationFrame(draw)
  }
  rafId = requestAnimationFrame(draw)

  return {
    stream,
    stop: () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(rafId)
      for (const track of stream.getTracks()) track.stop()
    },
  }
}

function paintFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  options: SyntheticVideoOptions,
  elapsed: number,
  frame: number,
): void {
  const { width, height } = canvas
  const { hue } = options

  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `hsl(${hue} 55% 22%)`)
  gradient.addColorStop(1, `hsl(${(hue + 40) % 360} 60% 12%)`)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  // A moving element proves the track is live rather than a frozen image.
  const orbitRadius = Math.min(width, height) * 0.22
  const cx = width / 2 + Math.cos(elapsed * 0.9) * orbitRadius
  const cy = height / 2 + Math.sin(elapsed * 1.3) * orbitRadius * 0.6
  const blobRadius = Math.min(width, height) * (0.17 + Math.sin(elapsed * 2) * 0.015)

  ctx.save()
  ctx.globalAlpha = 0.9
  const blob = ctx.createRadialGradient(cx, cy, 0, cx, cy, blobRadius)
  blob.addColorStop(0, `hsl(${(hue + 20) % 360} 90% 70%)`)
  blob.addColorStop(1, `hsl(${(hue + 20) % 360} 90% 70% / 0)`)
  ctx.fillStyle = blob
  ctx.beginPath()
  ctx.arc(cx, cy, blobRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // Guest name.
  const fontSize = Math.round(height * 0.1)
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.94)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(options.label, width / 2, height / 2)

  // "SIMULATED" watermark — burned into the pixels so it is unmistakable even
  // in a downloaded recording, not just in the UI chrome.
  const badgeFont = Math.round(height * 0.05)
  ctx.font = `700 ${badgeFont}px system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText('SIMULATED FEED', width * 0.04, height * 0.04)

  // Frame counter and clock, so a reviewer can confirm real frame delivery.
  ctx.font = `500 ${Math.round(height * 0.042)}px ui-monospace, monospace`
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText(
    `${elapsed.toFixed(1)}s · f${frame}`,
    width * 0.96,
    height * 0.96,
  )
}

export type SyntheticAudioOptions = {
  /** Carrier frequency in Hz. Each guest gets a different note. */
  frequency: number
  /** Peak amplitude, 0..1. Kept low — this plays into the recording. */
  amplitude: number
  context: AudioContext
}

/**
 * Generate a gently pulsing tone as a stand-in for guest speech.
 *
 * The amplitude is modulated so the mixer's level meters show believable
 * movement rather than a flat line, which is what makes the demo meters
 * meaningful. Output goes only to a MediaStream destination — never to the
 * speakers — so enabling a demo guest cannot create a feedback loop.
 */
export function createSyntheticAudioStream(options: SyntheticAudioOptions): SyntheticStream {
  const { context } = options
  const destination = context.createMediaStreamDestination()

  const carrier = context.createOscillator()
  carrier.type = 'sine'
  carrier.frequency.value = options.frequency

  // Second oscillator a fifth up, quieter, to make the tone less sterile.
  const harmonic = context.createOscillator()
  harmonic.type = 'triangle'
  harmonic.frequency.value = options.frequency * 1.5

  const harmonicGain = context.createGain()
  harmonicGain.gain.value = 0.25

  // Slow LFO on the output gain: speech-like envelope for the meters.
  const lfo = context.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.6
  const lfoDepth = context.createGain()
  lfoDepth.gain.value = options.amplitude * 0.5

  const output = context.createGain()
  output.gain.value = options.amplitude * 0.5

  carrier.connect(output)
  harmonic.connect(harmonicGain).connect(output)
  lfo.connect(lfoDepth).connect(output.gain)
  output.connect(destination)

  carrier.start()
  harmonic.start()
  lfo.start()

  let stopped = false
  return {
    stream: destination.stream,
    stop: () => {
      if (stopped) return
      stopped = true
      for (const node of [carrier, harmonic, lfo]) {
        try {
          node.stop()
        } catch {
          // Already stopped; teardown must not throw.
        }
        node.disconnect()
      }
      harmonicGain.disconnect()
      lfoDepth.disconnect()
      output.disconnect()
      destination.disconnect()
      for (const track of destination.stream.getTracks()) track.stop()
    },
  }
}

/**
 * Build a complete simulated guest feed: animated video plus a tone.
 * Returns a single MediaStream carrying both tracks, exactly like a real peer
 * stream would, plus a `stop` that tears down both generators.
 */
export function createSyntheticGuestStream(params: {
  label: string
  index: number
  width: number
  height: number
  frameRate: number
  audioContext: AudioContext | null
}): SyntheticStream {
  const hue = (140 + params.index * 67) % 360
  const video = createSyntheticVideoStream({
    label: params.label,
    width: params.width,
    height: params.height,
    frameRate: params.frameRate,
    hue,
  })

  const combined = new MediaStream(video.stream.getVideoTracks())
  let audio: SyntheticStream | null = null

  if (params.audioContext) {
    // Pentatonic-ish spread so several guests together are not dissonant.
    const notes = [196, 233, 262, 311, 349, 415]
    const frequency = notes[params.index % notes.length] ?? 220
    audio = createSyntheticAudioStream({
      frequency,
      amplitude: 0.18,
      context: params.audioContext,
    })
    for (const track of audio.stream.getAudioTracks()) combined.addTrack(track)
  }

  return {
    stream: combined,
    stop: () => {
      video.stop()
      audio?.stop()
    },
  }
}
