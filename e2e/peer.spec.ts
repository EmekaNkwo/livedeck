import { expect, test } from '@playwright/test'
import { createSession, startCamera } from './fixtures'

/**
 * Scenario D — peer mode and the manual signaling workflow.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * These tests drive the real handshake in real browser contexts: a genuine
 * `RTCPeerConnection` produces a genuine offer with ICE candidates gathered,
 * the code is carried between two contexts, and an answer is applied. Both
 * contexts run on the same machine, so host candidates always match and the
 * connection succeeds — which means this verifies the *workflow and the state
 * machine*, not NAT traversal.
 *
 * Real-world connectivity across different networks cannot be proven from a
 * test runner on one host. The application is explicit about that limitation
 * in the invite dialog, and so is the README.
 */

test.describe('Scenario D: peer connection mode', () => {
  test('explains the manual workflow and the STUN-only limitation', async ({ page }) => {
    await createSession(page, 'Peer mode')

    await page.getByRole('button', { name: 'Peer Connection' }).click()
    await page.getByRole('button', { name: /Connect a real guest/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Connect a guest' })
    await expect(dialog).toBeVisible()

    // The session id must not be presented as a credential.
    await expect(dialog.getByText(/not a password and grants no access/i)).toBeVisible()

    // The NAT limitation is stated before the user invests in the flow.
    await expect(dialog.getByText(/symmetric NAT/i)).toBeVisible()
    await expect(dialog.getByText(/TURN/i).first()).toBeVisible()
  })

  test('generates an offer containing gathered ICE candidates', async ({ page }) => {
    await createSession(page)
    await page.getByRole('button', { name: 'Peer Connection' }).click()
    await page.getByRole('button', { name: /Connect a real guest/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Connect a guest' })
    await dialog.getByRole('button', { name: 'Create offer' }).click()

    // Vanilla ICE: the code is only produced once gathering finished.
    const code = dialog.getByLabel('Host offer code')
    await expect(code).toBeVisible({ timeout: 30_000 })

    const value = await code.inputValue()
    expect(value.startsWith('LD1:')).toBe(true)

    // Decode and confirm candidates really are embedded.
    const decoded = await page.evaluate((payload: string) => {
      const binary = atob(payload.slice(4))
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return JSON.parse(new TextDecoder().decode(bytes)) as { sdp: string; kind: string }
    }, value)

    expect(decoded.kind).toBe('offer')
    expect(decoded.sdp).toContain('v=0')
    expect(decoded.sdp).toMatch(/a=candidate:/)

    // The assessment reflects what was actually gathered.
    await expect(dialog.getByText(/ICE gathering:/i)).toBeVisible()

    // A guest row exists but is honest about not being connected.
    // `.first()` because the status appears both as a visually-hidden status
    // label and as the visible sentence beneath the guest's name.
    const guests = page.getByRole('region', { name: 'Guests' })
    await expect(
      guests.getByText(/Waiting for this guest’s answer|No connection/i).first(),
    ).toBeVisible()
  })

  test('rejects malformed and wrong-direction codes with specific messages', async ({ page }) => {
    await createSession(page)
    await page.getByRole('button', { name: 'Peer Connection' }).click()
    await page.getByRole('button', { name: /Connect a real guest/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Connect a guest' })
    // The role selector is a tablist, not a pair of buttons.
    await dialog.getByRole('tab', { name: /joining as a guest/i }).click()

    const paste = dialog.getByLabel('Host offer code')
    await paste.fill('this is not a connection code')
    await dialog.getByRole('button', { name: /Apply offer/i }).click()
    await expect(dialog.getByText(/does not look like a LiveDeck connection code/i)).toBeVisible()

    // A truncated code is the most common real mistake.
    await paste.fill('LD1:' + btoa('{"v":1,"kind":"offer","peerId":"p","sdp":"broken"}'))
    await dialog.getByRole('button', { name: /Apply offer/i }).click()
    await expect(dialog.getByText(/truncated/i)).toBeVisible()
  })

  test('completes a handshake between two browser contexts', async ({ browser }) => {
    // Two independent contexts — separate storage, separate peer connections.
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      await createSession(host, 'Host side')
      await startCamera(host)
      await host.getByRole('button', { name: 'Peer Connection' }).click()
      await host.getByRole('button', { name: /Connect a real guest/i }).click()

      const hostDialog = host.getByRole('dialog', { name: 'Connect a guest' })
      await hostDialog.getByRole('button', { name: 'Create offer' }).click()
      const offerCode = await hostDialog
        .getByLabel('Host offer code')
        .inputValue({ timeout: 30_000 })
      expect(offerCode.startsWith('LD1:')).toBe(true)

      // Guest side: apply the offer, produce an answer.
      await createSession(guest, 'Guest side')
      await startCamera(guest)
      await guest.getByRole('button', { name: 'Peer Connection' }).click()
      await guest.getByRole('button', { name: /Connect a real guest/i }).click()

      const guestDialog = guest.getByRole('dialog', { name: 'Connect a guest' })
      await guestDialog.getByRole('tab', { name: /joining as a guest/i }).click()
      await guestDialog.getByLabel('Host offer code').fill(offerCode)
      await guestDialog.getByRole('button', { name: /Apply offer and create answer/i }).click()

      const answerCode = await guestDialog
        .getByLabel('Guest answer code')
        .inputValue({ timeout: 30_000 })
      expect(answerCode.startsWith('LD1:')).toBe(true)

      // Host applies the answer; connectivity checks run.
      await hostDialog.getByRole('tab', { name: /I am the host/i }).click()
      await hostDialog.getByLabel('Guest answer code').fill(answerCode)
      await hostDialog.getByRole('button', { name: /Apply answer/i }).click()

      // Both sides should reach a genuinely connected state on one host.
      await expect(
        host
          .getByRole('region', { name: 'Guests' })
          .getByText('Connected', { exact: true })
          .first(),
      ).toBeVisible({ timeout: 45_000 })
      await expect(
        guest
          .getByRole('region', { name: 'Guests' })
          .getByText('Connected', { exact: true })
          .first(),
      ).toBeVisible({ timeout: 45_000 })

      // Removing the guest must also close its peer connection, not just drop
      // the row. The invite dialog is dismissed first so it does not sit over
      // the studio.
      await hostDialog.getByRole('button', { name: 'Close dialog' }).click()
      await expect(hostDialog).toBeHidden()

      const guestsPanel = host.getByRole('region', { name: 'Guests' })
      await guestsPanel.getByRole('button', { name: /^Remove Guest/i }).first().click()
      await host
        .getByRole('dialog')
        .getByRole('button', { name: 'Remove guest', exact: true })
        .click()

      await expect(guestsPanel.getByText(/No guests/i)).toBeVisible({ timeout: 20_000 })

      // The guest side observes the close too, so no peer is left connected.
      await expect(
        guest
          .getByRole('region', { name: 'Guests' })
          .getByText('Connected', { exact: true })
          .first(),
      ).toBeHidden({ timeout: 30_000 })
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
})
