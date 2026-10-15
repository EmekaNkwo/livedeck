# syntax=docker/dockerfile:1.7
#
# The LiveDeck media server: signaling + mediasoup SFU.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, NOT `server/`
# ---------------------------------------------------
# `server/src` imports `../../shared/*`, the protocol compiled into both the
# browser and this process. From the repository root:
#
#   docker build -f server/Dockerfile -t livedeck-server .
#   docker run --rm -p 3001:3001 -p 40000-40003:40000-40003/udp -p 40000-40003:40000-40003/tcp \
#     -e ALLOWED_ORIGINS=http://localhost:5173 \
#     -e MEDIASOUP_ANNOUNCED_ADDRESS=<public ip or hostname> \
#     -e ROOM_KEY_SECRET=<long random string> \
#     livedeck-server
#
# MEDIA PORTS
# -----------
# mediasoup needs a UDP (and TCP fallback) port reachable from the internet,
# one per worker starting at MEDIASOUP_PORT. Publish them and set
# MEDIASOUP_ANNOUNCED_ADDRESS to what clients can reach; the container's own
# interface is never that.

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------- dependencies
# mediasoup downloads a prebuilt worker for the platform during install; when
# none matches it compiles one, which needs python3, make and a C++ toolchain.
# Those are only in this stage.
FROM node:${NODE_VERSION} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

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
FROM node:${NODE_VERSION} AS prod-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    MEDIASOUP_PORT=40000 \
    MEDIASOUP_WORKERS=2

WORKDIR /app/server
COPY --from=prod-deps --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --from=build --chown=node:node /app/server/package.json ./package.json
# `dist/shared/*.js` resolves `zod` from its own directory upwards, which is
# /app; point that at the server's tree.
RUN ln -s /app/server/node_modules /app/node_modules

USER node
EXPOSE 3001
EXPOSE 40000-40003/udp
EXPOSE 40000-40003/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Exec form so the server is PID 1 and receives SIGTERM for a graceful stop.
CMD ["node", "dist/server/src/server.js"]
