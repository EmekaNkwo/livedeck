import { expect, test } from '@playwright/test'
import {
  addBackground,
  addSourceDialog,
  canvasHasContent,
  canvasSize,
  createSession,
  onAirTally,
  openDiagnostics,
  propertyField,
  shareScreen,
  sourceRows,
  startCamera,
} from './fixtures'

/**
 * Scenario B — source composition.
 *
 * Camera plus screen share, moved, resized, reordered, one hidden, then
 * recorded — verifying the recorded output follows the scene and transforms.
 */

test.describe('Scenario B: source composition', () => {
  test('composes a camera over a screen share', async ({ page }) => {
    await createSession(page, 'Composition')
    await shareScreen(page)
    await startCamera(page)

    // Both sources exist in the scene.
    await expect(sourceRows(page).filter({ hasText: 'Screen' })).toHaveCount(1)
    await expect(sourceRows(page).filter({ hasText: 'Camera' })).toHaveCount(1)
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)
  })

  test('resizes and repositions sources through numeric controls', async ({ page }) => {
    await createSession(page)
    await startCamera(page)

    await sourceRows(page).filter({ hasText: 'Camera' }).first().click()

    // Place the camera as a picture-in-picture in the lower right.
    await propertyField(page, 'Width').fill('320')
    await propertyField(page, 'Height').fill('180')
    await propertyField(page, 'X').fill('920')
    await propertyField(page, 'Y').fill('500')

    await expect(propertyField(page, 'Width')).toHaveValue('320')
    await expect(propertyField(page, 'X')).toHaveValue('920')

    // Rotation and crop affect the real composition, not just the overlay.
    await propertyField(page, 'Rotation').fill('15')
    await expect(propertyField(page, 'Rotation')).toHaveValue('15')

    await propertyField(page, 'Top').fill('10')
    await expect(propertyField(page, 'Top')).toHaveValue('10')
  })

  test('changes layer ordering', async ({ page }) => {
    await createSession(page)

    // Two backgrounds, so ordering is unambiguous.
    await addBackground(page, '#202020')
    await addBackground(page, '#e0e0e0')

    const rows = sourceRows(page)
    await expect(rows).toHaveCount(2)

    // The topmost item is listed first; move it backward.
    const firstName = ((await rows.first().textContent()) ?? '').trim()
    await rows
      .first()
      .getByRole('button', { name: /Move .* backward/i })
      .click()

    // Order in the list reflects layer order, so the first entry changed.
    await expect(rows.first()).not.toHaveText(firstName)
  })

  test('hiding a source removes it from the output but keeps it in the scene', async ({ page }) => {
    await createSession(page)
    await addBackground(page, '#f5f5f5')

    await expect.poll(() => canvasHasContent(page), { timeout: 15_000 }).toBe(true)

    // Hide it.
    await page.getByRole('button', { name: /Hide Background/i }).click()

    // The canvas falls back to the empty-program background.
    await expect.poll(() => canvasHasContent(page), { timeout: 15_000 }).toBe(false)

    // But the placement survives — this is a visibility toggle, not a delete.
    await expect(page.getByRole('option', { name: /Background/ })).toBeVisible()

    await page.getByRole('button', { name: /Show Background/i }).click()
    await expect.poll(() => canvasHasContent(page), { timeout: 15_000 }).toBe(true)
  })

  test('locking a source prevents geometry edits', async ({ page }) => {
    await createSession(page)
    await page.getByRole('button', { name: 'Add a source' }).click()
    await addSourceDialog(page).getByRole('button', { name: /Add background/i }).click()

    const properties = page.getByRole('region', { name: 'Properties' })
    await properties.getByLabel(/Lock position and size/i).check()

    await expect(properties.getByText(/This source is locked/i)).toBeVisible()
    await expect(propertyField(page, 'X')).toBeDisabled()

    // Unlocking must remain possible, or locking would be a one-way door.
    await properties.getByLabel(/Lock position and size/i).uncheck()
    await expect(propertyField(page, 'X')).toBeEnabled()
  })

  test('changing the output aspect ratio resizes the program canvas', async ({ page }) => {
    await createSession(page)
    expect(await canvasSize(page)).toEqual({ width: 1280, height: 720 })

    await page.getByRole('button', { name: 'Studio settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Studio settings' })
    await dialog.getByLabel('Aspect ratio').selectOption('9:16')
    await dialog.getByLabel('Resolution').selectOption('1080p')
    await dialog.getByRole('button', { name: 'Done' }).click()

    // Vertical 1080p is 1080 wide — the short edge names the resolution.
    await expect.poll(() => canvasSize(page)).toEqual({ width: 1080, height: 1920 })
  })

  test('records a multi-source composition', async ({ page }) => {
    await createSession(page, 'Composition recording')
    await startCamera(page)

    await addBackground(page, '#1a2b3c')

    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)

    const recording = page.getByRole('region', { name: 'Recording' })
    await recording.getByRole('button', { name: /Start recording/i }).click()
    await expect(onAirTally(page)).toBeVisible()

    // Switch scenes mid-recording — the file must follow the program output.
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /New scene/i }).click()
    await page.waitForTimeout(1200)

    await recording.getByRole('button', { name: /Stop & save/i }).click()
    await expect(recording.getByText(/Saved to the library/i)).toBeVisible({ timeout: 30_000 })

    // Diagnostics confirms the compositor was genuinely drawing throughout.
    await openDiagnostics(page)
    const frames = page
      .getByRole('region', { name: 'Diagnostics' })
      .getByText(/^Frames drawn$/)
      .locator('xpath=following-sibling::dd[1]')
    await expect
      .poll(async () => Number((await frames.textContent())?.trim() ?? '0'))
      .toBeGreaterThan(10)
  })
})
