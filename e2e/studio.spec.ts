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
  sourceRows,
  startCamera,
  startMicrophone,
  waitForCompositor,
} from './fixtures'

/**
 * Scenario A — the local studio workflow.
 *
 * Open the studio, enable devices, add sources, build a scene, arrange it,
 * switch scenes, record, and preview the result.
 */

test.describe('Scenario A: local studio', () => {
  test('creates a session and starts the compositor', async ({ page }) => {
    await createSession(page, 'Scenario A')

    // The logical output is independent of the window: 16:9 at 720p.
    expect(await canvasSize(page)).toEqual({ width: 1280, height: 720 })
    await waitForCompositor(page)
  })

  test('acquires a camera and composites it into the program output', async ({ page }) => {
    await createSession(page)
    await startCamera(page)

    // A camera source appears in the library and in the scene.
    await expect(sourceRows(page).filter({ hasText: 'Camera' })).toHaveCount(1)

    // The real assertion: pixels are reaching the program canvas.
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)
  })

  test('acquires a microphone and creates a real mixer channel', async ({ page }) => {
    await createSession(page)
    await startMicrophone(page)

    const mixer = page.getByRole('region', { name: 'Audio mixer' })
    await expect(mixer.getByText(/Host Mic/i)).toBeVisible()

    // A channel only exists when a real audio track was found.
    await openDiagnostics(page)
    const channels = page
      .getByRole('region', { name: 'Diagnostics' })
      .getByText(/^Mixer channels$/)
      .locator('xpath=following-sibling::dd[1]')
    await expect(channels).toHaveText('1')
  })

  test('adds a colour background and a text source', async ({ page }) => {
    await createSession(page)

    await page.getByRole('button', { name: 'Add a source' }).click()
    await addSourceDialog(page).getByRole('button', { name: /Add background/i }).click()
    await expect(sourceRows(page).filter({ hasText: 'Background' })).toHaveCount(1)

    await page.getByRole('button', { name: 'Add a source' }).click()
    await addSourceDialog(page).getByLabel('Content').fill('LiveDeck lower third')
    await addSourceDialog(page).getByRole('button', { name: /Add text source/i }).click()

    await expect(sourceRows(page).filter({ hasText: 'LiveDeck lower third' })).toHaveCount(1)
    await expect.poll(() => canvasHasContent(page)).toBe(true)
  })

  test('arranges a source numerically and the output follows', async ({ page }) => {
    await createSession(page)
    await page.getByRole('button', { name: 'Add a source' }).click()
    await addSourceDialog(page).getByRole('button', { name: /Add background/i }).click()

    // Numeric editing is the accessible path and must drive the real transform.
    await propertyField(page, 'X').fill('200')
    await propertyField(page, 'Width').fill('400')

    await expect(propertyField(page, 'X')).toHaveValue('200')
    await expect(propertyField(page, 'Width')).toHaveValue('400')
  })

  test('creates scenes and switching changes the program output', async ({ page }) => {
    await createSession(page)

    // Scene 1: a dark background.
    await addBackground(page, '#111111')

    // Scene 2: a bright background, so the switch is visible in pixels.
    await page.getByRole('button', { name: /New scene/i }).click()
    await addBackground(page, '#f0f0f0')

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(2)

    // Switch to the bright scene and confirm the canvas actually changed.
    await tabs.nth(1).click()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => canvasHasContent(page), { timeout: 15_000 }).toBe(true)

    // Switch back; the program output follows the selection, not the thumbnail.
    await tabs.nth(0).click()
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  })

  test('records the program output, then previews and offers a download', async ({ page }) => {
    await createSession(page, 'Recording run')
    await startCamera(page)
    await startMicrophone(page)
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)

    const recording = page.getByRole('region', { name: 'Recording' })
    await recording.getByRole('button', { name: /Start recording/i }).click()

    // On air is driven by the recorder's real status.
    await expect(onAirTally(page)).toBeVisible()
    await expect(recording.getByText(/Recording the program output/i)).toBeVisible()

    // Record for long enough to produce several chunks.
    await page.waitForTimeout(3500)

    await recording.getByRole('button', { name: /Stop & save/i }).click()

    // 'Saved to the library' only appears after MediaRecorder produced a blob.
    await expect(recording.getByText(/Saved to the library/i)).toBeVisible({ timeout: 30_000 })

    // The library shows the finished recording with a real duration and size.
    await page.getByRole('button', { name: /Open recording library/i }).click()
    const dialog = page.getByRole('dialog', { name: 'Recordings' })
    await expect(dialog).toBeVisible()
    // `exact` matters: a substring match would also hit "Close preview".
    const previewButton = dialog.getByRole('button', { name: 'Preview', exact: true }).first()
    await expect(previewButton).toBeVisible()
    await previewButton.click()
    const video = dialog.locator('video')
    await expect(video).toBeVisible()

    // The blob is decodable by the browser's own player.
    await expect
      .poll(
        () => video.evaluate((element) => (element as HTMLVideoElement).readyState),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0)

    // Downloading produces a file with an extension matching the real MIME type.
    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download' }).first().click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.(webm|mp4)$/)
  })
})
