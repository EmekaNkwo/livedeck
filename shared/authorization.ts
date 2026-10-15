import type { ControlActionName, Role } from './protocol.js'

/**
 * The capability table.
 *
 * Shared so the client can hide controls it is not allowed to use, but the
 * client's reading of it is cosmetic: the server consults the same table and
 * is the only party that decides. A client that edits its own copy gains
 * nothing.
 */

export type Capability =
  | 'produce'
  | 'produce-program'
  | 'consume'
  | 'control-self'
  | 'control-others'
  | 'cue-others'
  | 'on-air-others'
  | 'relabel-others'
  | 'kick'
  | 'read-room-keys'

const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  director: new Set<Capability>([
    'produce',
    'produce-program',
    'consume',
    'control-self',
    'control-others',
    'cue-others',
    'on-air-others',
    'relabel-others',
    'kick',
    'read-room-keys',
  ]),
  producer: new Set<Capability>([
    'produce',
    'consume',
    'control-self',
    'control-others',
    'cue-others',
    'relabel-others',
  ]),
  guest: new Set<Capability>(['produce', 'consume', 'control-self']),
  viewer: new Set<Capability>(['consume']),
}

const NO_CAPABILITIES: ReadonlySet<Capability> = new Set()

export function hasCapability(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[role] ?? NO_CAPABILITIES).has(capability)
}

/** Which capability a control action on *another* participant requires. */
const CONTROL_REQUIREMENT: Record<ControlActionName, Capability> = {
  'mute-mic': 'control-others',
  'mute-camera': 'control-others',
  cue: 'cue-others',
  'on-air': 'on-air-others',
  label: 'relabel-others',
  kick: 'kick',
}

/**
 * May `actor` apply `action` to `target`?
 *
 * A participant may always mute itself. Anything aimed at somebody else needs
 * the matching capability, and nobody below director may act on a director.
 */
export function canControl(
  actor: { id: string; role: Role },
  target: { id: string; role: Role },
  action: ControlActionName,
): boolean {
  if (actor.id === target.id) {
    return (
      (action === 'mute-mic' || action === 'mute-camera') &&
      hasCapability(actor.role, 'control-self')
    )
  }
  const requirement = CONTROL_REQUIREMENT[action]
  if (!requirement || !hasCapability(actor.role, requirement)) return false
  if (target.role === 'director' && actor.role !== 'director') return false
  return true
}

/** Which media sources a role may publish. */
export function canProduce(role: Role, source: string): boolean {
  if (source === 'program' || source === 'program-audio') {
    return hasCapability(role, 'produce-program')
  }
  return hasCapability(role, 'produce')
}
