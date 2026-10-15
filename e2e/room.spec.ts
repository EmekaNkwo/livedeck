import { expect, test } from './test'
import {
  guestTiles,
  openDirector,
  openTab,
  sourceRows,
  startCamera,
  pointAtMediaServer,
} from './fixtures'

/**
 * Scenario E — the room workflow, which is the default.
 *
 * WHAT THIS PROVES
 * ----------------
 * That a guest who is sent nothing but `/push/<room>` can join and connect:
 * they set a name, click **Join room**, and appear in the director's control
 * room with a genuine `connected` peer state. No link carries an offer, no code
 * is pasted, and the director never types the guest's name.
 *
 * It needs the media server in `server/` running — Playwright starts it
 * alongside the dev server. Both contexts run on one machine, so this verifies
 * the workflow and the state machine rather than NAT traversal.
 */

test.describe('Scenario E: room-based joining', () => {
  test.beforeEach(async ({ page }) => {
    await pointAtMediaServer(page)
  })

  test('the invite is a single reusable room link, with no guest fields', async ({ page }) => {
    await openDirector(page, 'room-invite')
    await openTab(page, /Guests/)

    const guests = page.getByRole('region', { name: 'Guests' })

    // Reaching the relay is reported as its own fact, separate from whether
    // any guest has connected.
    await expect(guests.getByText(/In the room as director/i)).toBeVisible({
      timeout: 30_000,
    })

    // The whole invitation: one link, one button.
    await expect(guests.getByLabel('Guest link')).toHaveValue(/\/push\/room-invite$/)
    await expect(guests.getByRole('button', { name: /Copy link/i }).first()).toBeVisible()
    // The director also gets a producer link, carrying a key.
    await expect(guests.getByLabel('Producer link')).toHaveValue(/\/push\/room-invite\?key=/)

    // And nothing per-guest to fill in — the guest names themselves.
    await expect(guests.getByLabel('Guest name')).toHaveCount(0)
    await expect(guests.getByRole('button', { name: /Create invite link/i })).toHaveCount(0)
  })

  /**
   * The participant lifecycle, which is where duplicates came from.
   *
   * The relay assigns a fresh peer id on every join, and the director created
   * a guest row per offer while nothing ever retired the old one. So the same
   * person leaving and rejoining — or just reloading their tab — appeared as
   * "Ana", then "Ana 2", then "Ana 3", each with its own guest video source.
   */
  test('a guest who leaves is removed, and rejoining does not duplicate them', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await pointAtMediaServer(hostContext)
    await pointAtMediaServer(guestContext)
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'room-lifecycle')
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/In the room as director/i),
      ).toBeVisible({ timeout: 30_000 })

      // Joining switches nothing on, so the camera is turned on in the lobby:
      // the assertion at the end is about one guest *video* source.
      const joinAs = async (name: string) => {
        const cameraOn = guest.getByRole('button', { name: 'Turn camera on' })
        if (await cameraOn.isVisible()) await cameraOn.click()
        await guest.getByLabel('Your name').fill(name)
        await guest.getByRole('button', { name: /Join room/i }).click()
      }

      await guest.goto('/push/room-lifecycle')
      await joinAs('Ana')
      await expect(guestTiles(host)).toHaveCount(1, { timeout: 45_000 })

      // Leaving really leaves: the relay reports it and the row is retired,
      // rather than lingering as a participant who is no longer there.
      await guest.getByRole('button', { name: /Leave/i }).click()
      await expect(guestTiles(host)).toHaveCount(0, { timeout: 30_000 })

      // Rejoining is one participant again, under the name they chose — not
      // "Ana 2" beside a stale "Ana".
      await joinAs('Ana')
      await expect(guestTiles(host)).toHaveCount(1, { timeout: 45_000 })
      await expect(guestTiles(host).first()).toContainText('Ana')

      // A reload is the same thing from the relay's point of view, and was the
      // most common way to accumulate duplicates in practice.
      await guest.reload()
      await joinAs('Ana')
      await expect(guestTiles(host)).toHaveCount(1, { timeout: 45_000 })
      await expect(guestTiles(host).first()).not.toContainText('No video', { timeout: 45_000 })

      // And exactly one guest video source in the scene, never two.
      await openTab(host, /Sources/)
      const rows = await sourceRows(host).allInnerTexts()
      expect(rows.filter((row) => /Ana/.test(row) && /video/i.test(row))).toHaveLength(1)
      expect(rows.join(' ')).not.toContain('Ana 2')
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })

  test('a guest opening the room link joins and connects', async ({ browser }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await pointAtMediaServer(hostContext)
    await pointAtMediaServer(guestContext)
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await openDirector(host, 'room-join')
      await startCamera(host)
      await openTab(host, /Guests/)
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/In the room as director/i),
      ).toBeVisible({ timeout: 30_000 })

      /* ------------- guest: nothing but the room URL ------------------- */
      await guest.goto('/push/room-join')

      // Joining is an explicit act. Until it happens the director has no guest,
      // because a camera should not enter someone's production on page load.
      const join = guest.getByRole('button', { name: /Join room/i })
      await expect(join).toBeEnabled({ timeout: 30_000 })
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/No guests/i),
      ).toBeVisible()

      await guest.getByLabel('Your name').fill('Ana')
      await join.click()

      /* ------------- both sides reach a real connected state ----------- */
      const guestTile = host
        .getByRole('region', { name: 'Guests' })
        .getByRole('listitem')
        .first()

      // The name travelled with the join, not from a field the director typed.
      await expect(guestTile).toContainText('Ana', { timeout: 45_000 })
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText('Connected', { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 })
      await expect(guest.getByText('Connected', { exact: true }).first()).toBeVisible({
        timeout: 45_000,
      })

      // Nothing was pasted anywhere: the manual exchange controls are absent.
      await expect(guest.getByLabel('Your answer link')).toHaveCount(0)
      await expect(host.getByLabel('Guest answer link or code')).toHaveCount(0)

      /* ------------- the control channel reaches the guest ------------- */
      // Same assertion as the manual flow: the *guest's own* UI has to flip,
      // which can only happen if the command crossed the data channel.
      // Joining no longer switches the microphone on, so turn it on here —
      // the point of this assertion is the director's remote mute, not what
      // joining does to somebody's hardware.
      await guest.getByRole('button', { name: 'Turn microphone on' }).click()
      await expect(
        guest.getByRole('button', { name: 'Turn microphone off' }),
      ).toBeVisible({ timeout: 20_000 })
      await guestTile.getByRole('button', { name: 'Mic' }).click()
      await expect(guest.getByRole('button', { name: 'Turn microphone on' })).toBeVisible({
        timeout: 20_000,
      })

      /* ------------- leaving returns the guest to the lobby ------------ */
      await guest.getByRole('button', { name: /Leave/i }).click()
      await expect(guest.getByRole('button', { name: /Join room/i })).toBeVisible()
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
})
