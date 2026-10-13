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

      // And neither is showing a director feed, because there is no director.
      await expect(ana.getByLabel("The director's program feed")).toHaveCount(0)
      await expect(bo.getByLabel("The director's program feed")).toHaveCount(0)

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

      const stage = guest.getByLabel("The director's program feed")
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
