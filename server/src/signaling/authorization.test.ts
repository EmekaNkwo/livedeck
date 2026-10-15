import { describe, expect, it } from 'vitest'
import { canControl, canProduce, hasCapability } from '../../../shared/authorization'
import type { ControlActionName, Role } from '../../../shared/protocol'
import { createKeyService, readOrGenerateSecret } from './authorization'

const actor = (id: string, role: Role) => ({ id, role })

describe('room keys', () => {
  const keys = createKeyService('a-secret-that-is-long-enough')

  it('derives stable keys per room', () => {
    expect(keys.keysFor('room-a')).toEqual(keys.keysFor('room-a'))
    expect(keys.keysFor('room-a').directorKey).not.toBe(keys.keysFor('room-b').directorKey)
    expect(keys.keysFor('room-a').directorKey).not.toBe(keys.keysFor('room-a').producerKey)
  })

  it('maps keys to roles and nothing else', () => {
    const { directorKey, producerKey } = keys.keysFor('room-a')
    expect(keys.roleForKey('room-a', directorKey)).toBe('director')
    expect(keys.roleForKey('room-a', producerKey)).toBe('producer')
    expect(keys.roleForKey('room-b', directorKey)).toBeNull()
    expect(keys.roleForKey('room-a', 'forged')).toBeNull()
    expect(keys.roleForKey('room-a', undefined)).toBeNull()
    expect(keys.roleForKey('room-a', '')).toBeNull()
  })

  it('differs across secrets', () => {
    const other = createKeyService('another-secret-that-is-long')
    expect(other.roleForKey('room-a', keys.keysFor('room-a').directorKey)).toBeNull()
  })

  it('generates a secret when none is configured', () => {
    expect(readOrGenerateSecret({})).toMatchObject({ generated: true })
    expect(readOrGenerateSecret({ ROOM_KEY_SECRET: 'short' })).toMatchObject({ generated: true })
    expect(readOrGenerateSecret({ ROOM_KEY_SECRET: 'long-enough-to-count-as-a-secret' })).toEqual({
      secret: 'long-enough-to-count-as-a-secret',
      generated: false,
    })
  })
})

describe('capability table', () => {
  const guestA = actor('a', 'guest')
  const guestB = actor('b', 'guest')
  const guestC = actor('c', 'guest')
  const director = actor('d', 'director')
  const producer = actor('p', 'producer')
  const viewer = actor('v', 'viewer')
  const othersActions: ControlActionName[] = ['mute-mic', 'mute-camera', 'cue', 'on-air', 'label', 'kick']

  it('guest A cannot act on guest B or C in any way', () => {
    for (const action of othersActions) {
      expect(canControl(guestA, guestB, action), action).toBe(false)
      expect(canControl(guestA, guestC, action), action).toBe(false)
    }
  })

  it('a guest may mute only itself', () => {
    expect(canControl(guestA, guestA, 'mute-mic')).toBe(true)
    expect(canControl(guestA, guestA, 'mute-camera')).toBe(true)
    expect(canControl(guestA, guestA, 'on-air')).toBe(false)
    expect(canControl(guestA, guestA, 'label')).toBe(false)
    expect(canControl(guestA, guestA, 'kick')).toBe(false)
  })

  it('a viewer can do nothing to anyone, itself included', () => {
    for (const action of othersActions) {
      expect(canControl(viewer, guestA, action)).toBe(false)
      expect(canControl(viewer, viewer, action)).toBe(false)
    }
    expect(hasCapability('viewer', 'produce')).toBe(false)
    expect(hasCapability('viewer', 'consume')).toBe(true)
  })

  it('a director can do everything to everyone', () => {
    for (const action of othersActions) {
      expect(canControl(director, guestA, action), action).toBe(true)
      expect(canControl(director, producer, action), action).toBe(true)
    }
  })

  it('a producer controls guests but not on-air, kick, or the director', () => {
    expect(canControl(producer, guestA, 'mute-mic')).toBe(true)
    expect(canControl(producer, guestA, 'cue')).toBe(true)
    expect(canControl(producer, guestA, 'label')).toBe(true)
    expect(canControl(producer, guestA, 'on-air')).toBe(false)
    expect(canControl(producer, guestA, 'kick')).toBe(false)
    for (const action of othersActions) {
      expect(canControl(producer, director, action), action).toBe(false)
    }
  })

  it('only the director may publish the program feed', () => {
    expect(canProduce('director', 'program')).toBe(true)
    expect(canProduce('producer', 'program')).toBe(false)
    expect(canProduce('guest', 'program-audio')).toBe(false)
    expect(canProduce('guest', 'camera')).toBe(true)
    expect(canProduce('viewer', 'mic')).toBe(false)
  })
})
