import { expect, test } from '@playwright/test'
import { openDirector, openTab, startCamera, useSignalingTransport } from './fixtures'

/**
 * Scenario D — the invite-link workflow and real peer connections.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * These drive the real handshake in real browser contexts: a genuine
 * `RTCPeerConnection` produces an offer with ICE candidates gathered, that
 * offer travels inside a link the guest opens, the guest answers, and the
 * director applies it. Both contexts run on one machine, so host candidates
 * always match — this verifies the *workflow and the state machine*, not NAT
 * traversal, which cannot be established from a test runner on a single host.
 *
 * These cover the MANUAL transport specifically — the zero-infrastructure path
 * where the link carries the offer and the answer comes back by hand. It is no
 * longer the default, so every test here opts into it explicitly. The
 * room-based default is covered by `room.spec.ts`, which needs the relay.
 */

test.describe('Scenario D: invite links and peer connections', () => {
  test.beforeEach(async ({ page }) => {
    await useSignalingTransport(page, 'manual')
  })

  test('states the STUN-only limitation before the operator invests in it', async ({ page }) => {
    await openDirector(page, 'peer-limits')
    await openTab(page, /Guests/)

    const guests = page.getByRole('region', { name: 'Guests' })

    // The NAT limitation is on the page, not buried in docs.
    await expect(guests.getByText(/symmetric NAT/i)).toBeVisible()
    await expect(guests.getByText(/TURN/i).first()).toBeVisible()
  })

  test('generates an invite link carrying gathered ICE candidates in its fragment', async ({
    page,
  }) => {
    await openDirector(page, 'peer-offer')
    await openTab(page, /Guests/)

    await page.getByRole('button', { name: /Create invite link/i }).click()

    // Vanilla ICE: the link only appears once gathering has finished.
    const linkBox = page.getByLabel('Guest invite link')
    await expect(linkBox).toBeVisible({ timeout: 30_000 })

    const url = await linkBox.inputValue()
    expect(url).toContain('/push/peer-offer')
    // The payload must be in the fragment — browsers never send that to a server.
    expect(url).toMatch(/#i=LD1z?:/)

    // Decode the fragment and confirm real candidates are embedded.
    const decoded = await page.evaluate(async (value: string) => {
      const token = value.slice(value.indexOf('#i=') + 3)
      const separator = token.indexOf(':')
      const prefix = token.slice(0, separator)
      const body = token.slice(separator + 1).replace(/-/g, '+').replace(/_/g, '/')
      const padded = body + '='.repeat((4 - (body.length % 4)) % 4)
      const binary = atob(padded)
      let bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      if (prefix === 'LD1z') {
        const stream = new Blob([bytes as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'))
        bytes = new Uint8Array(await new Response(stream).arrayBuffer())
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as { sdp: string; kind: string }
    }, url)

    expect(decoded.kind).toBe('offer')
    expect(decoded.sdp).toContain('v=0')
    expect(decoded.sdp).toMatch(/a=candidate:/)

    // The assessment reflects what was actually gathered.
    await expect(page.getByText(/ICE gathering:/i)).toBeVisible()

    // A guest row exists but is honest about not being connected.
    await expect(
      page
        .getByRole('region', { name: 'Guests' })
        .getByText(/Waiting for this guest’s answer|No connection/i)
        .first(),
    ).toBeVisible()
  })

  test('rejects a malformed answer paste with a specific message', async ({ page }) => {
    await openDirector(page, 'peer-bad-paste')
    await openTab(page, /Guests/)

    const paste = page.getByLabel('Guest answer link or code')
    await paste.fill('hey can you send that again')
    await page.getByRole('button', { name: /Connect guest/i }).click()
    await expect(page.getByText(/does not look like a LiveDeck connection code/i)).toBeVisible()
  })

  test('rejects an invite link pasted into the answer box', async ({ page }) => {
    await openDirector(page, 'peer-wrong-way')
    await openTab(page, /Guests/)

    await page.getByRole('button', { name: /Create invite link/i }).click()
    const url = await page.getByLabel('Guest invite link').inputValue({ timeout: 30_000 })

    // Pasting your own invite where the answer belongs is an easy mistake and
    // must be named, not silently accepted.
    await page.getByLabel('Guest answer link or code').fill(url)
    await page.getByRole('button', { name: /Connect guest/i }).click()
    await expect(page.getByText(/invite link, not an answer/i)).toBeVisible()
  })

  test('completes a handshake by opening the invite link in a second browser', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    // Fresh contexts, so the describe-level seeding does not reach them.
    await useSignalingTransport(hostContext, 'manual')
    await useSignalingTransport(guestContext, 'manual')
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()

    try {
      /* ---------------- director: build the invite link ---------------- */
      await openDirector(host, 'peer-handshake')
      await startCamera(host)
      await openTab(host, /Guests/)

      await host.getByRole('button', { name: /Create invite link/i }).click()
      const inviteUrl = await host
        .getByLabel('Guest invite link')
        .inputValue({ timeout: 30_000 })
      expect(inviteUrl).toContain('/push/peer-handshake')

      /* ------------------- guest: just open the link ------------------- */
      await guest.goto(inviteUrl)

      // No name is baked into the link any more — the guest is anonymous until
      // they say otherwise, and the manual flow has no join screen to ask on.
      // The name captions their own self-view tile.
      await expect(guest.locator('figcaption')).toHaveText('Guest')

      await guest.getByRole('button', { name: 'Turn camera on' }).click()

      // The offer is applied automatically from the fragment, and an answer
      // link is produced without the guest doing anything.
      const answerUrl = await guest
        .getByLabel('Your answer link')
        .inputValue({ timeout: 45_000 })
      expect(answerUrl).toContain('/director/peer-handshake')
      expect(answerUrl).toMatch(/#a=LD1z?:/)

      // The fragment is cleared once consumed, so a reload cannot re-apply it.
      expect(guest.url()).not.toContain('#i=')

      /* ------------- director: apply the answer, get connected ---------- */
      await host.getByLabel('Guest answer link or code').fill(answerUrl)
      await host.getByRole('button', { name: /Connect guest/i }).click()

      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText('Connected', { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 })
      await expect(
        guest.getByText('Connected', { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 })

      /* ------------- the control channel actually reaches the guest ----- */
      // Mute the guest's microphone from the control room and verify the
      // *guest's own* UI reflects it — proof the command crossed the data
      // channel rather than only changing the director's local mix.
      await guest.getByRole('button', { name: 'Turn microphone on' }).click()
      // The control reads "off" once the microphone is live and unmuted, which
      // is the state the director is about to change.
      await expect(
        guest.getByRole('button', { name: 'Turn microphone off' }),
      ).toBeVisible({ timeout: 20_000 })

      const guestTile = host
        .getByRole('region', { name: 'Guests' })
        .getByRole('listitem')
        .first()
      await guestTile.getByRole('button', { name: 'Mic' }).click()

      // The *guest's own* control flips, which can only happen if the command
      // crossed the data channel and disabled their track.
      await expect(guest.getByRole('button', { name: 'Turn microphone on' })).toBeVisible({
        timeout: 20_000,
      })

      // And a cue from the director arrives as an alert on the guest.
      await host.getByLabel('Message to send to every guest').fill('90 seconds')
      await host.getByRole('button', { name: /Cue all/i }).click()
      await expect(guest.getByRole('alert')).toContainText('90 seconds', { timeout: 20_000 })

      /* ------------------------- teardown ------------------------------ */
      await guestTile.getByRole('button', { name: /^Remove / }).click()
      await host
        .getByRole('dialog')
        .getByRole('button', { name: 'Remove guest', exact: true })
        .click()

      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText(/No guests/i),
      ).toBeVisible({ timeout: 20_000 })
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })

  test('the scene route renders a clean output with no interface', async ({ page }) => {
    await page.goto('/scene/peer-scene')

    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()

    // The capture target must contain no chrome at all.
    await expect(page.getByRole('banner')).toHaveCount(0)
    await expect(page.getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('tablist')).toHaveCount(0)

    // Logical output size, independent of the window.
    expect(
      await canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement
        return { width: target.width, height: target.height }
      }),
    ).toEqual({ width: 1280, height: 720 })
  })

  test('URL parameters configure the output for a scene capture', async ({ page }) => {
    await page.goto('/scene/peer-params?ratio=9:16&quality=1080')

    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()

    // Vertical 1080p is 1080 wide — the short edge names the resolution.
    await expect
      .poll(() =>
        canvas.evaluate((element) => {
          const target = element as HTMLCanvasElement
          return `${target.width}x${target.height}`
        }),
      )
      .toBe('1080x1920')
  })
})
