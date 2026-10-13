import { useEffect, useState } from 'react'
import { meterBus } from '@/services/audio/meter-bus'

/**
 * Whether a mixer channel is currently carrying speech.
 *
 * A participant-level signal rather than a measurement. A dB meter answers
 * "how loud", which is what you want while setting up; mid-production the
 * question is "who is talking", and that wants a glance, not a reading.
 *
 * WHY A THRESHOLD AND A HOLD
 * --------------------------
 * Speech is not continuous — it has gaps between words and syllables, and a
 * bare `level > threshold` test flickers through every one of them. The hold
 * keeps the indicator on across short gaps, which is what makes it readable
 * instead of strobing.
 *
 * The whole thing lives in an effect, not in render: the hold needs a
 * timestamp and the level is external state, and reading either during render
 * would be impure — unstable under StrictMode's double invocation and wrong
 * under concurrent rendering.
 */

/**
 * RMS above which a channel counts as speaking.
 *
 * Deliberately above room noise: a microphone in a quiet room still reports a
 * small nonzero level, and treating that as speech would light up every
 * participant permanently.
 */
const SPEAKING_RMS = 0.02

/** How long the indicator stays on after the level drops, in ms. */
const HOLD_MS = 400

/** Sampling interval. Fast enough to feel immediate, cheap enough to render. */
const SAMPLE_MS = 150

/**
 * Pass `null` to report silence.
 *
 * Used for a muted or stopped microphone, where "not audible" is the honest
 * answer regardless of what the pre-fader meter still reads.
 */
export function useIsSpeaking(channelId: string | null): boolean {
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    // No channel means nothing to poll. The return below reports silence
    // without a state write, so there is no render just to clear a flag — and
    // no window where a stale `true` outlives the channel it belonged to.
    if (!channelId) return

    let lastLoudAt = 0

    const sample = () => {
      const level = meterBus.get(channelId)
      const now = performance.now()
      if (level.rms >= SPEAKING_RMS) lastLoudAt = now
      // React bails out when the value is unchanged, so a silent channel
      // costs no renders at all despite the timer running.
      setSpeaking(now - lastLoudAt < HOLD_MS)
    }

    sample()
    // Polled rather than subscribed: the bus publishes ~20 times a second and
    // this drives two states, so taking every update would be wasted work.
    const timer = setInterval(sample, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [channelId])

  return channelId ? speaking : false
}
