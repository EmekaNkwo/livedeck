import { expect, test } from '@playwright/test'
import {
  guestTiles,
  openDirector,
  openProperties,
  openTab,
  sourceRows,
  startCamera,
  useSignalingTransport,
} from './fixtures'

/**
 * Scenario G — device pickers, the speaking indicator, and solo sharing.
 *
 * These are the three things a production operator reaches for that are not
 * about getting connected: choosing *which* camera, seeing who is talking, and
 * handing one feed to someone else.
 */

test.describe('Scenario G: devices, speaking, and solo links', () => {
  test.beforeEach(async ({ page }) => {
    await useSignalingTransport(page, 'server')
  })

  test('the guest lobby offers a device picker beside each toggle', async ({ page }) => {
    await page.goto('/push/g-devices')

    // Toggle and picker are separate controls, so each has its own name.
    await expect(page.getByRole('button', { name: 'Turn camera on' })).toBeVisible()
    const picker = page.getByRole('button', { name: 'Choose a camera' })
    await expect(picker).toBeVisible()

    await picker.click()
    const menu = page.getByRole('menu', { name: 'Choose a camera' })
    await expect(menu).toBeVisible()

    // Real radio semantics, so a screen reader can say which one is in use.
    const items = menu.getByRole('menuitemradio')
    await expect(items.first()).toHaveAttribute('aria-checked', 'true')
    expect(await items.count()).toBeGreaterThan(1)

    // Choosing a device starts the camera on it, rather than being ignored
    // because the camera happened to be off.
    await items.nth(1).click()
    await expect(menu).toBeHidden()
    await expect(page.getByRole('button', { name: 'Turn camera off' })).toBeVisible({
      timeout: 20_000,
    })

    // Escape closes it without choosing.
    await page.getByRole('button', { name: 'Choose a microphone' }).click()
    await expect(page.getByRole('menu', { name: 'Choose a microphone' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Choose a microphone' })).toBeHidden()
  })

  test('in a call there is no meter, and speech shows on the person', async ({ browser }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(hostContext, 'server')
    await useSignalingTransport(guestContext, 'server')
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'g-speaking')
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/Connected to the signaling/i),
      ).toBeVisible({ timeout: 30_000 })

      await guest.goto('/push/g-speaking')
      await guest.getByRole('button', { name: 'Turn microphone on' }).click()

      // No dB meter anywhere in the guest view, lobby included. "Who is
      // talking" is the question worth answering here, and the indicator on
      // each person answers it; a moving bar is a measurement nobody in a call
      // is reading.
      await expect(guest.getByText('Your level')).toHaveCount(0)
      await expect(guest.getByLabel(/Your microphone/i)).toHaveCount(0)

      await guest.getByLabel('Your name').fill('Ana')
      await guest.getByRole('button', { name: /Join room/i }).click()
      await expect(guestTiles(host)).toHaveCount(1, { timeout: 45_000 })

      await expect(guest.getByText('Your level')).toHaveCount(0)
      await expect(guest.getByLabel(/Your microphone/i)).toHaveCount(0)

      /*
       * Chromium's fake device emits a continuous tone, so "speaking" is the
       * steady state here — which is exactly what makes it assertable. Both
       * sides must agree, because they read different channels: the guest its
       * own microphone, the director the guest's mixer channel.
       */
      await expect(guest.locator('figcaption').getByText('Speaking')).toBeAttached({
        timeout: 20_000,
      })
      await expect(guestTiles(host).first().getByText('Speaking')).toBeAttached({
        timeout: 30_000,
      })

      // Muting wins over level: a muted participant is never "speaking".
      await guest.getByRole('button', { name: 'Turn microphone off' }).click()
      await expect(guest.locator('figcaption').getByText('Muted')).toBeAttached({
        timeout: 20_000,
      })
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })

  test('a source can be shared as a solo link that really shows that feed', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    })
    await useSignalingTransport(context, 'server')
    const director = await context.newPage()

    try {
      await openDirector(director, 'g-solo')
      await startCamera(director)

      // Select the source, then share it from the properties panel — where a
      // labelled control fits, unlike the list's already-crowded rows.
      await sourceRows(director).filter({ hasText: 'Camera' }).first().click()
      await openProperties(director)

      const share = director.getByRole('button', { name: /Copy a solo link for Camera/i })
      await expect(share).toBeVisible()
      await share.click()

      // The link is real, and tied to this room *and* this source id.
      const url = await director.evaluate(() => navigator.clipboard.readText())
      expect(url).toContain('/solo/g-solo/')
      const sourceId = url.split('/solo/g-solo/')[1] ?? ''
      expect(sourceId).not.toBe('')

      // Opening it shows that feed, with decoded frames and no interface.
      const solo = await context.newPage()
      await solo.goto(url)
      const video = solo.locator('video')
      await expect(video).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(2)
      await expect(solo.getByRole('button')).toHaveCount(0)

      // A link to a source that does not exist says so rather than hanging on
      // a black frame.
      const missing = await context.newPage()
      await missing.goto('/solo/g-solo/src_nonexistent')
      await expect(missing.getByText(/Waiting for a live feed/i)).toBeVisible({
        timeout: 20_000,
      })
    } finally {
      await context.close()
    }
  })

  test('a guest can be shared from the control room', async ({ browser }) => {
    const hostContext = await browser.newContext({
      permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(hostContext, 'server')
    await useSignalingTransport(guestContext, 'server')
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'g-guestshare')
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/Connected to the signaling/i),
      ).toBeVisible({ timeout: 30_000 })

      await guest.goto('/push/g-guestshare')
      await guest.getByLabel('Your name').fill('Ana')
      await guest.getByRole('button', { name: /Join room/i }).click()
      await expect(guestTiles(host)).toHaveCount(1, { timeout: 45_000 })

      // Share becomes available once the guest has a video source to share.
      const share = guestTiles(host).first().getByRole('button', { name: /^Share$/ })
      await expect(share).toBeEnabled({ timeout: 45_000 })
      await share.click()

      const url = await host.evaluate(() => navigator.clipboard.readText())
      expect(url).toContain('/solo/g-guestshare/')

      // And it carries the guest's feed into a window that is not the control
      // room — which is the whole point of a solo link.
      const solo = await hostContext.newPage()
      await solo.goto(url)
      await expect(solo.locator('video')).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(
          () => solo.locator('video').evaluate((el) => (el as HTMLVideoElement).readyState),
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(2)

      // Sanity: the shared source really is the guest's, not the program.
      const rows = await (async () => {
        await openTab(host, /Sources/)
        return sourceRows(host).allInnerTexts()
      })()
      expect(rows.join(' ')).toMatch(/Ana/)
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
})
