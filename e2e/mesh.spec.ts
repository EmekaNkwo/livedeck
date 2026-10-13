import { expect, test, type Page } from '@playwright/test'
import { openDirector, openTab, startCamera, useSignalingTransport } from './fixtures'

/**
 * Scenario H — guests seeing each other, with and without a director.
 *
 * WHAT THIS PROVES
 * ----------------
 * That a room is usable as a plain call: two guests who were sent nothing but
 * `/push/<room>` connect to *each other* in a full mesh and really decode each
 * other's video, with no control room involved at all.
 *
 * Guest-to-guest is the case that needs a tie-break. Neither side has the
 * initiative by role, so both are told about the other at the same moment —
 * if both offered they would glare and neither would get media. The side with
 * the greater peer id offers; both run the same comparison and reach opposite
 * conclusions.
 */

/** Join a room through the lobby, as a guest with a name. */
async function joinAs(page: Page, room: string, name: string): Promise<void> {
  await page.goto(`/push/${room}`)
  const join = page.getByRole('button', { name: /Join room/i })
  await expect(join).toBeEnabled({ timeout: 30_000 })
  await page.getByLabel('Your name').fill(name)
  await join.click()
}

/** A participant tile, found by the caption naming who it is. */
function tileFor(page: Page, name: string) {
  return page.locator('figure').filter({ has: page.getByText(name, { exact: false }) })
}

async function decodesFrames(page: Page, name: string): Promise<void> {
  const video = tileFor(page, name).locator('video')
  await expect(video).toBeVisible({ timeout: 45_000 })
  // HAVE_CURRENT_DATA or better: a frame has really decoded, so this is a live
  // feed rather than an element that was merely created.
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(2)
}

test.describe('Scenario H: guest-to-guest mesh', () => {
  test.beforeEach(async ({ page }) => {
    await useSignalingTransport(page, 'server')
  })

  test('two guests in one room see each other with no director', async ({ browser }) => {
    const first = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const second = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(first, 'server')
    await useSignalingTransport(second, 'server')
    const ana = await first.newPage()
    const bo = await second.newPage()

    try {
      await joinAs(ana, 'mesh-pair', 'Ana')
      await joinAs(bo, 'mesh-pair', 'Bo')

      // Each sees the other, by name, with real decoded video. The tile is
      // captioned from the room roster — an SDP envelope does not carry the
      // sender's identity, so a name here proves the roster is wired too.
      await decodesFrames(ana, 'Bo')
      await decodesFrames(bo, 'Ana')

      // And neither has a program cell, because there is no director: an
      // un-featured grid of the people actually in the room.
      await expect(ana.locator('figure').filter({ hasText: 'Program' })).toHaveCount(0)
      await expect(bo.locator('figure').filter({ hasText: 'Program' })).toHaveCount(0)

      // A guest can grow the room without a control room ever opening.
      await expect(ana.getByRole('button', { name: /Invite/i })).toBeVisible()

      // When one leaves, they disappear from the other rather than lingering
      // as a frozen tile.
      await bo.getByRole('button', { name: /Leave/i }).click()
      await expect(tileFor(ana, 'Bo')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('a third guest joins an existing pair and sees both', async ({ browser }) => {
    const contexts = await Promise.all([
      browser.newContext({ permissions: ['camera', 'microphone'] }),
      browser.newContext({ permissions: ['camera', 'microphone'] }),
      browser.newContext({ permissions: ['camera', 'microphone'] }),
    ])
    for (const context of contexts) await useSignalingTransport(context, 'server')
    const [ana, bo, cas] = await Promise.all(contexts.map((context) => context.newPage()))

    try {
      await joinAs(ana!, 'mesh-trio', 'Ana')
      await joinAs(bo!, 'mesh-trio', 'Bo')
      // The late joiner is the interesting one: it is told about both existing
      // peers at once, in the room roster it receives on joining.
      await joinAs(cas!, 'mesh-trio', 'Cas')

      await decodesFrames(cas!, 'Ana')
      await decodesFrames(cas!, 'Bo')
      await decodesFrames(ana!, 'Cas')
    } finally {
      for (const context of contexts) await context.close()
    }
  })

  /**
   * Layout, asserted on measured boxes rather than on class names.
   *
   * The arrangement this replaced described the *roles* instead of what was
   * worth looking at: the director's program was the whole view and everyone
   * else was a small tile pinned to an edge. With a director that had started
   * no sources the program was an empty — black — canvas, so the screen became
   * one enormous black rectangle with the actual participants tucked into the
   * corners.
   */
  test('two guests with no director share the width evenly', async ({ browser }) => {
    const first = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const second = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(first, 'server')
    await useSignalingTransport(second, 'server')
    const ana = await first.newPage()
    const bo = await second.newPage()

    try {
      await joinAs(ana, 'mesh-layout', 'Ana')
      await joinAs(bo, 'mesh-layout', 'Bo')
      await decodesFrames(ana, 'Bo')

      // Own tile plus the other person: two cells, no featured one.
      const boxes = await ana.locator('figure').evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = (node as HTMLElement).getBoundingClientRect()
          return { w: Math.round(rect.width), h: Math.round(rect.height) }
        }),
      )
      expect(boxes).toHaveLength(2)

      // Equal cells, side by side — a grid, not a stage with a strip.
      expect(Math.abs(boxes[0]!.w - boxes[1]!.w)).toBeLessThanOrEqual(2)
      expect(Math.abs(boxes[0]!.h - boxes[1]!.h)).toBeLessThanOrEqual(2)

      // Each takes about half the viewport width, and real height — the old
      // layout gave the participants ~190px tiles against a 1584px stage.
      const viewport = ana.viewportSize()!
      expect(boxes[0]!.w).toBeGreaterThan(viewport.width * 0.4)
      expect(boxes[0]!.h).toBeGreaterThan(viewport.height * 0.5)
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('the program is featured, and everyone is still on screen', async ({ browser }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(hostContext, 'server')
    await useSignalingTransport(guestContext, 'server')
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'mesh-featured')
      await startCamera(host)
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/Connected to the signaling/i),
      ).toBeVisible({ timeout: 30_000 })

      await joinAs(guest, 'mesh-featured', 'Ana')

      const program = guest.locator('figure').filter({ hasText: 'Program' })
      await expect(program).toBeVisible({ timeout: 45_000 })

      const [programBox, selfBox] = await Promise.all([
        program.boundingBox(),
        guest.locator('figure').filter({ hasText: '(you)' }).boundingBox(),
      ])

      // The program gets most of the room — it is a composed production, only
      // useful large, next to a face that stays readable small.
      expect(programBox!.width).toBeGreaterThan(selfBox!.width * 2)

      // But the guest is still visible, not pushed off the layout.
      const viewport = guest.viewportSize()!
      expect(selfBox!.width).toBeGreaterThan(viewport.width * 0.1)
      expect(selfBox!.y + selfBox!.height).toBeLessThanOrEqual(viewport.height)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })

  /**
   * A guest sharing a screen, and what the room does about it.
   *
   * The control room deliberately cannot share a screen — its role is to
   * conduct and structure scenes, and the material comes from participants. So
   * this is the only path a screen reaches a production by.
   *
   * Chromium's `--auto-select-desktop-capture-source` answers the browser's
   * own picker, which the app can never do itself.
   */
  test('a guest screen share replaces their camera and takes the featured cell', async ({
    browser,
  }) => {
    const first = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const second = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(first, 'server')
    await useSignalingTransport(second, 'server')
    const ana = await first.newPage()
    const bo = await second.newPage()

    try {
      await joinAs(ana, 'mesh-share', 'Ana')
      await joinAs(bo, 'mesh-share', 'Bo')
      await decodesFrames(bo, 'Ana')

      // Before sharing: two equal cells, nothing featured.
      const before = await bo.locator('figure').evaluateAll((nodes) =>
        nodes.map((node) => Math.round((node as HTMLElement).getBoundingClientRect().width)),
      )
      expect(Math.abs(before[0]! - before[1]!)).toBeLessThanOrEqual(2)

      await ana.getByRole('button', { name: /Share screen/i }).click()

      // The sharer says so over the control channel — WebRTC itself carries no
      // hint about what a track is *of*, so without the report the other side
      // would lay a shared document out at the size of a face.
      const anaTile = tileFor(bo, 'Ana')
      await expect(anaTile.getByText('sharing')).toBeVisible({ timeout: 30_000 })

      // And it takes the room: substantially wider than the other cell.
      await expect
        .poll(
          async () => {
            const boxes = await bo.locator('figure').evaluateAll((nodes) =>
              nodes.map((node) => ({
                w: Math.round((node as HTMLElement).getBoundingClientRect().width),
                caption: node.querySelector('figcaption')?.textContent ?? '',
              })),
            )
            const shared = boxes.find((box) => box.caption.includes('Ana'))
            const other = boxes.find((box) => !box.caption.includes('Ana'))
            if (!shared || !other) return 0
            return shared.w / Math.max(other.w, 1)
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(1.8)

      // Stopping returns the room to an even grid.
      await ana.getByRole('button', { name: /Stop sharing/i }).click()
      await expect(anaTile.getByText('sharing')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await first.close()
      await second.close()
    }
  })

  test("the director's program fills the stage it is given", async ({ browser }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(hostContext, 'server')
    await useSignalingTransport(guestContext, 'server')
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'mesh-stage')
      await startCamera(host)
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/Connected to the signaling/i),
      ).toBeVisible({ timeout: 30_000 })

      await joinAs(guest, 'mesh-stage', 'Ana')

      const stage = guest.getByLabel('Program (director)')
      await expect(stage).toBeVisible({ timeout: 45_000 })
      await expect
        .poll(() => stage.evaluate((el) => (el as HTMLVideoElement).readyState), {
          timeout: 45_000,
        })
        .toBeGreaterThanOrEqual(2)

      /*
       * The regression this pins.
       *
       * The stage used `max-h-full max-w-full`, which caps an element at its
       * *intrinsic* size — so a 1280-wide program sat at 1280 in the middle of
       * a wider stage and would not grow. Sizing to the container instead
       * means the rendered box tracks the space available.
       */
      const fit = await stage.evaluate((el) => {
        const video = el as HTMLVideoElement
        const parent = video.parentElement
        return {
          width: video.clientWidth,
          parentWidth: parent ? parent.clientWidth : 0,
          intrinsicWidth: video.videoWidth,
        }
      })

      // Wider than the source, which is only possible if it is filling the
      // container rather than being capped at its own resolution.
      expect(fit.parentWidth).toBeGreaterThan(fit.intrinsicWidth)
      expect(fit.width).toBeGreaterThan(fit.parentWidth * 0.95)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
})
