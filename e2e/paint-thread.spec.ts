import { expect, test, type Page } from '@playwright/test'
import { addBackground, canvasHasContent, openDiagnostics, openDirector, openRole, startCamera } from './fixtures'

/**
 * Where the program is painted.
 *
 * The compositor hands the program canvas to a worker when the browser
 * allows it. These tests prove that it really does in Chromium, that the
 * worker's pixels are what the page shows and what `captureStream()`
 * delivers to the recorder and the scene window, and that the main-thread
 * fallback still paints.
 */

async function paintingOn(page: Page): Promise<string> {
  await openDiagnostics(page)
  const row = page
    .getByRole('region', { name: 'Diagnostics' })
    .locator('div', { has: page.getByText('Painting on', { exact: true }) })
    .last()
  return (await row.locator('dd').textContent()) ?? ''
}

/** Frames as a consumer of the program stream receives them. */
async function capturedFrame(page: Page): Promise<{ width: number; height: number; lit: boolean }> {
  return page.locator('canvas').first().evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement
    const stream = canvas.captureStream(30)
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const probe = document.createElement('canvas')
    probe.width = video.videoWidth
    probe.height = video.videoHeight
    const context = probe.getContext('2d')
    let lit = false
    if (context && probe.width > 0) {
      context.drawImage(video, 0, 0)
      const { data } = context.getImageData(0, 0, probe.width, probe.height)
      for (let index = 0; index < data.length; index += 4) {
        if ((data[index] ?? 0) > 40 || (data[index + 1] ?? 0) > 40 || (data[index + 2] ?? 0) > 40) {
          lit = true
          break
        }
      }
    }
    for (const track of stream.getTracks()) track.stop()
    return { width: video.videoWidth, height: video.videoHeight, lit }
  })
}

test.describe('program painting', () => {
  test('paints in a worker, and the capture carries the worker’s pixels', async ({ page }) => {
    await openDirector(page, `paint-worker-${Date.now()}`)
    await addBackground(page, '#2244aa')
    await startCamera(page)
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)

    expect(await paintingOn(page)).toBe('worker thread')
    const frame = await capturedFrame(page)
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)
    expect(frame.lit).toBe(true)
  })

  test('falls back to painting on the page when asked', async ({ page }) => {
    await openRole(page, 'director', `paint-main-${Date.now()}`, '?paint=main')
    await expect(page.locator('canvas').first()).toBeVisible()
    await addBackground(page, '#2244aa')
    await expect.poll(() => canvasHasContent(page), { timeout: 20_000 }).toBe(true)
    expect(await paintingOn(page)).toBe('main thread')
  })
})
