import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { NextConfig } from 'next'

/**
 * The Next app here exists only to give the relay a landing page and a place
 * for future HTTP endpoints (TURN credential minting, for example). The
 * signaling itself is a WebSocket owned by the custom server in `src/server.ts`.
 */
const config: NextConfig = {
  reactStrictMode: true,

  /*
   * No `output: 'standalone'`.
   *
   * Standalone exists to produce a self-contained bundle for `next start`, and
   * Next warns outright that the two do not work together — this process is a
   * plain Node server that starts Next programmatically so it can own the HTTP
   * `upgrade` event, which a Next route handler cannot do at all. The custom
   * server needs the ordinary `.next` build plus `node_modules`, and the
   * standalone tree would just be a second unused copy in the image.
   */

  /*
   * Pin the workspace root.
   *
   * There is a `package-lock.json` here *and* one at the repository root (the
   * studio's), so Next infers a root and warns that it may have picked the
   * wrong one. It had: it chose the repository, which made it ignore this
   * package's own lockfile. Saying so explicitly also keeps the Docker build
   * quiet, where only part of the tree is present.
   */
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
}

export default config
