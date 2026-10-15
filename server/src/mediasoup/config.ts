import os from 'node:os'
import type { types } from 'mediasoup'

/**
 * mediasoup configuration, read from the environment once at startup.
 *
 * WHAT NEEDS TO BE REACHABLE
 * --------------------------
 * The SFU terminates every participant's media, so the media port has to be
 * reachable from the public internet — UDP first, TCP as a fallback for
 * networks that block UDP. One port is enough: a `WebRtcServer` multiplexes
 * every transport over it, which is what makes this deployable behind a
 * single published port on a container host.
 *
 * `MEDIASOUP_ANNOUNCED_ADDRESS` must be the address clients can reach. Inside
 * a container that is the host's public IP or DNS name, never the container's
 * own interface.
 */

export type MediasoupConfig = {
  numWorkers: number
  logLevel: types.WorkerLogLevel
  /** Interface to bind inside the process. */
  listenIp: string
  /** Address advertised to clients in ICE candidates. */
  announcedAddress: string | undefined
  /** First media port; each worker takes `port + index`. */
  port: number
  enableUdp: boolean
  enableTcp: boolean
  initialAvailableOutgoingBitrate: number
  maxIncomingBitrate: number
  mediaCodecs: types.RouterRtpCodecCapability[]
}

/**
 * Codecs the router will negotiate.
 *
 * Opus for audio. VP8 first for video: every browser decodes it in hardware or
 * near enough, simulcast with it is universally supported, and a studio with
 * twelve decodes per participant cannot afford a codec some machine handles
 * in software. H.264 is offered as a second choice for Safari on older
 * hardware; VP9 is deliberately left out until SVC is wired through.
 */
export const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: { useinbandfec: 1, usedtx: 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
]

const LOG_LEVELS: types.WorkerLogLevel[] = ['debug', 'warn', 'error', 'none']

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/**
 * The address to advertise when none is configured.
 *
 * A wildcard bind announces nothing usable: an ICE candidate of 0.0.0.0 is
 * one no browser can connect to, which presents as transports that never
 * leave "connecting". On a laptop the machine's LAN address is the right
 * answer (localhost also works through it); anything deployed must set
 * MEDIASOUP_ANNOUNCED_ADDRESS to its public address.
 */
export function defaultAnnouncedAddress(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

export function readMediasoupConfig(env: Record<string, string | undefined>): MediasoupConfig {
  const cpuCount = os.cpus().length || 1
  const logLevel = LOG_LEVELS.find((level) => level === env.MEDIASOUP_LOG_LEVEL) ?? 'warn'
  const listenIp = env.MEDIASOUP_LISTEN_IP?.trim() || '0.0.0.0'
  const configuredAnnounce = env.MEDIASOUP_ANNOUNCED_ADDRESS?.trim() || undefined
  return {
    numWorkers: readInt(env.MEDIASOUP_WORKERS, Math.min(cpuCount, 4), 1, 32),
    logLevel,
    listenIp,
    announcedAddress:
      configuredAnnounce ?? (listenIp === '0.0.0.0' || listenIp === '::' ? defaultAnnouncedAddress() : undefined),
    port: readInt(env.MEDIASOUP_PORT, 40000, 1024, 65535),
    enableUdp: env.MEDIASOUP_ENABLE_UDP !== 'false',
    enableTcp: env.MEDIASOUP_ENABLE_TCP !== 'false',
    initialAvailableOutgoingBitrate: readInt(
      env.MEDIASOUP_INITIAL_OUTGOING_BITRATE,
      1_000_000,
      100_000,
      50_000_000,
    ),
    maxIncomingBitrate: readInt(env.MEDIASOUP_MAX_INCOMING_BITRATE, 4_000_000, 100_000, 50_000_000),
    mediaCodecs: MEDIA_CODECS,
  }
}
