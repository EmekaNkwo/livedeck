# shared/

Code imported by **both** the browser client and the media server.

- `protocol.ts` — the Zod schemas for every signaling request, response and
  notification, plus the parsers both ends run on inbound frames. One
  definition means the two halves cannot drift: a signaling mismatch surfaces
  as "the connection just doesn't work", with nothing in either log to
  explain it.
- `authorization.ts` — the role capability table. The server is the only
  party that decides; the client reads it to hide controls it may not use.

Everything here must stay **runtime-agnostic** — no DOM APIs, no Node APIs,
no imports from `src/` or `server/`. The only dependency is `zod`, which both
projects install.
