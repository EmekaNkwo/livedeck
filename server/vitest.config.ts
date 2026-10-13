import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: this is a server, and `ws` needs real sockets.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Each signaling test binds a port and opens sockets; running files in
    // parallel makes port reuse and teardown ordering flaky.
    fileParallelism: false,
  },
})
