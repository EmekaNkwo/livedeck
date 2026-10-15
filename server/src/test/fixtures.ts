import { readMediasoupConfig, type MediasoupConfig } from '../mediasoup/config'
import { createWorkerPool, type WorkerPool } from '../mediasoup/worker-pool'

/**
 * Test helpers for the real mediasoup stack.
 *
 * Tests run against actual workers: a mocked SFU would prove nothing about
 * the transport, producer and consumer lifecycle this server exists to get
 * right. One worker per test file, on a port chosen to avoid collisions
 * between files that vitest may still overlap in setup.
 */

/*
 * Below 49152: Windows hands out 49152+ as ephemeral ports for outgoing
 * connections, so a test port picked there can already be taken.
 */
const PORT_FLOOR = 41_000
const PORT_SPAN = 7_000
let nextPort = PORT_FLOOR + Math.floor(Math.random() * PORT_SPAN)

export function testMediasoupConfig(): MediasoupConfig {
  nextPort = PORT_FLOOR + ((nextPort - PORT_FLOOR + 2 + Math.floor(Math.random() * 50)) % PORT_SPAN)
  return {
    ...readMediasoupConfig({}),
    numWorkers: 1,
    logLevel: 'error',
    listenIp: '127.0.0.1',
    announcedAddress: undefined,
    port: nextPort,
  }
}

export const quietLog = (): void => {}

/** A one-worker pool, retrying on another port if the first is taken. */
export async function createTestPool(): Promise<{ pool: WorkerPool; config: MediasoupConfig }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const config = testMediasoupConfig()
    try {
      const pool = await createWorkerPool(config, quietLog)
      return { pool, config }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** Minimal Opus parameters a router built from `MEDIA_CODECS` will accept. */
export function audioRtpParameters(ssrc: number): Record<string, unknown> {
  return {
    mid: String(ssrc),
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: 111,
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1, usedtx: 1 },
        rtcpFeedback: [],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: { cname: `cname-${ssrc}` },
  }
}

export function videoRtpParameters(ssrc: number): Record<string, unknown> {
  return {
    mid: String(ssrc),
    codecs: [
      {
        mimeType: 'video/VP8',
        payloadType: 96,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc }],
    rtcp: { cname: `cname-${ssrc}` },
  }
}

/** A client that can only consume: no Opus, no VP8. */
export const INCOMPATIBLE_RTP_CAPABILITIES = {
  codecs: [{ kind: 'video', mimeType: 'video/AV1', clockRate: 90000, preferredPayloadType: 45, rtcpFeedback: [] }],
  headerExtensions: [],
}

/** Fake DTLS parameters: structurally valid so `connect` reaches mediasoup. */
export const FAKE_DTLS_PARAMETERS = {
  role: 'client',
  fingerprints: [
    {
      algorithm: 'sha-256',
      value:
        '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    },
  ],
}
