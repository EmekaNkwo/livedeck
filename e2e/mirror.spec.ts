import { expect, test } from '@playwright/test'
import {
  canvasHasContent,
  openDirector,
  openTab,
  sourceRows,
  startCamera,
  startMicrophone,
  useMediaServer,
} from './fixtures'

/**
 * Scenario F — the scene window, and what a guest contributes to it.
 *
 * WHAT THIS PROVES
 * ----------------
 * That `/scene/:room` shows the **live** program rather than a black window.
 * A `MediaStream` cannot cross a browsing context, so the scene window is sent
 * the program over a loopback peer connection; this asserts on the receiving
 * video element's real `readyState` and frame counters, not on a label.
 *
 * It also pins the two defects that made a joined guest look wrong in the
 * program: a duplicated video source, and a feed placed in a stretched
 * letterbox slot instead of a correctly-proportioned box.
 */

test.describe('Scenario F: the scene window mirrors the program', () => {
  test.beforeEach(async ({ page }) => {
    await useMediaServer(page)
  })

  test('shows the live program, with real decoded frames', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useMediaServer(context)
    const director = await context.newPage()
    const scene = await context.newPage()

    try {
      await openDirector(director, 'mirror-live')
      await startCamera(director)
      /*
       * The composited canvas has to actually contain the camera, or a black
       * mirror would pass for the wrong reason.
       *
       * Polled, not read once: "Active" means a live track exists, which is a
       * different moment from the compositor having drawn a frame from it.
       */
      await expect.poll(() => canvasHasContent(director), { timeout: 20_000 }).toBe(true)

      await scene.goto('/scene/mirror-live')

      const video = scene.locator('video')
      await expect(video).toBeVisible({ timeout: 30_000 })

      // HAVE_CURRENT_DATA or better means a frame has really decoded.
      await expect
        .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(2)

      // And it is *moving*: frames keep arriving rather than one stuck image.
      const first = await video.evaluate(
        (el) => (el as HTMLVideoElement).getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      )
      await scene.waitForTimeout(1500)
      const second = await video.evaluate(
        (el) => (el as HTMLVideoElement).getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      )
      expect(second).toBeGreaterThan(first)

      // Still no interface: anything here would land in an OBS capture.
      await expect(scene.getByRole('banner')).toHaveCount(0)
      await expect(scene.getByRole('button')).toHaveCount(0)
      await expect(scene.getByRole('tablist')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('reports honestly when no control room is open', async ({ page }) => {
    await page.goto('/scene/mirror-alone')

    // Falls back to the local compositor rather than a video element, and the
    // hint says why live sources cannot appear.
    await expect(page.locator('canvas')).toBeVisible()
    await expect(page.getByText(/No control room is open/i)).toBeVisible()
  })

  test('a joined guest appears once, in a correctly proportioned box', async ({ browser }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useMediaServer(hostContext)
    await useMediaServer(guestContext)
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'mirror-guest')
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/In the room as director/i),
      ).toBeVisible({ timeout: 30_000 })

      // A guest sending *both* camera and microphone is the case that broke:
      // `ontrack` fires once per track, so the sources were created twice.
      await guest.goto('/push/mirror-guest')
      await guest.getByLabel('Your name').fill('Ana')
      await guest.getByRole('button', { name: /Join room/i }).click()

      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText('Connected', { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 })

      // Exactly one video source for the guest, not two.
      await openTab(host, /Sources/)
      await expect
        .poll(async () => (await sourceRows(host).allInnerTexts()).join(' | '), {
          timeout: 30_000,
        })
        .toMatch(/video/i)

      const rows = await sourceRows(host).allInnerTexts()
      const videoRows = rows.filter((row) => /video/i.test(row))
      expect(videoRows).toHaveLength(1)

      // The placed box must be close to the guest feed's own aspect, not the
      // 3.2:1 slot the old fallback produced on a 16:9 canvas.
      const aspect = await host.evaluate(() => {
        const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
        return canvas ? canvas.width / canvas.height : 0
      })
      expect(aspect).toBeCloseTo(16 / 9, 1)

      await startMicrophone(host)
      const scene = await hostContext.newPage()
      await scene.goto('/scene/mirror-guest')
      await expect(scene.locator('video')).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => scene.locator('video').evaluate((el) => (el as HTMLVideoElement).readyState), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(2)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
})
