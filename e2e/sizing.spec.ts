import { expect, test } from './test'
import { openDirector } from './fixtures'

const geometry = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas')!
    const r = canvas.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      aspect: Number((r.width / r.height).toFixed(4)),
      backing: Number((canvas.width / canvas.height).toFixed(4)),
    }
  })

test('collapsing the side panel grows the program output', async ({ page }) => {
  await openDirector(page, 'sizing')
  await page.waitForTimeout(300)

  const before = await geometry(page)
  await page.getByRole('button', { name: 'Collapse the control panel' }).click()
  await page.waitForTimeout(300)
  const after = await geometry(page)

  console.log('BEFORE', JSON.stringify(before))
  console.log('AFTER ', JSON.stringify(after))
  console.log('GROWTH', `${Math.round((after.h / before.h - 1) * 100)}%`)

  // Aspect must stay exact in both states, or the overlay drifts off the video.
  expect(before.aspect).toBeCloseTo(before.backing, 3)
  expect(after.aspect).toBeCloseTo(after.backing, 3)
  expect(after.h).toBeGreaterThan(before.h)

  // Reopening restores the panel.
  await page.getByRole('button', { name: 'Expand the control panel' }).click()
  await expect(page.getByRole('tablist', { name: 'Control room panels' })).toBeVisible()
})

test('vertical aspect ratios also fit exactly', async ({ page }) => {
  await openDirector(page, 'sizing-vertical')
  await page.getByRole('button', { name: 'Studio settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Studio settings' })
  await dialog.getByLabel('Aspect ratio').selectOption('9:16')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.waitForTimeout(400)

  const vertical = await geometry(page)
  console.log('VERTICAL', JSON.stringify(vertical))
  // Now height-limited; the box must still match the backing aspect exactly.
  expect(vertical.aspect).toBeCloseTo(vertical.backing, 3)
  expect(vertical.h).toBeGreaterThan(vertical.w)
})
