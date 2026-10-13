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

/**
 * A participant tile, found by the caption naming who it is.
 *
 * Excludes the shared-screen region, which is also a captioned `figure` naming
 * the same person — "Ana · sharing a screen" — and would otherwise make every
 * lookup for Ana ambiguous the moment she shares.
 */
function tileFor(page: Page, name: string) {
  return page
    .locator('figure')
    .filter({ has: page.getByText(name, { exact: false }) })
    .filter({ hasNotText: 'sharing a screen' })
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

      // No program cell, ever: a control room is not a participant.
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

  /**
   * A control room in the room changes nothing about what guests see.
   *
   * It receives every guest and sends nothing back, so it has no tile and no
   * feed. It used to send its composed program to each guest, which put a
   * black rectangle — a program with no sources started is a black canvas — in
   * the middle of a call the director is not part of.
   */
  test('a director in the room is invisible to guests', async ({ browser }) => {
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

      // The control room sees the guest...
      await expect(
        host.getByRole('region', { name: 'Guests' }).getByText('Connected', { exact: true }).first(),
      ).toBeVisible({ timeout: 45_000 })

      // ...and the guest sees only themselves. No program, no director tile.
      await expect(guest.locator('figure').filter({ hasText: 'Program' })).toHaveCount(0)
      await expect(guest.locator('figure').filter({ hasText: 'director' })).toHaveCount(0)
      await expect(guest.locator('figure')).toHaveCount(1)
      await expect(guest.locator('figure').first()).toContainText('(you)')
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })

  /**
   * Joining must not switch anything on.
   *
   * It used to start the camera and the microphone for you, which meant
   * arriving in a room broadcasting a room you had not agreed to broadcast —
   * the one decision a conferencing tool must never make on somebody's behalf.
   */
  test('joining does not turn on a camera or microphone you did not', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(context, 'server')
    const page = await context.newPage()

    try {
      await joinAs(page, 'mesh-consent', 'Ana')

      // Both controls still read "on" — i.e. they are off and offering to start.
      await expect(page.getByRole('button', { name: 'Turn camera on' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Turn microphone on' })).toBeVisible()

      // And nothing is live: no track was ever acquired.
      const live = await page.evaluate(() => {
        const videos = [...document.querySelectorAll('video')]
        return videos.filter((v) => v.srcObject !== null).length
      })
      expect(live).toBe(0)
      await expect(page.locator('figure').first()).toContainText('Camera off')
    } finally {
      await context.close()
    }
  })

  /**
   * A track that only appears after the connection is established.
   *
   * There is no renegotiation anywhere in this project, so the m-lines present
   * at offer time are all there will ever be. They used to be declared
   * `recvonly`, which left no sender to put a later track into — so a guest who
   * joined with their camera off stayed invisible for the whole call however
   * many times they pressed the button.
   */
  test('turning a camera on after joining reaches the other guest', async ({ browser }) => {
    const first = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const second = await browser.newContext({ permissions: ['camera', 'microphone'] })
    await useSignalingTransport(first, 'server')
    await useSignalingTransport(second, 'server')
    const ana = await first.newPage()
    const bo = await second.newPage()

    try {
      // Both join with nothing running.
      await joinAs(ana, 'mesh-late', 'Ana')
      await joinAs(bo, 'mesh-late', 'Bo')
      await expect(tileFor(bo, 'Ana')).toBeVisible({ timeout: 45_000 })

      // Now Ana starts her camera, well after the handshake completed.
      await ana.getByRole('button', { name: 'Turn camera on' }).click()

      await decodesFrames(bo, 'Ana')
    } finally {
      await first.close()
      await second.close()
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

      /*
       * The screen reaches the other guest as a *region of its own*, not as a
       * cell in the participant grid. It used to be a tile, which made the
       * whole layout lurch the moment anybody shared.
       */
      const shared = bo.getByLabel(/is sharing a screen/i)
      await expect(shared).toBeVisible({ timeout: 45_000 })
      await expect
        .poll(() => shared.evaluate((el) => (el as HTMLVideoElement).readyState), {
          timeout: 45_000,
        })
        .toBeGreaterThanOrEqual(2)

      // The sharer is told over the control channel — WebRTC carries no hint
      // about what a track is *of*, so without the report the receiver cannot
      // tell a shared document from a face.
      await expect(tileFor(bo, 'Ana').getByText('sharing')).toBeVisible({ timeout: 30_000 })

      // The sharer is never shown their own screen: sharing the tab that holds
      // this view would render it inside itself, forever.
      await expect(ana.getByText('You are sharing your screen')).toBeVisible()

      // Stopping puts the room back to an even grid.
      await ana.getByRole('button', { name: /Stop sharing/i }).click()
      await expect(bo.getByLabel(/is sharing a screen/i)).toHaveCount(0, { timeout: 30_000 })
      await expect(tileFor(bo, 'Ana').getByText('sharing')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await first.close()
      await second.close()
    }
  })

})
