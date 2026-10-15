import { defineConfig, devices } from '@playwright/test'
import { DEPLOYED_BASE_URL, RELAY_PORT } from './e2e/fixtures'

/**
 * Browser-level tests for the production workflow.
 *
 * WHY CHROMIUM WITH FAKE DEVICES
 * ------------------------------
 * These flows need a *real* browser media stack — getUserMedia, Web Audio,
 * canvas.captureStream, MediaRecorder — which jsdom cannot provide. Chromium's
 * `--use-fake-device-for-media-stream` supplies a synthetic camera and
 * microphone that behave like real devices (they produce actual frames and
 * samples), so the pipeline under test is the production one rather than a mock.
 *
 * `--auto-select-desktop-capture-source` lets getDisplayMedia resolve without
 * a human picking from the native dialog. Note that this is a *test harness*
 * capability, not an application one: the app itself can never choose a
 * capture target, as the UI states.
 */
export default defineConfig({
  testDir: './e2e',
  // Media pipelines are timing-sensitive; recording tests genuinely need time.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Media device emulation is process-global in Chromium, so parallel workers
  // contending for the fake camera produce flaky results.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: DEPLOYED_BASE_URL ?? 'http://localhost:5173',
    // A local trial deployment serves a certificate from Caddy's own CA.
    ignoreHTTPSErrors: DEPLOYED_BASE_URL !== null,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Grant media permissions up front so tests exercise the success paths;
    // the denied paths are covered by unit tests against the error mapping.
    permissions: ['camera', 'microphone'],
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
            '--allow-running-insecure-content',
            // Keep audio flowing when the window is not focused, which happens
            // constantly in headless runs.
            '--autoplay-policy=no-user-gesture-required',
            '--disable-features=IsolateOrigins,site-per-process',
          ],
        },
      },
    },
  ],

  /*
   * Two processes: the studio's dev server and the media server. Neither is
   * started when LIVEDECK_BASE_URL points the suite at a deployment.
   */
  webServer: DEPLOYED_BASE_URL ? [] : [
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm --prefix server run dev',
      // `/healthz` is the media server's own endpoint. Using it rather than
      // `/` means a *different* process holding this port fails this check
      // instead of being mistaken for the server — which otherwise surfaces
      // as a WebSocket that connects and then never upgrades.
      url: `http://localhost:${RELAY_PORT}/healthz`,
      env: { PORT: RELAY_PORT },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
