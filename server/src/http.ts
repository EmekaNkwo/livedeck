import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The few HTTP responses the server gives.
 *
 * A landing page so opening the address in a browser explains what it is,
 * and a health endpoint for the container host. Everything else is 404. There
 * is deliberately no credential endpoint: TURN credentials travel inside the
 * authenticated join response.
 */

const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiveDeck media server</title>
<style>
  body { margin: 0; background: #0a0c10; color: #dfe4ec; font-family: ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 3rem 1.25rem; line-height: 1.6; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  p, li { font-size: 0.875rem; color: #b4bccb; }
  code { color: #5aa9ff; }
  .warn { color: #ffcc55; }
</style>
</head>
<body>
<main>
  <h1>LiveDeck media server</h1>
  <p>Running. This process routes audio and video between the participants of a studio room.</p>
  <ul>
    <li>Signaling: <code>/signal</code> (WebSocket)</li>
    <li>Health: <code>/healthz</code></li>
  </ul>
  <p>Audio and video travel through Jitsi; this server admits each participant to their room's conference and never sees the media. Rooms live in memory.</p>
  <p class="warn">A room name is not a credential. Director and producer roles are granted by room keys the server issues.</p>
</main>
</body>
</html>`

export type HealthProvider = () => Record<string, unknown>

export function createHttpHandler(health: HealthProvider) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = (request.url ?? '/').split('?')[0]
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    if (url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, ...health() }))
      return
    }
    if (url === '/' || url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(LANDING_PAGE)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
  }
}
