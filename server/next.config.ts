import type { NextConfig } from 'next'

/**
 * The Next app here exists only to give the relay a landing page and a place
 * for future HTTP endpoints (TURN credential minting, for example). The
 * signaling itself is a WebSocket owned by the custom server in `src/server.ts`.
 */
const config: NextConfig = {
  reactStrictMode: true,
  // No static export: the whole point is a long-lived process.
  output: 'standalone',
}

export default config
