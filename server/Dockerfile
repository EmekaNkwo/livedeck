# syntax=docker/dockerfile:1.7
#
# The LiveDeck server: rooms, roles, director control and Jitsi media grants.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, NOT `server/`
# ---------------------------------------------------
# `server/src` imports `../../shared/*`, the protocol compiled into both the
# browser and this process. From the repository root:
#
#   docker build -f server/Dockerfile -t livedeck-server .
#   docker run --rm -p 3001:3001 \
#     -e ALLOWED_ORIGINS=https://studio.example.com \
#     -e ROOM_KEY_SECRET=<long random string> \
#     -e JAAS_APP_ID=... -e JAAS_API_KEY_ID=... -e JAAS_PRIVATE_KEY="$(cat jaas.pk)" \
#     livedeck-server
#
# Audio and video go through Jitsi, so this image needs only its HTTP port.

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------- dependencies
FROM node:${NODE_VERSION} AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

# ----------------------------------------------------------------------- build
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY shared ./shared
# `shared/` imports zod and resolves it from its own directory upwards, which
# reaches /app — not /app/server, where the dependencies are. Link them, as
# the runtime stage does.
RUN ln -s /app/server/node_modules /app/node_modules
WORKDIR /app/server
RUN npm run build

# ---------------------------------------------------------- runtime dependencies
FROM deps AS prod-deps
RUN npm prune --omit=dev && npm cache clean --force

# --------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

WORKDIR /app/server
COPY --from=prod-deps --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --from=build --chown=node:node /app/server/package.json ./package.json
# `dist/shared/*.js` resolves `zod` from its own directory upwards; this link
# also covers anything resolved from /app.
RUN ln -s /app/server/node_modules /app/node_modules

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Exec form so the server is PID 1 and receives SIGTERM for a graceful stop.
CMD ["node", "dist/server/src/server.js"]
