import { describe, expect, it } from 'vitest'
import {
  PARAMETER_DOCS,
  buildParameterQuery,
  parseUrlParameters,
} from './url-parameters'

/**
 * URL parameters.
 *
 * The behaviours that matter: bare flags work (that is how people write them),
 * aliases work, bad values are rejected rather than coerced into something
 * surprising, and unknown keys are *reported* so a typo surfaces.
 */

describe('flags', () => {
  it('treats a bare flag as true — the form people actually write', () => {
    expect(parseUrlParameters('?muted').startMuted).toBe(true)
    expect(parseUrlParameters('?novideo').noVideo).toBe(true)
    expect(parseUrlParameters('?noaudio').noAudio).toBe(true)
    expect(parseUrlParameters('?mirror').mirror).toBe(true)
    expect(parseUrlParameters('?autostart').autoStart).toBe(true)
    expect(parseUrlParameters('?cleanoutput').cleanOutput).toBe(true)
  })

  it('honours explicit truthy and falsy values', () => {
    expect(parseUrlParameters('?muted=true').startMuted).toBe(true)
    expect(parseUrlParameters('?muted=1').startMuted).toBe(true)
    expect(parseUrlParameters('?muted=yes').startMuted).toBe(true)
    expect(parseUrlParameters('?muted=false').startMuted).toBe(false)
    expect(parseUrlParameters('?muted=0').startMuted).toBe(false)
    expect(parseUrlParameters('?muted=no').startMuted).toBe(false)
  })

  it('defaults flags to false when absent', () => {
    const parsed = parseUrlParameters('')
    expect(parsed.startMuted).toBe(false)
    expect(parsed.noVideo).toBe(false)
    expect(parsed.cleanOutput).toBe(false)
  })

  it('accepts documented aliases', () => {
    expect(parseUrlParameters('?mute').startMuted).toBe(true)
    expect(parseUrlParameters('?clean').cleanOutput).toBe(true)
    expect(parseUrlParameters('?autojoin').autoStart).toBe(true)
  })
})

describe('label', () => {
  it('reads label and its alias', () => {
    expect(parseUrlParameters('?label=Ana').label).toBe('Ana')
    expect(parseUrlParameters('?name=Ana').label).toBe('Ana')
  })

  it('trims and bounds the length', () => {
    expect(parseUrlParameters('?label=%20%20Ana%20%20').label).toBe('Ana')
    const long = parseUrlParameters(`?label=${'x'.repeat(200)}`).label
    expect(long?.length).toBe(60)
  })

  it('is null when blank', () => {
    expect(parseUrlParameters('?label=').label).toBeNull()
    expect(parseUrlParameters('?label=%20').label).toBeNull()
    expect(parseUrlParameters('').label).toBeNull()
  })

  it('handles a label containing spaces and punctuation', () => {
    expect(parseUrlParameters('?label=Ana%20L%C3%B3pez').label).toBe('Ana López')
  })
})

describe('quality', () => {
  it('accepts bare numbers and the p suffix', () => {
    expect(parseUrlParameters('?quality=720').quality).toBe('720p')
    expect(parseUrlParameters('?quality=720p').quality).toBe('720p')
    expect(parseUrlParameters('?quality=1080').quality).toBe('1080p')
    expect(parseUrlParameters('?quality=480').quality).toBe('480p')
  })

  it('rejects an unsupported value rather than guessing', () => {
    // Silently rounding 4K down to 1080p would promise something untrue.
    expect(parseUrlParameters('?quality=4000').quality).toBeNull()
    expect(parseUrlParameters('?quality=high').quality).toBeNull()
    expect(parseUrlParameters('?quality=').quality).toBeNull()
  })
})

describe('fps', () => {
  it('accepts the supported rates and its alias', () => {
    expect(parseUrlParameters('?fps=24').fps).toBe(24)
    expect(parseUrlParameters('?fps=30').fps).toBe(30)
    expect(parseUrlParameters('?framerate=60').fps).toBe(60)
  })

  it('rejects unsupported rates', () => {
    expect(parseUrlParameters('?fps=25').fps).toBeNull()
    expect(parseUrlParameters('?fps=120').fps).toBeNull()
    expect(parseUrlParameters('?fps=abc').fps).toBeNull()
  })
})

describe('ratio', () => {
  it('accepts every supported ratio', () => {
    expect(parseUrlParameters('?ratio=16:9').ratio).toBe('16:9')
    expect(parseUrlParameters('?ratio=9:16').ratio).toBe('9:16')
    expect(parseUrlParameters('?ratio=1:1').ratio).toBe('1:1')
    expect(parseUrlParameters('?aspect=4:3').ratio).toBe('4:3')
  })

  it('tolerates alternative separators that survive URL mangling', () => {
    // A colon is legal in a query value but often gets escaped by hand, so x
    // and - are accepted too.
    expect(parseUrlParameters('?ratio=16x9').ratio).toBe('16:9')
    expect(parseUrlParameters('?ratio=16-9').ratio).toBe('16:9')
  })

  it('rejects an unsupported ratio', () => {
    expect(parseUrlParameters('?ratio=21:9').ratio).toBeNull()
    expect(parseUrlParameters('?ratio=wide').ratio).toBeNull()
  })
})

describe('scene', () => {
  it('accepts a non-negative integer index', () => {
    expect(parseUrlParameters('?scene=0').scene).toBe(0)
    expect(parseUrlParameters('?scene=3').scene).toBe(3)
  })

  it('rejects negatives and non-integers', () => {
    expect(parseUrlParameters('?scene=-1').scene).toBeNull()
    expect(parseUrlParameters('?scene=1.5').scene).toBeNull()
    expect(parseUrlParameters('?scene=first').scene).toBeNull()
  })
})

describe('unknown keys', () => {
  it('reports a key this build does not understand', () => {
    // Surfacing a typo beats silently doing nothing.
    expect(parseUrlParameters('?qualiti=720').unknown).toEqual(['qualiti'])
  })

  it('reports nothing when every key is known', () => {
    expect(parseUrlParameters('?label=Ana&muted&quality=720&fps=30').unknown).toEqual([])
  })

  it('de-duplicates a repeated unknown key', () => {
    expect(parseUrlParameters('?nope=1&nope=2').unknown).toEqual(['nope'])
  })

  it('does not treat a known key as unknown because of its case', () => {
    expect(parseUrlParameters('?Quality=720').unknown).toEqual([])
  })
})

describe('parsing robustness', () => {
  it('accepts a search string with or without the leading question mark', () => {
    expect(parseUrlParameters('label=Ana').label).toBe('Ana')
    expect(parseUrlParameters('?label=Ana').label).toBe('Ana')
  })

  it('returns defaults for empty input', () => {
    const parsed = parseUrlParameters('')
    expect(parsed.label).toBeNull()
    expect(parsed.quality).toBeNull()
    expect(parsed.unknown).toEqual([])
  })

  it('reads several parameters together', () => {
    const parsed = parseUrlParameters('?label=Ana&muted&novideo&quality=1080&fps=60&ratio=9:16')
    expect(parsed).toMatchObject({
      label: 'Ana',
      startMuted: true,
      noVideo: true,
      quality: '1080p',
      fps: 60,
      ratio: '9:16',
    })
  })
})

describe('buildParameterQuery', () => {
  it('writes flags bare, matching the documented convention', () => {
    const query = buildParameterQuery({ startMuted: true, noVideo: true })
    expect(query.muted).toBe('')
    expect(query.novideo).toBe('')
  })

  it('omits anything not set', () => {
    expect(buildParameterQuery({})).toEqual({})
    expect(buildParameterQuery({ startMuted: false, label: null })).toEqual({})
  })

  it('strips the p from a resolution so it round-trips', () => {
    const query = buildParameterQuery({ quality: '720p' })
    expect(query.quality).toBe('720')
    expect(parseUrlParameters(`?quality=${query.quality}`).quality).toBe('720p')
  })

  it('round-trips a full option set through the parser', () => {
    const query = buildParameterQuery({
      label: 'Ana',
      startMuted: true,
      noAudio: true,
      quality: '1080p',
      fps: 24,
    })
    const search = new URLSearchParams(query).toString()
    const parsed = parseUrlParameters(`?${search}`)

    expect(parsed.label).toBe('Ana')
    expect(parsed.startMuted).toBe(true)
    expect(parsed.noAudio).toBe(true)
    expect(parsed.quality).toBe('1080p')
    expect(parsed.fps).toBe(24)
    expect(parsed.unknown).toEqual([])
  })
})

describe('documentation', () => {
  it('documents every key the parser recognises', () => {
    // The cheat sheet is generated from this list, so a parameter cannot be
    // implemented without being documented.
    const documented = new Set(PARAMETER_DOCS.flatMap((doc) => doc.keys))
    for (const key of [
      'label',
      'name',
      'muted',
      'mute',
      'novideo',
      'noaudio',
      'quality',
      'fps',
      'framerate',
      'ratio',
      'aspect',
      'cleanoutput',
      'clean',
      'mirror',
      'autostart',
      'autojoin',
      'scene',
    ]) {
      expect(documented.has(key)).toBe(true)
    }
  })

  it('every documented key is actually accepted by the parser', () => {
    for (const doc of PARAMETER_DOCS) {
      for (const key of doc.keys) {
        expect(parseUrlParameters(`?${key}=1`).unknown).toEqual([])
      }
    }
  })
})
