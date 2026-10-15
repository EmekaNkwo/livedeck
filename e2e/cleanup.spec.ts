import { type Page, expect, test } from './test'
import {
  addSourceDialog,
  canvasHasContent,
  onAirTally,
  openDiagnostics,
  openDirector,
  openSources,
  recordingPanel,
  sceneTabs,
  sourceRows,
  startCamera,
  startMicrophone,
} from './fixtures'

/**
 * Scenario C — resource cleanup.
 *
 * Start capture, record, stop, remove a source, leave the room, and verify the
 * resources that room owned were released. Leaks here are invisible in ordinary
 * use but degrade a long production, so they are asserted against the
 * diagnostics readout, which reflects the real StreamRegistry and track states.
 *
 * Diagnostics lives behind a tab in the control room, so every read opens that
 * tab first — hence an async reader rather than a bare locator.
 */

function metricValue(page: Page, label: string) {
  return page
    .getByRole('region', { name: 'Diagnostics' })
    .getByText(new RegExp(`^${label}$`))
    .locator('xpath=following-sibling::dd[1]')
}

async function readMetric(page: Page, label: string): Promise<number> {
  await openDiagnostics(page)
  const value = metricValue(page, label)
  await expect(value).toBeVisible()
  return Number((await value.textContent())?.trim() ?? '0')
}

async function readMetricText(page: Page, label: string): Promise<string> {
  await openDiagnostics(page)
  const value = metricValue(page, label)
  await expect(value).toBeVisible()
  return ((await value.textContent()) ?? '').trim()
}

test.describe('Scenario C: resource cleanup', () => {
  test('releases a source’s stream when the source is deleted', async ({ page }) => {
    await openDirector(page, 'cleanup-delete')
    await startCamera(page)

    expect(await readMetric(page, 'Live tracks')).toBeGreaterThan(0)

    // Delete the camera source; its capture should stop with it.
    await openSources(page)
    await page.getByRole('button', { name: /Delete Camera/i }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: /Delete source/i }).click()

    await expect.poll(() => readMetric(page, 'Registered streams'), { timeout: 20_000 }).toBe(0)
    expect(await readMetric(page, 'Live tracks')).toBe(0)
  })

  test('duplicating then deleting the copy keeps the original capture alive', async ({ page }) => {
    await openDirector(page, 'cleanup-dup')
    await startCamera(page)

    // The clone shares the capture — one stream, two references.
    await openSources(page)
    await page.getByRole('button', { name: /Duplicate Camera/i }).click()
    await expect(sourceRows(page).filter({ hasText: 'Camera copy' })).toHaveCount(1)
    expect(await readMetric(page, 'Registered streams')).toBe(1)

    // Deleting the copy must not black out the original.
    await openSources(page)
    await page.getByRole('button', { name: /Delete Camera copy/i }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Delete source/i }).click()

    expect(await readMetric(page, 'Registered streams')).toBe(1)
    expect(await readMetric(page, 'Live tracks')).toBeGreaterThan(0)
    await expect.poll(() => canvasHasContent(page), { timeout: 15_000 }).toBe(true)
  })

  test('stopping a recording releases its canvas capture', async ({ page }) => {
    await openDirector(page, 'cleanup-record')
    await startCamera(page)
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)

    const recording = await recordingPanel(page)
    await recording.getByRole('button', { name: /Start recording/i }).click()
    await expect(onAirTally(page)).toBeVisible()
    await page.waitForTimeout(2000)

    await recording.getByRole('button', { name: /Stop & save/i }).click()
    await expect(recording.getByText(/Saved to the library/i)).toBeVisible({ timeout: 30_000 })

    // Only the camera's stream remains; the recorder's canvas capture is gone.
    expect(await readMetric(page, 'Registered streams')).toBe(1)
    expect(await readMetricText(page, 'Status')).toBe('complete')
  })

  test('leaving the room releases every device and returns to the landing page', async ({
    page,
  }) => {
    await openDirector(page, 'cleanup-leave')
    await startCamera(page)
    await startMicrophone(page)

    expect(await readMetric(page, 'Registered streams')).toBeGreaterThanOrEqual(2)

    await page.getByRole('button', { name: /Leave this room/i }).click()
    await page.getByRole('dialog').getByRole('button', { name: /End production/i }).click()

    // Back on the landing page, with the room preserved for reopening.
    await expect(page).toHaveURL(/\/$|\/#?$/)
    await expect(page.getByRole('heading', { name: /LiveDeck Studio/ })).toBeVisible()
    await expect(page.getByText('cleanup-leave').first()).toBeVisible()

    // Every track that room owned has been stopped. Verified against the
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
    await openDirector(page, 'cleanup-persist')

    await openSources(page)
    await page.getByRole('button', { name: 'Add a source' }).click()
    await addSourceDialog(page).getByLabel('Content').fill('Persisted caption')
    await addSourceDialog(page).getByRole('button', { name: /Add text source/i }).click()

    await page.getByRole('button', { name: /New scene/i }).click()
    await expect(sceneTabs(page)).toHaveCount(2)

    // Autosave is debounced.
    await page.waitForTimeout(1200)
    await page.reload()

    // Configuration came back.
    await expect(sceneTabs(page)).toHaveCount(2)
    await openSources(page)
    await expect(sourceRows(page).filter({ hasText: 'Persisted caption' })).toHaveCount(1)

    // Capture did not — a stream cannot be serialized, and the UI must not
    // claim a device is running after a reload.
    await expect(
      page.getByRole('region', { name: 'Camera' }).getByText('Idle', { exact: true }),
    ).toBeVisible()
  })

  test('repeated start/stop cycles do not accumulate streams', async ({ page }) => {
    await openDirector(page, 'cleanup-cycles')

    for (let i = 0; i < 3; i += 1) {
      await startCamera(page)
      await openSources(page)
      await page.getByRole('button', { name: /Stop camera/i }).click()
      await expect(
        page.getByRole('region', { name: 'Camera' }).getByText('Idle', { exact: true }),
      ).toBeVisible()
    }

    // Each cycle must fully release; otherwise a long session leaks devices.
    await expect.poll(() => readMetric(page, 'Registered streams'), { timeout: 20_000 }).toBe(0)
  })
})
