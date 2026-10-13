# shared/

Code imported by **both** the browser client and the signaling server.

Only one file lives here, and it is the one place where a copy would really
hurt: `signaling-protocol.ts`. A mismatch between the two ends of a signaling
protocol surfaces as "the connection just doesn't work", with nothing in either
log to explain it. One definition makes that class of bug impossible.

Everything here must stay **dependency-free and runtime-agnostic** — no DOM
APIs, no Node APIs, no imports from `src/` or `server/`. It is compiled by both
projects.
