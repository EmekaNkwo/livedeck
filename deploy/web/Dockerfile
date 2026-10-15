# syntax=docker/dockerfile:1.7
#
# The studio (static files) behind Caddy, which also terminates TLS and
# proxies the media server's signaling socket. Built from the repository
# root by deploy/docker-compose.yml.

ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.e2e.json ./
COPY public ./public
COPY shared ./shared
COPY src ./src
# Typecheck the app, then build. Signaling defaults to this page's origin.
RUN npx tsc -p tsconfig.app.json --noEmit && npx vite build

FROM caddy:2.8.4-alpine AS runtime
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80 443 443/udp
