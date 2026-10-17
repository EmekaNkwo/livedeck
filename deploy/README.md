# Deploying LiveDeck

LiveDeck has three parts:

| Part | What it is | Where it can run |
| ---- | ---------- | ---------------- |
| Studio | Static files (Vite build) | Any static host: Vercel, Netlify, Caddy |
| Server | Rooms, roles, director control, media grants (`server/`) | Any web service with WebSockets: Render, Fly.io, a VPS |
| Media | Audio and video | JaaS (Jitsi as a Service by 8x8) |

The server holds no media and needs only its HTTP port, so it runs on Render
as it is (`render.yaml`).

## JaaS

1. Create an account at https://jaas.8x8.vc (the Developer plan is free for a
   small number of monthly users).
2. Copy the **AppID** (`vpaas-magic-cookie-…`).
3. Under API Keys, add a key and download its private key. Its id is shown as
   `<AppID>/<key id>`.
4. Set on the server:

   ```bash
   JAAS_APP_ID=vpaas-magic-cookie-…
   JAAS_API_KEY_ID=vpaas-magic-cookie-…/a1b2c3
   JAAS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"
   ```

   Hosts that take single-line values (Render, Vercel) need the PEM's
   newlines written as `\n`; the server converts them back.

The server signs each participant a token for their room's conference only,
valid for an hour, naming them by their LiveDeck id, and making only the
director a moderator. `/healthz` reports `"media": "jaas"` once it is set.

## Render + Vercel

- **Server on Render:** `render.yaml` describes it. Set `ALLOWED_ORIGINS` to
  the studio's origin and the three `JAAS_*` values.
- **Studio on Vercel:** set `VITE_SIGNALING_URL` to the server's
  `wss://…onrender.com` address and build as usual (`vercel.json` is ready).

## One host with Docker

`docker-compose.yml` runs the studio behind Caddy (TLS, `/signal` proxy) and
the server, on any machine with ports 80 and 443:

```bash
cp deploy/.env.example deploy/.env    # domain, ROOM_KEY_SECRET, JAAS_*
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

## Verifying a deployment

```bash
LIVEDECK_BASE_URL=https://studio.example.com npm run e2e
```

`e2e/deployment.spec.ts` speaks the signaling protocol directly, as a hostile
client would: one guest cannot control another or read room keys, oversized
frames are refused, and the media grant is short-lived and scoped to the
participant's room. The studio specs then join real conferences through the
deployment's media backend.

## Local development and tests

The browser suite uses a local Jitsi instead of JaaS:

```bash
npm run jitsi:up      # docker-jitsi-meet with JWT auth, on https://localhost:8443
npm run e2e
```

`deploy/jitsi-local/jitsi-local.sh` explains the one machine-specific detail:
the video bridge must advertise an address the browser can reach over UDP.
