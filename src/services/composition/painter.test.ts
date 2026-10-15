import { describe, expect, it } from 'vitest'
import { paintPlan, wrapText, type Ctx2D, type PaintLayer, type PaintPlan } from './painter'

/** A 2D context double that records what was drawn, with the alpha at the time. */
function recorder() {
  const calls: Array<{ method: string; args: unknown[]; alpha: number; fill: string }> = []
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as Record<string, unknown>
  for (const method of ['save', 'restore', 'translate', 'rotate', 'scale', 'fillRect', 'drawImage', 'fillText']) {
    ctx[method] = (...args: unknown[]) => {
      calls.push({ method, args, alpha: ctx.globalAlpha as number, fill: String(ctx.fillStyle) })
    }
  }
  return { ctx: ctx as unknown as Ctx2D, calls, of: (method: string) => calls.filter((call) => call.method === method) }
}

const box = { x: 10, y: 20, width: 100, height: 50, rotation: 0, mirrored: false }
const plan = (overrides: Partial<PaintPlan> = {}): PaintPlan => ({
  width: 1280,
  height: 720,
  background: '#000000',
  current: [],
  outgoing: null,
  transition: null,
  ...overrides,
})
const image = {} as CanvasImageSource
const noScratch = () => null

describe('paintPlan', () => {
  it('fills the background, then draws layers in order', () => {
    const { ctx, calls } = recorder()
    const layers: PaintLayer[] = [
      { kind: 'fill', color: '#ff0000', alpha: 1, box },
      { kind: 'image', key: 'cam', crop: { x: 0, y: 0, width: 640, height: 360 }, alpha: 0.5, box },
    ]
    paintPlan(ctx, plan({ current: layers }), (key) => (key === 'cam' ? image : null), noScratch)

    const draws = calls.filter((call) => call.method === 'fillRect' || call.method === 'drawImage')
    expect(draws.map((call) => [call.method, call.fill])).toEqual([
      ['fillRect', '#000000'],
      ['fillRect', '#ff0000'],
      ['drawImage', '#ff0000'],
    ])
    // Crop maps the source sub-rectangle onto the box.
    expect(draws[2]?.args).toEqual([image, 0, 0, 640, 360, 10, 20, 100, 50])
    expect(draws[2]?.alpha).toBe(0.5)
  })

  it('turns and mirrors a layer about its centre', () => {
    const { ctx, of } = recorder()
    paintPlan(ctx, plan({ current: [{ kind: 'fill', color: '#fff', alpha: 1, box: { ...box, rotation: 90, mirrored: true } }] }), () => null, noScratch)
    expect(of('translate').map((call) => call.args)).toEqual([[60, 45], [-60, -45]])
    expect(of('rotate')[0]?.args[0]).toBeCloseTo(Math.PI / 2)
    expect(of('scale')[0]?.args).toEqual([-1, 1])
  })

  it('skips invisible or empty layers and images that are not available', () => {
    const { ctx, of } = recorder()
    paintPlan(
      ctx,
      plan({
        current: [
          { kind: 'fill', color: '#f00', alpha: 0, box },
          { kind: 'fill', color: '#f00', alpha: 1, box: { ...box, width: 0 } },
          { kind: 'image', key: 'missing', crop: box, alpha: 1, box },
        ],
      }),
      () => null,
      noScratch,
    )
    expect(of('fillRect')).toHaveLength(1)
    expect(of('drawImage')).toHaveLength(0)
  })

  it('keeps painting when one layer throws', () => {
    const { ctx, of } = recorder()
    const throwing = ctx as unknown as Record<string, unknown>
    throwing.drawImage = () => {
      throw new Error('InvalidStateError')
    }
    paintPlan(
      ctx,
      plan({
        current: [
          { kind: 'image', key: 'cam', crop: box, alpha: 1, box },
          { kind: 'fill', color: '#0f0', alpha: 1, box },
        ],
      }),
      () => image,
      noScratch,
    )
    expect(of('fillRect').map((call) => call.fill)).toEqual(['#000000', '#0f0'])
    expect(of('restore').length).toBe(of('save').length)
  })

  it('lays out text with its style, centred and wrapped', () => {
    const { ctx, of } = recorder()
    paintPlan(
      ctx,
      plan({
        current: [
          {
            kind: 'text',
            text: 'one two three',
            style: { fontSize: 10, fontFamily: 'system-ui', color: '#fff', backgroundColor: '#123', align: 'center', bold: true },
            alpha: 1,
            box: { ...box, width: 100 },
          },
        ],
      }),
      () => null,
      noScratch,
    )
    expect(of('fillRect').map((call) => call.fill)).toEqual(['#000000', '#123'])
    const texts = of('fillText')
    expect(texts.map((call) => call.args[0])).toEqual(['one two', 'three'])
    expect(texts[0]?.args[1]).toBe(60)
    expect(texts[0]?.fill).toBe('#fff')
  })

  it('aligns text left and right inside its padding', () => {
    const style = { fontSize: 10, fontFamily: 'x', color: '#fff', backgroundColor: null, bold: false }
    for (const [align, expected] of [['left', 14], ['right', 106]] as const) {
      const { ctx, of } = recorder()
      paintPlan(ctx, plan({ current: [{ kind: 'text', text: 'hi', style: { ...style, align }, alpha: 1, box }] }), () => null, noScratch)
      expect(of('fillText')[0]?.args[1]).toBe(expected)
    }
  })

  describe('transitions', () => {
    const scratchCalls: string[] = []
    const scratch = (slot: 'a' | 'b') => {
      scratchCalls.push(slot)
      const surface = recorder()
      return { ctx: surface.ctx, image: { slot } as unknown as CanvasImageSource }
    }
    const outgoing: PaintLayer[] = [{ kind: 'fill', color: '#111', alpha: 1, box }]
    const current: PaintLayer[] = [{ kind: 'fill', color: '#222', alpha: 1, box }]

    it('crossfades the incoming scene over the outgoing one', () => {
      scratchCalls.length = 0
      const { ctx, of } = recorder()
      paintPlan(ctx, plan({ current, outgoing, transition: { type: 'crossfade', t: 0.25 } }), () => null, scratch)
      expect(scratchCalls).toEqual(['a', 'b'])
      expect(of('drawImage').map((call) => [(call.args[0] as { slot: string }).slot, call.alpha])).toEqual([
        ['a', 1],
        ['b', 0.25],
      ])
    })

    it('dips through the background: outgoing first, then incoming', () => {
      const early = recorder()
      paintPlan(early.ctx, plan({ current, outgoing, transition: { type: 'fade', t: 0.25 } }), () => null, scratch)
      expect(early.of('drawImage').map((call) => [(call.args[0] as { slot: string }).slot, call.alpha])).toEqual([['a', 0.5]])

      const late = recorder()
      paintPlan(late.ctx, plan({ current, outgoing, transition: { type: 'fade', t: 0.75 } }), () => null, scratch)
      expect(late.of('drawImage').map((call) => [(call.args[0] as { slot: string }).slot, call.alpha])).toEqual([['b', 0.5]])
    })

    it('treats a cut, or a transition with nothing outgoing, as the current scene', () => {
      for (const variant of [
        plan({ current, outgoing, transition: { type: 'cut', t: 0.5 } }),
        plan({ current, outgoing: null, transition: { type: 'crossfade', t: 0.5 } }),
      ]) {
        const { ctx, of } = recorder()
        paintPlan(ctx, variant, () => null, scratch)
        expect(of('drawImage')).toHaveLength(0)
        expect(of('fillRect').map((call) => call.fill)).toEqual(['#000000', '#222'])
      }
    })

    it('draws only the background when no scratch surface can be made', () => {
      const { ctx, of } = recorder()
      paintPlan(ctx, plan({ current, outgoing, transition: { type: 'fade', t: 0.75 } }), () => null, noScratch)
      expect(of('drawImage')).toHaveLength(0)
      expect(of('fillRect')).toHaveLength(1)
    })
  })
})

describe('wrapText', () => {
  const measure = { measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics }
  it('wraps on words, keeps blank lines, and leaves an unbreakable word whole', () => {
    expect(wrapText(measure, 'aa bb cc\n\nverylongword', 50)).toEqual(['aa bb', 'cc', '', 'verylongword'])
  })
  it('returns the text unwrapped when there is no room', () => {
    expect(wrapText(measure, 'a b', 0)).toEqual(['a b'])
  })
})
