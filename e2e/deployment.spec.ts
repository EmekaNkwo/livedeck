import { expect, test, type Page } from './test'
import { RELAY_URL } from './fixtures'

/**
 * The media server's guarantees, checked over the wire.
 *
 * These tests use no part of the studio's client code: they open their own
 * WebSocket to `/signal`, from the studio's origin, and speak the protocol
 * directly, as a hostile client would. That is what makes them meaningful
 * against a deployment, where the studio is a production build with no test
 * hooks, and it runs the same way against the local dev servers.
 *
 * Media itself (Jitsi) is exercised by the studio specs; here it is the
 * grant that admits a participant to it.
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
                  socket.send(JSON.stringify({ v: 3, kind: 'request', id, method, params }))
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

  test('grants media access for one room, naming the participant, for at most an hour', async ({ page }) => {
    const room = `wire-grant-${Date.now()}`
    const outcome = await overTheWire<{ id: string; grantRoom: string; payload: Record<string, unknown>; fresh: string }>(
      page,
      `
      const client = await connect('grant')
      const joined = await client.request('join', { room: ${JSON.stringify(room)}, label: 'Probe' })
      const fresh = await client.request('getMediaGrant', {})
      client.socket.close(1000)
      const part = joined.result.media.jwt.split('.')[1]
      const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
      return { id: joined.result.participantId, grantRoom: joined.result.media.room, payload, fresh: fresh.result.room }
      `,
    )
    expect(outcome.grantRoom).toBe(`livedeck-${room}`)
    expect(outcome.fresh).toBe(outcome.grantRoom)
    expect(outcome.payload).toMatchObject({ room: outcome.grantRoom, context: { user: { id: outcome.id, moderator: 'false' } } })
    const lifetime = (outcome.payload.exp as number) - Math.floor(Date.now() / 1000)
    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(3600)
  })
})
