import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Code compiled by both the browser client and the signaling server.
      // One definition of the wire protocol, so the two cannot drift.
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // getUserMedia / getDisplayMedia require a secure context. localhost counts
    // as one, so plain HTTP is fine for local development.
    host: 'localhost',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/components/ui/**',
      ],
      /*
       * Enforced where a regression is a production incident: the media
       * transport, the recording path and everything read from storage. UI
       * components are covered by the browser suite instead, so the global
       * floor is lower than the floor on these directories.
       */
      thresholds: {
        // The global floor is the measured level: hooks, pages and panels are
        // exercised by the Playwright suite, not here. It exists to stop a
        // regression, not to claim a target the unit suite does not meet.
        lines: 36,
        functions: 30,
        branches: 27,
        statements: 35,
        'src/media/**': { lines: 80, functions: 80, branches: 70, statements: 80 },
        'src/services/recording/**': { lines: 80, functions: 80, branches: 70, statements: 80 },
        'src/services/persistence/**': { lines: 75, functions: 75, branches: 65, statements: 75 },
        'src/services/signaling/**': { lines: 80, functions: 80, branches: 70, statements: 80 },
      },
    },
  },
})
