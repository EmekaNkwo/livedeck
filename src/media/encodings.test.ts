import { describe, expect, it } from 'vitest'
import { applyContentHint, encodingFor } from './encodings'

describe('encodingFor', () => {
  it('sends the camera as three simulcast layers with motion hint', () => {
    const camera = encodingFor('camera')
    expect(camera.encodings.map((e) => e.rid)).toEqual(['q', 'h', 'f'])
    expect(camera.contentHint).toBe('motion')
    const bitrates = camera.encodings.map((e) => e.maxBitrate ?? 0)
    expect(bitrates).toEqual([...bitrates].sort((a, b) => a - b))
  })

  it('sends a screen as one sharp, low-rate layer', () => {
    const screen = encodingFor('screen')
    expect(screen.encodings).toHaveLength(1)
    expect(screen.contentHint).toBe('detail')
    expect(screen.encodings[0]?.maxFramerate).toBeLessThanOrEqual(15)
  })

  it('uses DTX only for microphones, stereo only for non-mic audio', () => {
    expect(encodingFor('mic').codecOptions).toMatchObject({ opusDtx: true, opusStereo: false })
    expect(encodingFor('screen-audio').codecOptions).toMatchObject({ opusDtx: false, opusStereo: true })
    expect(encodingFor('program-audio').codecOptions).toMatchObject({ opusStereo: true })
  })

  it('program video has a higher ceiling than a camera', () => {
    expect(encodingFor('program').maxBitrateBps).toBeGreaterThan(encodingFor('camera').maxBitrateBps)
  })
})

describe('applyContentHint', () => {
  it('sets the hint when the track exposes it and tolerates read-only tracks', () => {
    const track = { contentHint: '' } as MediaStreamTrack
    applyContentHint(track, 'detail')
    expect(track.contentHint).toBe('detail')
    const frozen = Object.freeze({ contentHint: '' }) as MediaStreamTrack
    expect(() => applyContentHint(frozen, 'motion')).not.toThrow()
    applyContentHint(track, undefined)
    expect(track.contentHint).toBe('detail')
  })
})
