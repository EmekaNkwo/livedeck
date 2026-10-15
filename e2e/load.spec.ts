import { expect, test, type Browser, type Page } from './test'
import { HEALTH_URL, guestTiles, openDirector, openTab, pointAtMediaServer } from './fixtures'

/**
 * Scenario L — a twelve-person studio.
 *
 * Twelve real Chromium contexts, each with a fake camera and microphone,
 * join one room; the twelfth also shares its screen; the director opens the
 * control room, consumes everyone, cues them and records the program.
 *
 * Measured and asserted:
 *   - the server reports 12 peers, 25 producers (12 mic + 12 camera + 1 screen);
 *   - every guest decodes every other guest's video;
 *   - the director has 12 tiles, 12 connected, no duplicates;
 *   - per page over a 20 s recording window: CPU busy %, JS heap, packet
 *     loss, jitter, RTT and uplink estimate; server producer/consumer counts
 *     and per-worker room load from /healthz.
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
    await pointAtMediaServer(page)
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
    // page.request honours ignoreHTTPSErrors, so this works against a trial deployment too.
    const health = (await (await page.request.get(HEALTH_URL)).json()) as {
      rooms: number
      peers: number
    }
    expect(health.peers).toBe(PARTICIPANTS + 1)

    // Every guest decodes everyone else's video. Counted by frames actually
    // decoding, not by elements: the page also holds the featured screen view
    // and the registry's hidden element for its own camera.
    for (const guest of guests) {
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
    await expect(guestTiles(page).filter({ hasText: /Connected/ })).toHaveCount(PARTICIPANTS, {
      timeout: 60_000,
    })
    await page.getByLabel(/Message to send to every guest/i).fill('Rolling')
    await page.getByRole('button', { name: /Cue all/i }).click()
    for (const guest of guests) await expect(guest.getByRole('alert')).toContainText('Rolling')

    // Steady-state measurement window: the recording. CPU is busy time over
    // wall time in that window, per page.
    const pages = [page, ...guests]
    const cdp = await Promise.all(pages.map((target) => target.context().newCDPSession(target)))
    await Promise.all(cdp.map((session) => session.send('Performance.enable')))
    const sample = async () =>
      Promise.all(
        cdp.map(async (session) => {
          const { metrics: raw } = (await session.send('Performance.getMetrics')) as {
            metrics: Array<{ name: string; value: number }>
          }
          const get = (name: string) => raw.find((m) => m.name === name)?.value ?? 0
          return { task: get('TaskDuration'), heap: get('JSHeapUsedSize'), at: get('Timestamp') }
        }),
      )
    const before = await sample()

    await openTab(page, /Mix & record/)
    await page.getByRole('button', { name: /^Start recording/i }).click()
    await page.waitForTimeout(20_000)
    const after = await sample()
    await page.getByRole('button', { name: /^Stop/i }).click()
    await expect(page.getByText(/Recording saved/i)).toBeVisible({ timeout: 60_000 })

    // Network quality as each page's own receive transport sees it.
    const network = await Promise.all(
      pages.map((target) =>
        target.evaluate(async () => {
          const session = (window as unknown as {
            __livedeckSession?: { getStats: () => Promise<{ recv: RTCStatsReport | null; send: RTCStatsReport | null }> }
          }).__livedeckSession
          if (!session) return null
          const { recv, send } = await session.getStats()
          let lost = 0
          let received = 0
          let jitter = 0
          let streams = 0
          let rtt: number | null = null
          let sentKbps = 0
          recv?.forEach((r: Record<string, unknown>) => {
            if (r.type === 'inbound-rtp') {
              lost += Number(r.packetsLost ?? 0)
              received += Number(r.packetsReceived ?? 0)
              jitter += Number(r.jitter ?? 0)
              streams += 1
            }
            if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') {
              rtt = r.currentRoundTripTime * 1000
            }
          })
          send?.forEach((r: Record<string, unknown>) => {
            if (r.type === 'candidate-pair' && r.nominated && typeof r.availableOutgoingBitrate === 'number') {
              sentKbps = Math.round(r.availableOutgoingBitrate / 1000)
            }
          })
          return {
            lossPct: received + lost > 0 ? Number(((lost / (received + lost)) * 100).toFixed(2)) : 0,
            jitterMs: streams > 0 ? Number(((jitter / streams) * 1000).toFixed(1)) : 0,
            rttMs: rtt === null ? null : Number((rtt as number).toFixed(1)),
            inbound: streams,
            uplinkKbps: sentKbps,
          }
        }),
      ),
    )

    const metrics = pages.map((_, index) => {
      const a = before[index]!
      const b = after[index]!
      const wall = Math.max(0.001, b.at - a.at)
      return {
        who: index === 0 ? 'director' : `guest-${index}`,
        cpuPct: Math.round(((b.task - a.task) / wall) * 100),
        heapMb: Math.round(b.heap / 1024 / 1024),
        ...(network[index] ?? {}),
      }
    })
    const finalHealth = (await (await page.request.get(HEALTH_URL)).json()) as { producers: number; peers: number }
    test.info().annotations.push({ type: 'load-metrics', description: JSON.stringify({ server: finalHealth, metrics }) })
    console.info('[load] server', JSON.stringify(finalHealth))
    console.table(metrics)
    for (const session of cdp) await session.detach().catch(() => undefined)

    // The server's media objects match the room: 12 cameras + 12 mics + the
    // screen (+ its audio when the platform provided a track).
    expect(finalHealth.producers).toBeGreaterThanOrEqual(PARTICIPANTS * 2 + 1)
    expect(finalHealth.peers).toBe(PARTICIPANTS + 1)

    /*
     * The bound is "no catastrophic degradation", not "a quiet network".
     *
     * Thirteen Chromium pages on one machine encode twelve three-layer
     * simulcast cameras and decode about three hundred streams between them.
     * The loss, jitter and RTT this produces on a loopback link are CPU
     * starvation on the test box (measured: 5-10% loss, ~50 ms jitter,
     * 200-450 ms RTT on a laptop), not the server or the network. Twelve real
     * participants each bring their own machine. The run fails if a page
     * degrades beyond usable, and prints the numbers for comparison.
     */
    for (const row of metrics) expect(row.lossPct ?? 0, row.who).toBeLessThan(25)

    for (const guest of guests) await guest.context().close()
  })
})

async function joinGuest(browser: Browser, room: string, name: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  await pointAtMediaServer(context)
  const page = await context.newPage()
  await page.goto(`/push/${room}`)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: /Turn camera on/i }).click()
  await page.getByRole('button', { name: /Turn microphone on/i }).click()
  await page.getByRole('button', { name: /Join room/i }).click()
  await expect(page.locator('header').getByText(/^Connected/)).toBeVisible({ timeout: 60_000 })
  return page
}
