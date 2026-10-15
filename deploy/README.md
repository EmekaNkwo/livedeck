# Deploying LiveDeck on one host

`docker-compose.yml` runs the whole product on any machine that can publish
UDP ports: a VPS (Hetzner, DigitalOcean, Lightsail, Linode), a bare-metal box,
or a cloud VM. It is three containers:

| Service  | What it does                                           | Public ports                     |
| -------- | ------------------------------------------------------ | -------------------------------- |
| `web`    | Caddy: the studio's static files, TLS, `/signal` proxy | 80, 443 (TCP), 443 (UDP, HTTP/3) |
| `server` | Signaling + mediasoup SFU, two workers                 | 40000–40001 (UDP and TCP)        |
| `turn`   | coturn, for participants behind strict NAT/firewalls   | 3478 (UDP/TCP), 49160–49200 UDP  |

The server's own HTTP port is never published; only Caddy reaches it.

## Steps

1. Point a DNS name at the host, and open the ports above in its firewall.
2. Fill in the environment:

   ```bash
   cp deploy/.env.example deploy/.env
   # LIVEDECK_DOMAIN, PUBLIC_IP, and two secrets:
   openssl rand -base64 48   # ROOM_KEY_SECRET
   openssl rand -base64 48   # TURN_STATIC_AUTH_SECRET
   ```

3. Start it from the repository root:

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```

Caddy obtains a certificate on first request. `https://<domain>/healthz` shows
the server's rooms, workers and TURN provider.

## Verifying a deployment

The browser suite runs against a deployment as well as against the dev
servers:

```bash
LIVEDECK_BASE_URL=https://studio.example.com npm run e2e
```

Against a deployment, `e2e/deployment.spec.ts` speaks the signaling protocol
directly, as a hostile client would. It checks that one guest cannot control
another or read room keys, that oversized frames are refused, and that the
TURN credentials the server mints expire within an hour and are accepted by
the relay. The two specs that need development-only hooks skip themselves;
every studio flow runs against the production build.

## A local trial

The same stack runs on a laptop with `LIVEDECK_DOMAIN=localhost`, `PUBLIC_IP=127.0.0.1`
and the studio on spare ports (`HTTP_PORT=8080`, `HTTPS_PORT=8443`,
`PUBLIC_ORIGIN=https://localhost:8443`). Caddy then uses its own local CA, which
the test suite accepts. coturn refuses to relay to private and loopback
addresses by design, so a local trial proves TURN authentication and allocation
but not relayed media.

## Sizing and limits

- Each mediasoup worker is one process on one core. Two workers carry several
  twelve-guest rooms; raise `MEDIASOUP_WORKERS` and the published range
  (`40000-4000N`) together.
- Rooms live in one process's memory. Scaling past one host needs a
  room-to-host mapping in front, which this stack does not include.
- Render, Vercel and other HTTP-only platforms cannot carry this stack's
  media; `render.yaml` remains only for evaluating the signaling half.
