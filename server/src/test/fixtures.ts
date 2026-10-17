import { createGrantIssuer, readGrantConfig, type GrantIssuer } from '../jitsi/grants'

/** Shared test helpers for the server. */

export const quietLog = (): void => {}

export const TEST_JITSI_ENV = {
  JITSI_PUBLIC_URL: 'https://jitsi.test',
  JITSI_DOMAIN: 'meet.jitsi',
  JITSI_APP_ID: 'livedeck',
  JITSI_APP_SECRET: 'test-jitsi-secret-0123456789',
} as const

/** A grant issuer for a self-hosted Jitsi that exists only in tests. */
export function testGrants(): GrantIssuer {
  const config = readGrantConfig(TEST_JITSI_ENV)
  if (!config) throw new Error('test Jitsi config did not parse')
  return createGrantIssuer(config)
}

/** The header and payload of a JWT, without checking its signature. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header, payload] = token.split('.')
  const read = (part: string | undefined) => JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  return { header: read(header), payload: read(payload) }
}
