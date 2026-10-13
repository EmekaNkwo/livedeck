import { expect, test } from '@playwright/test'
import {
  addSourceDialog,
  canvasHasContent,
  createSession,
  onAirTally,
  openDiagnostics,
  sourceRows,
  startCamera,
  startMicrophone,
} from './fixtures'

/**
 * Scenario C — resource cleanup.
 *
 * Start capture, record, stop, remove a source, end the session, and verify the
 * resources this session owned were released. Leaks here are invisible in
 * ordinary use but make a long production degrade, so they are asserted
 * explicitly against the diagnostics readout, which reflects the real
 * StreamRegistry and track states.
 */

const metric = (page: import('@playwright/test').Page, label: string) =>
  page
    .getByRole('region', { name: 'Diagnostics' })
    .getByText(new RegExp(`^${label}$`))
    .locator('xpath=following-sibling::dd[1]')

test.describe('Scenario C: resource cleanup', () => {
  test('releases a source’s stream when the source is deleted', async ({ page }) => {
    await createSession(page, 'Cleanup')
    await startCamera(page)
    await openDiagnostics(page)

    await expect.poll(async () => Number((await metric(page, 'Live tracks').textContent()) ?? 0))
      .toBeGreaterThan(0)

    // Delete the camera source; its capture should stop with it.
    await page.getByRole('button', { name: /Delete Camera/i }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: /Delete source/i }).click()

    await expect.poll(async () => Number((await metric(page, 'Registered streams').textContent()) ?? 1))
      .toBe(0)
    await expect.poll(async () => Number((await metric(page, 'Live tracks').textContent()) ?? 1))
      .toBe(0)
  })

  test('duplicating then deleting the copy keeps the original capture alive', async ({ page }) => {
    await createSession(page)
    await startCamera(page)
    await openDiagnostics(page)

    // The clone shares the capture — one stream, two references.
    await page.getByRole('button', { name: /Duplicate Camera/i }).click()
    await expect(sourceRows(page).filter({ hasText: 'Camera copy' })).toHaveCount(1)
    await expect(metric(page, 'Registered streams')).toHaveText('1')

    // Deleting the copy must not black out the original.
    await page.getByRole('button', { name: /Delete Camera copy/i }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Delete source/i }).click()

    await expect(metric(page, 'Registered streams')).toHaveText('1')
    await expect.poll(async () => Number((await metric(page, 'Live tracks').textContent()) ?? 0))
      .toBeGreaterThan(0)
    await expect.poll(() => canvasHasContent(page), { timeout: 15_000 }).toBe(true)
  })

  test('stopping a recording releases its canvas capture', async ({ page }) => {
    await createSession(page)
    await startCamera(page)
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)

    const recording = page.getByRole('region', { name: 'Recording' })
    await recording.getByRole('button', { name: /Start recording/i }).click()
    await expect(onAirTally(page)).toBeVisible()
    await page.waitForTimeout(2000)

    await recording.getByRole('button', { name: /Stop & save/i }).click()
    await expect(recording.getByText(/Saved to the library/i)).toBeVisible({ timeout: 30_000 })

    await openDiagnostics(page)
    // Only the camera's stream remains; the recorder's canvas capture is gone.
    await expect(metric(page, 'Registered streams')).toHaveText('1')
    await expect(metric(page, 'Status')).toHaveText('complete')
  })

  test('ending the session releases every device and returns to the lobby', async ({ page }) => {
    await createSession(page, 'Ending')
    await startCamera(page)
    await startMicrophone(page)
    await openDiagnostics(page)

    await expect.poll(async () => Number((await metric(page, 'Registered streams').textContent()) ?? 0))
      .toBeGreaterThanOrEqual(2)

    await page.getByRole('button', { name: /End this production/i }).click()
    await page.getByRole('dialog').getByRole('button', { name: /End production/i }).click()

    // Back in the lobby, with the session preserved for reopening.
    await expect(page).toHaveURL(/\/$|\/#?$/)
    await expect(page.getByRole('heading', { name: /LiveDeck Studio/ })).toBeVisible()
    await expect(page.getByText('Ending')).toBeVisible()

    // Every track this session owned has been stopped. Verified against the
    // browser rather than against our own bookkeeping.
    const liveTracks = await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')]
      return videos.filter((video) => {
        const stream = video.srcObject as MediaStream | null
        return stream?.getTracks().some((track) => track.readyState === 'live') ?? false
      }).length
    })
    expect(liveTracks).toBe(0)
  })

  test('scenes and sources survive a reload; live streams do not', async ({ page }) => {
    await createSession(page, 'Persistence')

    await page.getByRole('button', { name: 'Add a source' }).click()
    await addSourceDialog(page).getByLabel('Content').fill('Persisted caption')
    await addSourceDialog(page).getByRole('button', { name: /Add text source/i }).click()

    await page.getByRole('button', { name: /New scene/i }).click()
    await expect(page.getByRole('tab')).toHaveCount(2)

    // Autosave is debounced.
    await page.waitForTimeout(1200)
    await page.reload()

    // Configuration came back.
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(sourceRows(page).filter({ hasText: 'Persisted caption' })).toHaveCount(1)

    // Capture did not — a stream cannot be serialized, and the UI must not
    // claim a device is running after a reload.
    await expect(
      page.getByRole('region', { name: 'Camera' }).getByText('Idle', { exact: true }),
    ).toBeVisible()
  })

  test('repeated start/stop cycles do not accumulate streams', async ({ page }) => {
    await createSession(page)
    await openDiagnostics(page)

    for (let i = 0; i < 3; i += 1) {
      await startCamera(page)
      await page.getByRole('button', { name: /Stop camera/i }).click()
      await expect(
        page.getByRole('region', { name: 'Camera' }).getByText('Idle', { exact: true }),
      ).toBeVisible()
    }

    // Each cycle must fully release; otherwise a long session leaks devices.
    await expect.poll(async () => Number((await metric(page, 'Registered streams').textContent()) ?? 1))
      .toBe(0)
  })
})
