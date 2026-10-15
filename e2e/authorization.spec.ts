import { expect, test, type Browser, type Page } from '@playwright/test'
import { guestTiles, openDirector, openTab, selfParticipantId, sessionControl, useMediaServer } from './fixtures'

/**
 * Scenario I — who may control whom, and what survives a dropped network.
 *
 * WHAT THIS PROVES
 * ----------------
 * The server, not the browser, decides authority. Guest A's page has no
 * button to mute guest B, so the test drives A's media session directly, the
 * way a tampered client would, and expects the server to refuse. The director
 * uses the real tile controls and the command lands on the guest's microphone.
 *
 * Then the guest's network goes away and comes back. The session resumes with
 * the same identity, the director keeps one tile for them, and media returns.
 */

async function joinAsGuest(browser: Browser, room: string, name: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
  await useMediaServer(context)
  const page = await context.newPage()
  await page.goto(`/push/${room}`)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: /Turn microphone on/i }).click()
  await page.getByRole('button', { name: /Join room/i }).click()
  await expect(page.locator('header').getByText(/^Connected/)).toBeVisible({ timeout: 30_000 })
  return page
}

test.describe('Scenario I: authorization and recovery', () => {
  test.beforeEach(async ({ page }) => {
    await useMediaServer(page)
  })

  test('a guest cannot control another guest; the director can', async ({ browser, page }) => {
    const room = 'authz-room'
    await openDirector(page, room)
    await openTab(page, /Guests/)
    await expect(page.getByRole('region', { name: 'Guests' }).getByText(/In the room as director/i)).toBeVisible({
      timeout: 30_000,
    })

    const alice = await joinAsGuest(browser, room, 'Alice')
    const bob = await joinAsGuest(browser, room, 'Bob')
    await expect(guestTiles(page)).toHaveCount(2, { timeout: 30_000 })

    const bobId = await selfParticipantId(bob)
    const aliceId = await selfParticipantId(alice)
    expect(bobId).toBeTruthy()
    expect(aliceId).toBeTruthy()

    // Alice drives her session like a tampered client would.
    for (const command of [
      { action: 'mute-mic', muted: true },
      { action: 'mute-camera', muted: true },
      { action: 'cue', text: 'pwned' },
      { action: 'on-air', onAir: true },
      { action: 'label', label: 'Pwned' },
      { action: 'kick' },
    ]) {
      const result = await sessionControl(alice, bobId as string, command)
      expect(result, JSON.stringify(command)).toEqual({ ok: false, code: 'forbidden' })
    }
    // Bob heard nothing: still unmuted, still named Bob, still in the room.
    await expect(bob.getByRole('button', { name: /Turn microphone off/i })).toBeVisible()
    await expect(bob.locator('header').getByText(/^Connected/)).toBeVisible()
    await expect(page.getByText('Pwned')).toHaveCount(0)

    // The director's tile control does reach Bob.
    const bobTile = guestTiles(page).filter({ hasText: 'Bob' })
    await bobTile.getByRole('button', { name: /^Mic$/ }).click()
    await expect(bob.getByRole('button', { name: /Turn microphone on/i })).toBeVisible({ timeout: 15_000 })

    // And a cue, through the server, lands on Bob's screen.
    await page.getByLabel(/Message to send to every guest/i).fill('Thirty seconds')
    await page.getByRole('button', { name: /Cue all/i }).click()
    await expect(bob.getByRole('alert')).toContainText('Thirty seconds')

    await alice.context().close()
    await bob.context().close()
  })

  test('a guest whose network drops comes back as the same participant', async ({ browser, page }) => {
    const room = 'recover-room'
    await openDirector(page, room)
    await openTab(page, /Guests/)
    await expect(page.getByRole('region', { name: 'Guests' }).getByText(/In the room as director/i)).toBeVisible({
      timeout: 30_000,
    })
    const guest = await joinAsGuest(browser, room, 'Cleo')
    await expect(guestTiles(page)).toHaveCount(1, { timeout: 30_000 })
    const before = await selfParticipantId(guest)

    await guest.context().setOffline(true)
    await expect(guest.locator('header').getByText(/Reconnecting|Connecting|Connection failed/)).toBeVisible({ timeout: 30_000 })
    await guest.context().setOffline(false)

    await expect(guest.locator('header').getByText(/^Connected/)).toBeVisible({ timeout: 45_000 })
    const after = await selfParticipantId(guest)
    expect(after).toBe(before)
    // Still exactly one tile, still Cleo.
    await expect(guestTiles(page)).toHaveCount(1)
    await expect(guestTiles(page).first()).toContainText('Cleo')

    await guest.context().close()
  })
})
