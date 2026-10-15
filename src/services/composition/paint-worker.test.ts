import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FromPaintWorker, ToPaintWorker } from './paint-protocol'

/**
 * The worker entry, run in-process: its `onmessage` is called directly and
 * what it posts back is captured.
 */

const painted = vi.hoisted(() => ({ plans: [] as unknown[], lookups: [] as Array<unknown>, throwNext: false }))
vi.mock('./painter', () => ({
  paintPlan: (_ctx: unknown, plan: unknown, images: (key: string) => unknown, scratch: (slot: 'a', w: number, h: number) => unknown) => {
    if (painted.throwNext) {
      painted.throwNext = false
      throw new Error('draw failed')
    }
    painted.plans.push(plan)
    painted.lookups.push(images('cam'), images('logo'), images('none'), scratch('a', 4, 4), scratch('a', 8, 8))
  },
}))

class FakeOffscreen {
  width: number
  height: number
  constructor(width = 0, height = 0) {
    this.width = width
    this.height = height
  }
  getContext() {
    return { kind: 'ctx' }
  }
}
const closable = (name: string) => ({ name, closed: false, close() { this.closed = true } })

const posted: FromPaintWorker[] = []
let handler: (event: { data: ToPaintWorker }) => void

beforeAll(async () => {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
  vi.stubGlobal('postMessage', (message: FromPaintWorker) => posted.push(message))
  await import('./paint-worker')
  handler = globalThis.onmessage as unknown as typeof handler
})

beforeEach(() => {
  posted.length = 0
  painted.plans.length = 0
  painted.lookups.length = 0
})

const send = (message: unknown) => handler({ data: message as ToPaintWorker })

describe('paint worker', () => {
  it('paints with this frame’s video and cached images, closes the frames, and acknowledges', () => {
    const canvas = new FakeOffscreen(10, 10)
    send({ type: 'init', canvas })
    send({ type: 'resize', width: 640, height: 360 })
    expect([canvas.width, canvas.height]).toEqual([640, 360])
    const logo = closable('logo')
    send({ type: 'image', key: 'logo', bitmap: logo })
    const cam = closable('cam')
    send({ type: 'paint', id: 7, plan: { p: 1 }, frames: [['cam', cam]] })

    expect(painted.plans).toEqual([{ p: 1 }])
    const [camLookup, logoLookup, none, scratchA, scratchAResized] = painted.lookups as Array<{ name?: string; image?: FakeOffscreen } | null>
    expect(camLookup?.name).toBe('cam')
    expect(logoLookup?.name).toBe('logo')
    expect(none).toBeNull()
    expect(scratchAResized?.image).toBe(scratchA?.image)
    expect(scratchAResized?.image?.width).toBe(8)
    expect(cam.closed).toBe(true)
    expect(posted).toEqual([expect.objectContaining({ type: 'painted', id: 7 })])
  })

  it('replaces and drops cached images, closing the old ones', () => {
    const first = closable('a')
    const second = closable('b')
    send({ type: 'image', key: 'logo', bitmap: first })
    send({ type: 'image', key: 'logo', bitmap: second })
    expect(first.closed).toBe(true)
    send({ type: 'drop', key: 'logo' })
    expect(second.closed).toBe(true)
  })

  it('reports a failed paint and still acknowledges it, closing its frames', () => {
    send({ type: 'init', canvas: new FakeOffscreen() })
    painted.throwNext = true
    const cam = closable('cam')
    send({ type: 'paint', id: 9, plan: {}, frames: [['cam', cam]] })
    expect(cam.closed).toBe(true)
    expect(posted).toEqual([
      { type: 'error', message: 'draw failed' },
      { type: 'painted', id: 9, durationMs: 0 },
    ])
  })
})
