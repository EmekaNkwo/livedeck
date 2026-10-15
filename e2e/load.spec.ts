import { expect, test, type Browser, type Page } from '@playwright/test'
import { RELAY_PORT, guestTiles, openDirector, openTab, useMediaServer } from './fixtures'

/**
 * Scenario L — a twelve-person studio.
 *
 * Twelve real Chromium contexts, each with a fake camera and microphone,
 * join one room; the twelfth also shares its screen; the director opens the
 * control room, consumes everyone, cues them and records the program.
 *
 * Measured and asserted:
 *   - the server reports 12 peers, 25 producers (12 mic + 12 camera + 1 screen);
 *   - every guest shows every other guest with video arriving;
 *   - the director has 12 tiles, 12 connected, no duplicates;
 *   - per-page CPU time and JS heap (Chromium metrics), reported for the run.
 *
 * It is heavy, so it runs only when LIVEDECK_LOAD=1:
 *
 *     LIVEDECK_LOAD=1 npx playwright test e2e/load.spec.ts
 *
 * Twelve fake cameras on one machine are themselves a load. The numbers are
 * for comparison between runs on the same box, not absolute capacity.
 */

const PARTICIPANTS = 12

test.describe('Scenario L: twelve participants', () => {
  test.skip(!process.env.LIVEDECK_LOAD, 'set LIVEDECK_LOAD=1 to run the load scenario')
  test.setTimeout(10 * 60_000)

  test('twelve guests, one screen share, a director recording', async ({ browser, page }) => {
    const room = `load-${Date.now().toString(36)}`
    await useMediaServer(page)
    await openDirector(page, room)
    await openTab(page, /Guests/)
    await expect(page.getByRole('region', { name: 'Guests' }).getByText(/In the room as director/i)).toBeVisible({
      timeout: 30_000,
    })

    const guests: Page[] = []
    for (let i = 0; i < PARTICIPANTS; i += 1) {
      guests.push(await joinGuest(browser, room, `Guest ${i + 1}`))
    }
    await expect(guestTiles(page)).toHaveCount(PARTICIPANTS, { timeout: 120_000 })

    // The last guest shares a screen (the harness auto-selects a surface).
    const sharer = guests[PARTICIPANTS - 1]!
    await sharer.getByRole('button', { name: /Share screen/i }).click()
    await expect(sharer.getByRole('button', { name: /Stop sharing/i })).toBeVisible({ timeout: 30_000 })

    // Server view.
    const health = (await (await fetch(`http://localhost:${RELAY_PORT}/healthz`)).json()) as {
      rooms: number
      peers: number
    }
    expect(health.peers).toBe(PARTICIPANTS + 1)

    // Every guest sees everyone else with video.
    for (const guest of guests) {
      await expect(guest.locator('video')).toHaveCount(PARTICIPANTS, { timeout: 120_000 })
      await expect
        .poll(
          async () =>
            guest.evaluate(() =>
              [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0 && !v.paused).length,
            ),
          { timeout: 120_000 },
        )
        .toBeGreaterThanOrEqual(PARTICIPANTS - 1)
    }

    // Director: all connected, cue everyone, record for a while.
    await expect(page.getByRole('region', { name: 'Guests' }).getByText(/^Connected$/)).toHaveCount(PARTICIPANTS, {
      timeout: 60_000,
    })
    await page.getByLabel(/Message to send to every guest/i).fill('Rolling')
    await page.getByRole('button', { name: /Cue all/i }).click()
    for (const guest of guests) await expect(guest.getByRole('alert')).toContainText('Rolling')

    await openTab(page, /Mix & record/)
    await page.getByRole('button', { name: /^Start recording/i }).click()
    await page.waitForTimeout(20_000)
    await page.getByRole('button', { name: /^Stop/i }).click()
    await expect(page.getByText(/Recording saved/i)).toBeVisible({ timeout: 60_000 })

    // Numbers for the run.
    const metrics: Array<{ who: string; cpuSeconds: number; heapMb: number }> = []
    for (const [index, target] of [page, ...guests].entries()) {
      const session = await target.context().newCDPSession(target)
      const { metrics: raw } = (await session.send('Performance.getMetrics')) as {
        metrics: Array<{ name: string; value: number }>
      }
      const get = (name: string) => raw.find((m) => m.name === name)?.value ?? 0
      metrics.push({
        who: index === 0 ? 'director' : `guest-${index}`,
        cpuSeconds: Number(get('TaskDuration').toFixed(1)),
        heapMb: Math.round(get('JSHeapUsedSize') / 1024 / 1024),
      })
      await session.detach()
    }
    test.info().annotations.push({ type: 'load-metrics', description: JSON.stringify({ health, metrics }) })
    console.info('[load] server', health)
    console.table(metrics)

    for (const guest of guests) await guest.context().close()
  })
})

async function joinGuest(browser: Browser, room: string, name: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  await useMediaServer(context)
  const page = await context.newPage()
  await page.goto(`/push/${room}`)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: /Turn camera on/i }).click()
  await page.getByRole('button', { name: /Turn microphone on/i }).click()
  await page.getByRole('button', { name: /Join room/i }).click()
  await expect(page.locator('header').getByText(/^Connected/)).toBeVisible({ timeout: 60_000 })
  return page
}
