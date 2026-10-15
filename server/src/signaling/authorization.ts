import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Role } from '../../../shared/protocol'

/**
 * Room keys: how a client earns a role.
 *
 * There are no accounts, so authority is a capability token. Each room has
 * two keys derived from a server secret:
 *
 *   director key   full studio control
 *   producer key   control of participants, no program output
 *
 * A director gets both from `getRoomKeys` and puts them in the links it
 * hands out. A client joining with no key is a guest; it may ask to be a
 * viewer instead, never anything more. The role is decided here, once, from
 * the key presented — nothing the client sends later can change it.
 *
 * Keys are HMACs of the room name, so they are stable across restarts when
 * `ROOM_KEY_SECRET` is set and the server keeps no table of them. Without the
 * variable a random secret is generated at boot, which is fine on a laptop
 * and means every director link stops working on restart elsewhere; the
 * server says so on startup.
 */

export type RoomKeys = {
  directorKey: string
  producerKey: string
}

export type KeyService = {
  keysFor: (room: string) => RoomKeys
  /** The role a presented key grants, or null for an unrecognised key. */
  roleForKey: (room: string, key: string | undefined) => Role | null
}

export function createKeyService(secret: string): KeyService {
  const derive = (room: string, purpose: string): string =>
    createHmac('sha256', secret).update(`${room}:${purpose}`).digest('base64url').slice(0, 32)

  const matches = (expected: string, presented: string): boolean => {
    const a = Buffer.from(expected)
    const b = Buffer.from(presented)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  return {
    keysFor: (room) => ({
      directorKey: derive(room, 'director'),
      producerKey: derive(room, 'producer'),
    }),
    roleForKey: (room, key) => {
      if (!key) return null
      const keys = { directorKey: derive(room, 'director'), producerKey: derive(room, 'producer') }
      if (matches(keys.directorKey, key)) return 'director'
      if (matches(keys.producerKey, key)) return 'producer'
      return null
    },
  }
}

export function readOrGenerateSecret(env: Record<string, string | undefined>): {
  secret: string
  generated: boolean
} {
  const configured = env.ROOM_KEY_SECRET?.trim()
  if (configured && configured.length >= 16) return { secret: configured, generated: false }
  return { secret: randomBytes(32).toString('base64url'), generated: true }
}

export function newResumeToken(): string {
  return randomBytes(24).toString('base64url')
}
