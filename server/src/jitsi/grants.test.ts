import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TEST_JITSI_ENV, decodeJwt } from '../test/fixtures'
import { GrantConfigError, conferenceName, createGrantIssuer, readGrantConfig } from './grants'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const APP = 'vpaas-magic-cookie-0123456789abcdef'
const JAAS_ENV = { JAAS_APP_ID: APP, JAAS_API_KEY_ID: `${APP}/a1b2c3`, JAAS_PRIVATE_KEY: PEM }
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)

const subject = { participantId: 'p-1', label: 'Ada', role: 'guest' as const, room: 'studio' }

describe('readGrantConfig', () => {
  it('is null with no backend configured', () => {
    expect(readGrantConfig({})).toBeNull()
  })

  it('reads JaaS, including a PEM stored on one line with literal \\n', () => {
    const oneLine = PEM.replace(/\n/g, '\\n')
    const config = readGrantConfig({ ...JAAS_ENV, JAAS_PRIVATE_KEY: oneLine })
    expect(config).toMatchObject({ kind: 'jaas', appId: APP, apiKeyId: `${APP}/a1b2c3`, staging: false, ttlSeconds: 3600 })
  })

  it('refuses a half-configured or malformed JaaS setup', () => {
    expect(() => readGrantConfig({ JAAS_APP_ID: APP })).toThrow(GrantConfigError)
    expect(() => readGrantConfig({ ...JAAS_ENV, JAAS_APP_ID: 'my-app' })).toThrow(/vpaas-magic-cookie/)
    expect(() => readGrantConfig({ ...JAAS_ENV, JAAS_API_KEY_ID: 'a1b2c3' })).toThrow(/<app id>\/<key id>/)
    expect(() => readGrantConfig({ ...JAAS_ENV, JAAS_PRIVATE_KEY: 'not a key' })).toThrow(/PEM/)
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => readGrantConfig({ ...JAAS_ENV, JAAS_PRIVATE_KEY: ec })).toThrow(/RSA/)
  })

  it('reads a self-hosted Jitsi and refuses a weak or partial one', () => {
    expect(readGrantConfig(TEST_JITSI_ENV)).toMatchObject({
      kind: 'jitsi',
      publicUrl: 'https://jitsi.test',
      mucDomain: 'muc.meet.jitsi',
      audience: 'jitsi',
    })
    expect(() => readGrantConfig({ JITSI_DOMAIN: 'meet.jitsi' })).toThrow(GrantConfigError)
    expect(() => readGrantConfig({ ...TEST_JITSI_ENV, JITSI_PUBLIC_URL: 'http://jitsi.test' })).toThrow(/https/)
    expect(() => readGrantConfig({ ...TEST_JITSI_ENV, JITSI_PUBLIC_URL: 'nope' })).toThrow(/not a URL/)
    expect(() => readGrantConfig({ ...TEST_JITSI_ENV, JITSI_APP_SECRET: 'short' })).toThrow(/16/)
  })

  it('keeps token lifetimes between ten minutes and an hour', () => {
    expect(readGrantConfig({ ...TEST_JITSI_ENV, MEDIA_GRANT_TTL_SECONDS: '60' })?.ttlSeconds).toBe(600)
    expect(readGrantConfig({ ...TEST_JITSI_ENV, MEDIA_GRANT_TTL_SECONDS: '86400' })?.ttlSeconds).toBe(3600)
    expect(readGrantConfig({ ...TEST_JITSI_ENV, MEDIA_GRANT_TTL_SECONDS: 'soon' })?.ttlSeconds).toBe(3600)
  })
})

describe('JaaS grants', () => {
  const config = readGrantConfig(JAAS_ENV)
  if (!config) throw new Error('JaaS config did not parse')
  const issuer = createGrantIssuer(config, () => NOW)

  it('is an RS256 token JaaS will accept, signed with the key', () => {
    const grant = issuer.issue(subject)
    const [header, payload, signature] = grant.jwt.split('.')
    const valid = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature ?? '', 'base64url'))
    expect(valid).toBe(true)
    const decoded = decodeJwt(grant.jwt)
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: `${APP}/a1b2c3` })
    expect(decoded.payload).toMatchObject({
      aud: 'jitsi',
      iss: 'chat',
      sub: APP,
      room: 'livedeck-studio',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
      context: {
        user: { id: 'p-1', name: 'Ada', moderator: 'false' },
        features: { recording: 'false', livestreaming: 'false' },
      },
    })
    expect(grant).toMatchObject({
      provider: 'jaas',
      domain: '8x8.vc',
      appId: APP,
      room: 'livedeck-studio',
      expiresAt: NOW + 3600_000,
      libraryUrl: 'https://8x8.vc/libs/lib-jitsi-meet.min.js',
    })
    expect(grant.serviceUrl).toBeUndefined()
  })

  it('makes the director a moderator', () => {
    const grant = issuer.issue({ ...subject, role: 'director' })
    expect(decodeJwt(grant.jwt).payload.context).toMatchObject({ user: { moderator: 'true' } })
  })

  it('targets staging when asked', () => {
    const staging = readGrantConfig({ ...JAAS_ENV, JAAS_USE_STAGING: 'true' })
    if (!staging) throw new Error('staging config did not parse')
    expect(createGrantIssuer(staging).issue(subject).domain).toBe('staging.8x8.vc')
  })
})

describe('self-hosted grants', () => {
  it('is an HS256 token docker-jitsi-meet will accept', () => {
    const config = readGrantConfig(TEST_JITSI_ENV)
    if (!config) throw new Error('config did not parse')
    const grant = createGrantIssuer(config, () => NOW).issue(subject)
    const [header, payload, signature] = grant.jwt.split('.')
    const expected = createHmac('sha256', TEST_JITSI_ENV.JITSI_APP_SECRET).update(`${header}.${payload}`).digest('base64url')
    expect(signature).toBe(expected)
    expect(decodeJwt(grant.jwt).payload).toMatchObject({ aud: 'jitsi', iss: 'livedeck', sub: 'meet.jitsi', moderator: false })
    expect(grant.serviceUrl).toBe('wss://jitsi.test/xmpp-websocket?room=livedeck-studio')
  })
})

it('names conferences after the room', () => {
  expect(conferenceName('my-show')).toBe('livedeck-my-show')
})
