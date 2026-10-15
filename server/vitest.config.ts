import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: this is a server, and `ws` needs real sockets.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Each signaling test binds a port and opens sockets; running files in
    // parallel makes port reuse and teardown ordering flaky.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**/*.ts', '../shared/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/server.ts'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
})
