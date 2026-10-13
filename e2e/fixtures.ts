import { type Page, expect } from '@playwright/test'

/**
 * Shared helpers for the browser tests.
 *
 * These reach into the page to assert on *real* pipeline state — canvas pixel
 * dimensions, track readyStates, mixer channel counts — rather than only
 * checking that labels rendered. That is the difference between proving the
 * media pipeline works and proving the UI changed colour.
 */

export async function createSession(page: Page, name = 'E2E production'): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Session name').fill(name)
  await page.getByRole('button', { name: 'Create session' }).click()
  await expect(page).toHaveURL(/\/studio\//)
  // The compositor attaches its canvas once the shell mounts.
  await expect(page.locator('canvas').first()).toBeVisible()
}

export async function startCamera(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Start camera/i }).click()
  // "Active" only appears once a live video track exists.
  await expect(
    page.getByRole('region', { name: 'Camera' }).getByText('Active', { exact: true }),
  ).toBeVisible()
}

export async function startMicrophone(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Start microphone/i }).click()
  await expect(
    page.getByRole('region', { name: 'Microphone' }).getByText('Active', { exact: true }),
  ).toBeVisible()
}

export async function shareScreen(page: Page): Promise<void> {
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
 * A numeric field in the properties panel.
 *
 * `exact` is required: `getByLabel` is a case-insensitive substring match by
 * default, so "Y" would also match "Opacity" and "Layer order".
 */
export function propertyField(page: Page, label: string) {
  return page.getByRole('region', { name: 'Properties' }).getByLabel(label, { exact: true })
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
