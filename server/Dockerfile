# syntax=docker/dockerfile:1.7
#
# The LiveDeck signaling relay, for Render (or any container host).
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, NOT `server/`
# ---------------------------------------------------
# `server/src/signaling.ts` imports `../../shared/signaling-protocol` — the
# wire protocol is deliberately compiled into both the browser client and the
# server so the two cannot drift. A build context of `server/` therefore cannot
# see half of its own source. On Render that means:
#
#   Dockerfile Path:                  ./server/Dockerfile
#   Docker Build Context Directory:   .
#
# Locally, from the repository root:
#
#   docker build -f server/Dockerfile -t livedeck-signaling .
#   docker run --rm -p 3001:3001 -e ALLOWED_ORIGINS=http://localhost:5173 livedeck-signaling
#
# WHY A LONG-LIVED CONTAINER AT ALL
# ---------------------------------
# A WebSocket relay holds connections and room state in one process's memory.
# It cannot run on a serverless platform, and a Next route handler cannot reach
# the HTTP `upgrade` event — which is why `src/server.ts` starts Next inside a
# plain Node server that owns that event itself. See README › It will not run on
# Vercel's serverless runtime.

# Pinned to an LTS line. Next 16 needs >= 20.9; 22 is the version this is built
# and tested against.
ARG NODE_VERSION=22-bookworm-slim

# ----------------------------------------------------------------- dependencies
# Separate stage, and only the manifests are copied, so a source-only change
# does not re-resolve the dependency tree.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

# ----------------------------------------------------------------------- build
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/server/node_modules ./server/node_modules
# Both halves of the source. `shared/` is not optional — see the note above.
COPY server ./server
COPY shared ./shared
WORKDIR /app/server
# `next build` for the landing page, then `tsc` for the relay itself. The
# TypeScript step emits dist/server/src/*.js plus dist/shared/*.js, which is
# what keeps the relative import working at runtime.
RUN npm run build

# ---------------------------------------------------------- runtime dependencies
# A second clean install without devDependencies. Pruning the build stage's
# tree in place would leave npm's cache and build scratch in the layer.
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Drop native binaries that cannot load on this base image.
#
# The lockfile lists every platform variant of Next's SWC binding and of
# sharp's libvips as optional dependencies, and npm installs each one whose
# platform *could* match. On `bookworm-slim` that means a glibc build and a
# musl build side by side — 94MB of the latter that can never be loaded, plus
# sharp's musl and wasm fallbacks. Together they were a third of the image.
#
# `swc-linux-x64-gnu` is deliberately kept: `next.config.ts` is TypeScript, and
# Next transpiles it with SWC *at startup*, so this is a runtime dependency and
# not only a build-time one. Pruning it would break the boot.
#
# Tied to the base image. Moving to an Alpine base inverts this list.
RUN rm -rf \
      node_modules/@next/swc-linux-x64-musl \
      node_modules/@img/sharp-libvips-linuxmusl-x64 \
      node_modules/@img/sharp-linuxmusl-x64 \
      node_modules/@img/sharp-wasm32

# --------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # Bind every interface: the container's own loopback is not reachable from
    # the host or from Render's router. Deliberately HOST and not HOSTNAME —
    # see the note in src/server.ts.
    HOST=0.0.0.0 \
    # A default so `docker run` works with no flags. Render injects its own
    # PORT at runtime and that wins; the server reads whatever it is given.
    PORT=3001

WORKDIR /app/server

# `node` is an unprivileged user the base image already provides. Ownership is
# set during COPY rather than with a recursive chown afterwards, which would
# duplicate every file into another layer.
COPY --from=prod-deps --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/.next ./.next
COPY --from=build --chown=node:node /app/server/dist ./dist
# `package.json` is read by Next at runtime; `next.config.ts` is loaded by it on
# startup, so the config file ships too rather than being a build-time input.
COPY --from=build --chown=node:node /app/server/package.json ./package.json
COPY --from=build --chown=node:node /app/server/next.config.ts ./next.config.ts

USER node

# Documentation only — the published port is decided by the host.
EXPOSE 3001

# The relay's own endpoint, registered ahead of Next. It reports room and peer
# counts, so a success here means the *relay* is up rather than merely that
# something is answering the port. `fetch` is global in Node 18+, so this needs
# no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Exec form, so the server is PID 1 and receives SIGTERM directly — it has a
# graceful shutdown that closes sockets and gives up after 5s. Wrapping this in
# a shell would swallow the signal and leave the host to kill it.
CMD ["node", "dist/server/src/server.js", "--prod"]
