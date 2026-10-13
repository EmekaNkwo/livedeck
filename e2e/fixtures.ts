import { type BrowserContext, type Page, expect } from '@playwright/test'

/**
 * Shared helpers for the browser tests.
 *
 * These reach into the page to assert on *real* pipeline state — canvas pixel
 * dimensions, track readyStates, mixer channel counts — rather than only
 * checking that labels rendered. That is the difference between proving the
 * media pipeline works and proving the UI changed colour.
 */

/**
 * Force a signaling transport before the app boots.
 *
 * The studio defaults to room-based signaling, which needs the relay. Tests
 * that exercise the manual invite-link flow have to say so explicitly — seeding
 * the persisted setting is how, because the choice is read during the first
 * render and switching it through the UI afterwards would tear down and rebuild
 * the adapter mid-test.
 *
 * The shape here is zustand's persist envelope; `version: 2` keeps the store's
 * own v1→v2 migration (which moves old installs to rooms) from undoing this.
 */
export async function useSignalingTransport(
  target: Page | BrowserContext,
  transport: 'manual' | 'server',
): Promise<void> {
  await target.addInitScript(
    ([key, value, url]) => {
      window.localStorage.setItem(
        key as string,
        JSON.stringify({
          state: { settings: { signalingTransport: value, signalingServerUrl: url } },
          version: 2,
        }),
      )
    },
    ['livedeck:v1:settings', transport, RELAY_URL],
  )
}

/**
 * Where the relay under test listens.
 *
 * Pinned explicitly rather than left to the app's own resolution, because 3001
 * is a popular port and a *different* process answering it fails in the most
 * confusing way available: TCP connects, the WebSocket upgrade is never
 * answered, and the transport sits in `connecting` forever. Overriding both
 * this and `PORT` for the relay moves the whole test out of the way.
 *
 *     LIVEDECK_RELAY_PORT=3100 npm run e2e
 */
export const RELAY_PORT = process.env.LIVEDECK_RELAY_PORT ?? '3001'
export const RELAY_URL = `ws://localhost:${RELAY_PORT}`

/**
 * Open the director control room for a room.
 *
 * Rooms are addressed by name, so navigating to `/director/<room>` creates it.
 * Goes via the landing page's role card so the entry flow is exercised too.
 */
export async function openDirector(page: Page, room = 'e2e-room'): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Room name').fill(room)
  await page.getByRole('button', { name: /Open director/i }).click()
  await expect(page).toHaveURL(new RegExp(`/director/${room}`))
  // The compositor attaches its canvas once the room mounts.
  await expect(page.locator('canvas').first()).toBeVisible()
}

/** Navigate straight to a role URL, as a shared link would. */
export async function openRole(
  page: Page,
  role: 'director' | 'push' | 'scene',
  room: string,
  query = '',
): Promise<void> {
  await page.goto(`/${role}/${room}${query}`)
}

/** Switch the control room to one of its tabs. */
export async function openTab(page: Page, label: string | RegExp): Promise<void> {
  await page.getByRole('tab', { name: label }).click()
}

export async function startCamera(page: Page): Promise<void> {
  await openTab(page, /Sources/)
  await page.getByRole('button', { name: /Start camera/i }).click()
  // "Active" only appears once a live video track exists.
  await expect(
    page.getByRole('region', { name: 'Camera' }).getByText('Active', { exact: true }),
  ).toBeVisible()
}

export async function startMicrophone(page: Page): Promise<void> {
  await openTab(page, /Sources/)
  await page.getByRole('button', { name: /Start microphone/i }).click()
  await expect(
    page.getByRole('region', { name: 'Microphone' }).getByText('Active', { exact: true }),
  ).toBeVisible()
}

export async function shareScreen(page: Page): Promise<void> {
  await openTab(page, /Sources/)
  await page.getByRole('button', { name: /Share screen/i }).click()
  await expect(
    page.getByRole('region', { name: 'Screen sharing' }).getByText('Active', { exact: true }),
  ).toBeVisible()
}

/** Read the program canvas's backing-store size — the real output resolution. */
export async function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return page.locator('canvas').first().evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    return { width: canvas.width, height: canvas.height }
  })
}

/**
 * Sample the program canvas and report whether it contains non-background
 * pixels — i.e. whether anything is actually being composited.
 */
export async function canvasHasContent(page: Page): Promise<boolean> {
  return page.locator('canvas').first().evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext('2d')
    if (!context) return false
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    // The background is #08090c; anything meaningfully brighter is a source.
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      if (r > 40 || g > 40 || b > 40) return true
    }
    return false
  })
}

/**
 * Expand the diagnostics panel.
 *
 * The panel is a lazily-loaded chunk and starts collapsed, so this waits for
 * the region to be attached before deciding whether to click the disclosure.
 */
export async function openDiagnostics(page: Page): Promise<void> {
  await openTab(page, /Diagnostics/)
  const panel = page.getByRole('region', { name: 'Diagnostics' })
  await expect(panel).toBeAttached({ timeout: 20_000 })

  const expand = panel.getByRole('button', { name: /Expand Diagnostics/i })
  if ((await expand.count()) > 0) await expand.click()

  await expect(panel.getByText('Compositor')).toBeVisible()
}

/**
 * The Add-source dialog, scoped so its fields do not collide with the
 * identically-labelled ones in the properties panel.
 */
export function addSourceDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Add a source' })
}

/** Add a colour background with a specific colour. */
export async function addBackground(page: Page, color: string): Promise<void> {
  await openTab(page, /Sources/)
  await page.getByRole('button', { name: 'Add a source' }).click()
  const dialog = addSourceDialog(page)
  await dialog.getByLabel('Colour', { exact: true }).fill(color)
  await dialog.getByRole('button', { name: /Add background/i }).click()
  await expect(dialog).toBeHidden()
}

/**
 * The ON AIR tally in the session bar. Scoped to the header because the active
 * scene card also carries an "On air" badge.
 */
export function onAirTally(page: Page) {
  return page.locator('header').getByText('On air')
}

/**
 * Rows in the Sources list.
 *
 * Scoped to the listbox: `<select>` elements elsewhere in the studio (the
 * layer-order control, device pickers) also expose `option` roles, so an
 * unscoped `getByRole('option')` would match them too.
 */
export function sourceRows(page: Page) {
  return page.getByRole('listbox', { name: /Sources in this scene/i }).getByRole('option')
}

/**
 * Scene tabs only.
 *
 * Scoped to the Scenes tablist: the control room's own panel switcher is also
 * a tablist, so an unscoped `getByRole('tab')` matches both.
 */
export function sceneTabs(page: Page) {
  return page.getByRole('tablist', { name: 'Scenes' }).getByRole('tab')
}

/** Open the Mix & record tab and return the Recording region. */
export async function recordingPanel(page: Page) {
  await openTab(page, /Mix & record/)
  const panel = page.getByRole('region', { name: 'Recording' })
  await expect(panel).toBeVisible()
  return panel
}

/** Open the Sources tab, where capture controls and the source list live. */
export async function openSources(page: Page): Promise<void> {
  await openTab(page, /Sources/)
}

/** Guest tiles in the control room. */
export function guestTiles(page: Page) {
  return page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Remove / }) })
}

/**
 * A numeric field in the properties panel.
 *
 * `exact` is required: `getByLabel` is a case-insensitive substring match by
 * default, so "Y" would also match "Opacity" and "Layer order".
 */
export function propertyField(page: Page, label: string) {
  return page.getByRole('region', { name: 'Properties' }).getByLabel(label, { exact: true })
}

/** Open the Scenes tab, where the properties panel lives. */
export async function openProperties(page: Page): Promise<void> {
  await openTab(page, /Scenes/)
  await expect(page.getByRole('region', { name: 'Properties' })).toBeAttached()
}

/** Open the Mix & record tab. */
export async function openMix(page: Page): Promise<void> {
  await openTab(page, /Mix & record/)
}

/** Wait until the compositor reports it is drawing frames. */
export async function waitForCompositor(page: Page): Promise<void> {
  await openDiagnostics(page)
  const running = page
    .getByRole('region', { name: 'Diagnostics' })
    .getByText(/^Running$/)
    .locator('xpath=following-sibling::dd[1]')
  await expect(running).toHaveText('yes')
}
