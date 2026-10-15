import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test'
import MCR from 'monocart-coverage-reports'

/**
 * The browser suite's `test`, with optional coverage.
 *
 * With LIVEDECK_E2E_COVERAGE=1, every page a test opens records V8 coverage
 * of the studio's modules: the default page, pages from `context.newPage()`,
 * and pages in contexts made with `browser.newContext()` (guests). Coverage
 * starts before the page navigates and is collected before it closes, so
 * module start-up and teardown both count. Each test's data goes into
 * monocart's cache under `coverage-e2e/`, which stores each module's source
 * once; `scripts/coverage-all.mjs` turns it into a report and merges it with
 * unit coverage.
 *
 * Without the variable this is Playwright's own `test`, unchanged.
 */

export { expect } from '@playwright/test'
export type { Browser, BrowserContext, Page } from '@playwright/test'

const ENABLED = process.env.LIVEDECK_E2E_COVERAGE === '1'
/** Shared with scripts/coverage-all.mjs. */
export const E2E_COVERAGE_DIR = 'coverage-e2e'

type Entry = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number]

/** Only the app's own modules, as the dev server serves them. */
function isAppModule(entry: Entry): boolean {
  return /\/src\/.+\.(ts|tsx)(\?|$)/.test(entry.url) && !entry.url.includes('/node_modules/')
}

class CoverageRecorder {
  private readonly tracked = new Set<Page>()
  readonly entries: Entry[] = []

  async start(page: Page): Promise<void> {
    if (this.tracked.has(page)) return
    this.tracked.add(page)
    await page.coverage.startJSCoverage({ resetOnNavigation: false })
    const close = page.close.bind(page)
    page.close = async (options) => {
      await this.stop(page)
      return close(options)
    }
  }

  async stop(page: Page): Promise<void> {
    if (!this.tracked.delete(page) || page.isClosed()) return
    try {
      this.entries.push(...(await page.coverage.stopJSCoverage()).filter(isAppModule))
    } catch {
      // The page crashed or its browser went away; its coverage is lost,
      // which only lowers the measurement.
    }
  }

  watch(context: BrowserContext): void {
    const newPage = context.newPage.bind(context)
    context.newPage = async () => {
      const page = await newPage()
      await this.start(page)
      return page
    }
    // Popups and window.open: started as soon as they appear.
    context.on('page', (page) => void this.start(page))
    const close = context.close.bind(context)
    context.close = async (options) => {
      for (const page of context.pages()) await this.stop(page)
      return close(options)
    }
  }

  async stopAll(): Promise<void> {
    for (const page of [...this.tracked]) await this.stop(page)
  }
}

export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [
    // Named `run`, not `use`: the hooks lint rule would read `use` as React's.
    async ({ browser, context, page }, run, testInfo) => {
      if (!ENABLED) {
        await run()
        return
      }
      const recorder = new CoverageRecorder()
      recorder.watch(context)
      await recorder.start(page)
      const patched = browser as Browser & { newContext: Browser['newContext'] }
      const newContext = browser.newContext.bind(browser)
      patched.newContext = async (options) => {
        const created = await newContext(options)
        recorder.watch(created)
        return created
      }
      try {
        await run()
      } finally {
        patched.newContext = newContext
        await recorder.stopAll()
        if (recorder.entries.length > 0) {
          await MCR({ name: `e2e ${testInfo.title}`, outputDir: E2E_COVERAGE_DIR, logging: 'error' }).add(recorder.entries)
        }
      }
    },
    { auto: true },
  ],
})
