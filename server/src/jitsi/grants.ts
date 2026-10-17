import { createHmac, createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { hasCapability } from '../../../shared/authorization'
import type { MediaGrant, Role } from '../../../shared/protocol'

/**
 * Media grants: signed permission to join a room's Jitsi conference.
 *
 * Audio and video travel through Jitsi. Joining a conference needs a JWT, and
 * only this server signs them, after the participant has passed the room's
 * role rules. The token names the participant (their LiveDeck id and label),
 * is valid for one conference, expires within the hour, and makes only the
 * director a Jitsi moderator. Other participants see the id through Jitsi's
 * presence identity, which is how the studio matches media to the roster
 * without trusting anything a browser says about itself.
 *
 * Two backends:
 *
 *   JaaS (8x8)    JAAS_APP_ID, JAAS_API_KEY_ID, JAAS_PRIVATE_KEY (RS256)
 *   self-hosted   JITSI_PUBLIC_URL, JITSI_DOMAIN, JITSI_APP_ID,
 *                 JITSI_APP_SECRET (HS256), as docker-jitsi-meet's JWT auth
 */

export type GrantConfig =
  | {
      kind: 'jaas'
      appId: string
      apiKeyId: string
      privateKey: KeyObject
      staging: boolean
      ttlSeconds: number
    }
  | {
      kind: 'jitsi'
      publicUrl: string
      domain: string
      mucDomain: string
      appId: string
      secret: string
      audience: string
      ttlSeconds: number
    }

export type GrantSubject = { participantId: string; label: string; role: Role; room: string }

export type GrantIssuer = {
  readonly provider: MediaGrant['provider']
  issue: (subject: GrantSubject) => MediaGrant
}

const DEFAULT_TTL_SECONDS = 3600
const MIN_TTL_SECONDS = 600
const MAX_TTL_SECONDS = 3600

export class GrantConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantConfigError'
  }
}

/** The Jitsi conference for a LiveDeck room. Room names are already [a-z0-9-]. */
export function conferenceName(room: string): string {
  return `livedeck-${room}`
}

function readTtl(value: string | undefined): number {
  const parsed = Number(value)
  if (!value || !Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(parsed)))
}

/** Host env often stores a PEM on one line with literal "\n". */
function readPem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value
}

/**
 * Read the media backend from the environment. Null when none is configured;
 * throws when one is half-configured, so a typo fails at startup rather than
 * at the first join.
 */
export function readGrantConfig(env: Record<string, string | undefined>): GrantConfig | null {
  const ttlSeconds = readTtl(env.MEDIA_GRANT_TTL_SECONDS)
  const jaas = [env.JAAS_APP_ID, env.JAAS_API_KEY_ID, env.JAAS_PRIVATE_KEY]
  if (jaas.some(Boolean)) {
    const [appId, apiKeyId, pem] = jaas
    if (!appId || !apiKeyId || !pem) {
      throw new GrantConfigError('JaaS needs all of JAAS_APP_ID, JAAS_API_KEY_ID and JAAS_PRIVATE_KEY.')
    }
    if (!appId.startsWith('vpaas-magic-cookie-')) {
      throw new GrantConfigError('JAAS_APP_ID should start with "vpaas-magic-cookie-".')
    }
    if (!apiKeyId.startsWith(`${appId}/`)) {
      throw new GrantConfigError('JAAS_API_KEY_ID should be "<app id>/<key id>", as the JaaS console shows it.')
    }
    let privateKey: KeyObject
    try {
      privateKey = createPrivateKey(readPem(pem))
    } catch {
      throw new GrantConfigError('JAAS_PRIVATE_KEY is not a readable PEM private key.')
    }
    if (privateKey.asymmetricKeyType !== 'rsa') {
      throw new GrantConfigError('JAAS_PRIVATE_KEY must be the RSA key JaaS generated.')
    }
    return { kind: 'jaas', appId, apiKeyId, privateKey, staging: env.JAAS_USE_STAGING === 'true', ttlSeconds }
  }

  const self = [env.JITSI_PUBLIC_URL, env.JITSI_DOMAIN, env.JITSI_APP_ID, env.JITSI_APP_SECRET]
  if (self.some(Boolean)) {
    const [publicUrl, domain, appId, secret] = self
    if (!publicUrl || !domain || !appId || !secret) {
      throw new GrantConfigError('Self-hosted Jitsi needs JITSI_PUBLIC_URL, JITSI_DOMAIN, JITSI_APP_ID and JITSI_APP_SECRET.')
    }
    let url: URL
    try {
      url = new URL(publicUrl)
    } catch {
      throw new GrantConfigError('JITSI_PUBLIC_URL is not a URL.')
    }
    if (url.protocol !== 'https:') throw new GrantConfigError('JITSI_PUBLIC_URL must be https.')
    if (secret.length < 16) throw new GrantConfigError('JITSI_APP_SECRET must be at least 16 characters.')
    return {
      kind: 'jitsi',
      publicUrl: url.origin,
      domain,
      mucDomain: env.JITSI_MUC_DOMAIN || `muc.${domain}`,
      appId,
      secret,
      audience: env.JITSI_AUDIENCE || 'jitsi',
      ttlSeconds,
    }
  }
  return null
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

function encode(header: object, payload: object): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
}

export function createGrantIssuer(config: GrantConfig, now: () => number = Date.now): GrantIssuer {
  return {
    provider: config.kind,
    issue: (subject) => {
      const issuedAt = Math.floor(now() / 1000)
      const expiresAt = issuedAt + config.ttlSeconds
      const room = conferenceName(subject.room)
      const moderator = hasCapability(subject.role, 'kick')
      const user = { id: subject.participantId, name: subject.label }

      if (config.kind === 'jaas') {
        const domain = config.staging ? 'staging.8x8.vc' : '8x8.vc'
        const unsigned = encode(
          { alg: 'RS256', typ: 'JWT', kid: config.apiKeyId },
          {
            aud: 'jitsi',
            iss: 'chat',
            sub: config.appId,
            room,
            iat: issuedAt,
            nbf: issuedAt - 10,
            exp: expiresAt,
            context: {
              user: { ...user, avatar: '', email: '', moderator: moderator ? 'true' : 'false' },
              // The studio records and streams itself; nobody gets JaaS's.
              features: {
                livestreaming: 'false',
                recording: 'false',
                transcription: 'false',
                'outbound-call': 'false',
                'sip-outbound-call': 'false',
              },
            },
          },
        )
        const signature = createSign('RSA-SHA256').update(unsigned).sign(config.privateKey)
        return {
          provider: 'jaas',
          domain,
          appId: config.appId,
          room,
          jwt: `${unsigned}.${base64url(signature)}`,
          expiresAt: expiresAt * 1000,
          libraryUrl: `https://${domain}/libs/lib-jitsi-meet.min.js`,
        }
      }

      const unsigned = encode(
        { alg: 'HS256', typ: 'JWT' },
        {
          aud: config.audience,
          iss: config.appId,
          sub: config.domain,
          room,
          iat: issuedAt,
          nbf: issuedAt - 10,
          exp: expiresAt,
          moderator,
          context: { user: { ...user, moderator: moderator ? 'true' : 'false' } },
        },
      )
      const signature = createHmac('sha256', config.secret).update(unsigned).digest()
      const wsBase = config.publicUrl.replace(/^https:/, 'wss:')
      return {
        provider: 'jitsi',
        domain: config.domain,
        appId: '',
        room,
        jwt: `${unsigned}.${base64url(signature)}`,
        expiresAt: expiresAt * 1000,
        libraryUrl: `${config.publicUrl}/libs/lib-jitsi-meet.min.js`,
        serviceUrl: `${wsBase}/xmpp-websocket?room=${room}`,
        mucDomain: config.mucDomain,
      }
    },
  }
}
