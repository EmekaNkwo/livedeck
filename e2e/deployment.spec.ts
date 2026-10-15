import { expect, test, type Page } from './test'
import { HEALTH_URL, RELAY_URL } from './fixtures'

/**
 * The media server's guarantees, checked over the wire.
 *
 * These tests use no part of the studio's client code: they open their own
 * WebSocket to `/signal`, from the studio's origin, and speak the protocol
 * directly, as a hostile client would. That is what makes them meaningful
 * against a deployment, where the studio is a production build with no test
 * hooks, and it runs the same way against the local dev servers.
 *
 *   LIVEDECK_BASE_URL=https://studio.example.com npx playwright test e2e/deployment.spec.ts
 */

type WireResult = { ok: boolean; code?: string; result?: Record<string, unknown> }

/**
 * Run a script of protocol steps inside the page, where the socket carries
 * the studio's origin. Returns whatever the script returns.
 */
async function overTheWire<T>(page: Page, script: string): Promise<T> {
  return page.evaluate(
    async ({ relay, body }) => {
      const connect = (label: string) =>
        new Promise<{
          request: (method: string, params: unknown) => Promise<WireResult>
          notifications: Array<{ event: string; data: unknown }>
          closed: Promise<number>
          socket: WebSocket
        }>((resolve, reject) => {
          const socket = new WebSocket(`${relay}/signal`)
          const pending = new Map<number, (value: WireResult) => void>()
          const notifications: Array<{ event: string; data: unknown }> = []
          let nextId = 1
          const closed = new Promise<number>((done) => socket.addEventListener('close', (event) => done(event.code)))
          socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data)) as {
              kind: string
              id?: number
              ok?: boolean
              result?: Record<string, unknown>
              error?: { code: string }
              event?: string
              data?: unknown
            }
            if (message.kind === 'response' && message.id !== undefined) {
              pending.get(message.id)?.({ ok: Boolean(message.ok), code: message.error?.code, result: message.result })
              pending.delete(message.id)
            } else if (message.kind === 'notification') {
              notifications.push({ event: message.event ?? '', data: message.data })
            }
          })
          socket.addEventListener('error', () => reject(new Error(`${label}: the socket failed`)))
          socket.addEventListener('open', () =>
            resolve({
              socket,
              notifications,
              closed,
              request: (method, params) =>
                new Promise<WireResult>((done) => {
                  const id = nextId++
                  pending.set(id, done)
                  socket.send(JSON.stringify({ v: 2, kind: 'request', id, method, params }))
                }),
            }),
          )
        })
      const run = new Function('connect', `return (async () => { ${body} })()`) as (
        c: typeof connect,
      ) => Promise<unknown>
      return run(connect)
    },
    { relay: RELAY_URL, body: script },
  ) as Promise<T>
}

test.describe('media server, over the wire', () => {
  test.beforeEach(async ({ page }) => {
    // Any studio page gives the socket the studio's origin.
    await page.goto('/')
  })

  test('a guest cannot control another guest, claim a room, or read its keys', async ({ page }) => {
    const room = `wire-auth-${Date.now()}`
    const outcome = await overTheWire<Record<string, unknown>>(
      page,
      `
      const room = ${JSON.stringify(room)}
      const director = await connect('director')
      const alice = await connect('alice')
      const bob = await connect('bob')
      const d = await director.request('join', { room, label: 'Director', claim: true })
      const a = await alice.request('join', { room, label: 'Alice' })
      // Claiming a room that already has people in it must not make a director.
      const b = await bob.request('join', { room, label: 'Bob', claim: true })
      const bobId = b.result.participantId
      const forged = await alice.request('control', { target: bobId, command: { action: 'mute-mic', muted: true } })
      const kick = await alice.request('control', { target: bobId, command: { action: 'kick' } })
      const keys = await alice.request('getRoomKeys', {})
      const allowed = await director.request('control', { target: bobId, command: { action: 'mute-mic', muted: true } })
      await new Promise((r) => setTimeout(r, 300))
      const bobControls = bob.notifications.filter((n) => n.event === 'control').map((n) => n.data.from)
      for (const client of [director, alice, bob]) client.socket.close(1000)
      return {
        directorRole: d.result.role,
        aliceRole: a.result.role,
        bobRole: b.result.role,
        forged: forged.code,
        kick: kick.code,
        keys: keys.code,
        allowed: allowed.ok,
        bobControls,
        directorId: d.result.participantId,
      }
      `,
    )
    expect(outcome).toMatchObject({
      directorRole: 'director',
      aliceRole: 'guest',
      bobRole: 'guest',
      forged: 'forbidden',
      kick: 'forbidden',
      keys: 'forbidden',
      allowed: true,
    })
    // Bob heard from the director only.
    expect(outcome.bobControls).toEqual([outcome.directorId])
  })

  test('closes a connection that sends an oversized frame', async ({ page }) => {
    const code = await overTheWire<number>(
      page,
      `
      const client = await connect('big')
      client.socket.send('x'.repeat(300 * 1024))
      return await client.closed
      `,
    )
    // 1009: message too big.
    expect(code).toBe(1009)
  })

  test('issues short-lived TURN credentials that the relay accepts', async ({ page }) => {
    const health = (await (await page.request.get(HEALTH_URL)).json()) as { turn: string }
    test.skip(health.turn === 'none', 'This server has no TURN relay configured.')

    const outcome = await overTheWire<{ ttlSeconds: number; urls: string[]; relayCandidates: number }>(
      page,
      `
      const client = await connect('turn')
      const joined = await client.request('join', { room: 'wire-turn-' + Date.now(), label: 'Probe', claim: true })
      const turn = joined.result.iceServers.filter((s) => s.urls.some((u) => /^turns?:/.test(u)))
      client.socket.close(1000)
      const expiry = Number(String(turn[0]?.username ?? '').split(':')[0])
      // Gather candidates through the relay only: a relay candidate means
      // the TURN server accepted these credentials and allocated a port.
      const pc = new RTCPeerConnection({ iceServers: turn, iceTransportPolicy: 'relay' })
      pc.createDataChannel('probe')
      let relayCandidates = 0
      const done = new Promise((resolve) => {
        pc.addEventListener('icecandidate', (event) => {
          if (!event.candidate) resolve(undefined)
          else if (event.candidate.type === 'relay') relayCandidates += 1
        })
        setTimeout(resolve, 10000)
      })
      await pc.setLocalDescription(await pc.createOffer())
      await done
      pc.close()
      return { ttlSeconds: expiry - Math.floor(Date.now() / 1000), urls: turn.flatMap((s) => s.urls), relayCandidates }
      `,
    )
    expect(outcome.urls.length).toBeGreaterThan(0)
    expect(outcome.ttlSeconds).toBeGreaterThan(0)
    expect(outcome.ttlSeconds).toBeLessThanOrEqual(3600)
    expect(outcome.relayCandidates).toBeGreaterThan(0)
  })
})
