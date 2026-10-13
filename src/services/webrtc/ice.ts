import type { IceServerConfig } from '@/types/peer'

/**
 * ICE configuration and gathering.
 *
 * THE TRADE-OFF THIS FILE ENCODES
 * -------------------------------
 * Manual signaling has no channel for *incremental* (trickle) ICE candidates:
 * the user would have to copy a fresh code every time a candidate appeared.
 * So the studio uses **vanilla ICE** instead — it waits for gathering to
 * complete and exports a single SDP with every candidate already embedded.
 *
 * Costs of that choice, which the UI states plainly:
 *  - Connection setup is slower (a second or two spent gathering).
 *  - A STUN-only configuration discovers server-reflexive candidates but no
 *    relay candidates. Two peers behind symmetric NAT, or behind a firewall
 *    that blocks UDP, will gather candidates, exchange them, fail every
 *    connectivity check, and land in `failed`. That is a genuine network
 *    limitation, not a bug, and reaching it requires a TURN server — which
 *    would mean running infrastructure this project deliberately does not have.
 *
 * The studio reports `failed` honestly in that case rather than showing a
 * connected state it cannot justify.
 */

/** Public STUN servers. No credentials, no relay — see the note above. */
export const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
]

/** Gathering rarely needs longer than this; past it, ship what we have. */
export const ICE_GATHERING_TIMEOUT_MS = 5000

export function buildIceServers(urls: string[]): IceServerConfig[] {
  const cleaned = urls.map((url) => url.trim()).filter(Boolean)
  if (cleaned.length === 0) return [{ urls: [...DEFAULT_STUN_URLS] }]

  const servers: IceServerConfig[] = []
  const stunUrls: string[] = []
  for (const url of cleaned) {
    if (url.startsWith('turn:') || url.startsWith('turns:')) {
      // TURN entries may carry `?user:pass` appended by the settings UI.
      const [base, credentials] = url.split('|')
      if (!base) continue
      const server: IceServerConfig = { urls: [base] }
      if (credentials) {
        const [username, credential] = credentials.split(':')
        if (username) server.username = username
        if (credential) server.credential = credential
      }
      servers.push(server)
    } else {
      stunUrls.push(url)
    }
  }
  if (stunUrls.length > 0) servers.unshift({ urls: stunUrls })
  return servers.length > 0 ? servers : [{ urls: [...DEFAULT_STUN_URLS] }]
}

export function buildPeerConfiguration(iceServerUrls: string[]): RTCConfiguration {
  return {
    iceServers: buildIceServers(iceServerUrls) as RTCIceServer[],
    // 'all' lets host, srflx and (if configured) relay candidates be used.
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  }
}

export type GatheringOutcome = {
  description: RTCSessionDescription
  /** False when the timeout fired before gathering finished. */
  complete: boolean
  candidateCount: number
  elapsedMs: number
  /** True when at least one srflx/relay candidate was found. */
  hasPublicCandidate: boolean
}

/**
 * Wait for ICE gathering to finish, then read back the local description with
 * all candidates embedded.
 *
 * Resolves early on timeout rather than hanging: a configured-but-unreachable
 * TURN server can keep `iceGatheringState` at `gathering` indefinitely, and a
 * partial candidate set is still worth trying.
 */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = ICE_GATHERING_TIMEOUT_MS,
): Promise<GatheringOutcome> {
  const startedAt = performance.now()

  return new Promise<GatheringOutcome>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (complete: boolean) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onStateChange)
      pc.removeEventListener('icecandidate', onCandidate)

      const description = pc.localDescription
      if (!description) {
        reject(new Error('No local session description was produced.'))
        return
      }
      const sdp = description.sdp
      resolve({
        description,
        complete,
        candidateCount: countCandidates(sdp),
        elapsedMs: Math.round(performance.now() - startedAt),
        hasPublicCandidate: hasPublicCandidate(sdp),
      })
    }

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish(true)
    }
    // A null candidate is the end-of-candidates signal; some browsers fire it
    // before the gathering state transitions.
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) finish(true)
    }

    if (pc.iceGatheringState === 'complete') {
      finish(true)
      return
    }

    pc.addEventListener('icegatheringstatechange', onStateChange)
    pc.addEventListener('icecandidate', onCandidate)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

export function countCandidates(sdp: string): number {
  const matches = sdp.match(/^a=candidate:/gm)
  return matches ? matches.length : 0
}

/**
 * True when the SDP contains a server-reflexive or relay candidate.
 *
 * Host-only candidates mean the peers can connect on the same LAN but almost
 * certainly not across the internet — worth warning about before the user
 * sends the code to someone remote.
 */
export function hasPublicCandidate(sdp: string): boolean {
  return /^a=candidate:.* typ (srflx|relay)/m.test(sdp)
}

export function hasRelayCandidate(sdp: string): boolean {
  return /^a=candidate:.* typ relay/m.test(sdp)
}

/** Plain-language assessment of a gathered candidate set. */
export function describeConnectivity(outcome: GatheringOutcome): {
  level: 'good' | 'limited' | 'poor'
  message: string
} {
  if (outcome.candidateCount === 0) {
    return {
      level: 'poor',
      message:
        'No ICE candidates were gathered. The connection will not succeed. Check that the browser is not blocking network access.',
    }
  }
  if (hasRelayCandidate(outcome.description.sdp)) {
    return {
      level: 'good',
      message: `${outcome.candidateCount} candidates including a TURN relay, so the connection should succeed even through restrictive NAT.`,
    }
  }
  if (outcome.hasPublicCandidate) {
    return {
      level: 'limited',
      message: `${outcome.candidateCount} candidates including a public (STUN) address. This works for most home and office networks, but will fail if both sides are behind symmetric NAT or a UDP-blocking firewall — that needs a TURN server.`,
    }
  }
  return {
    level: 'poor',
    message: `Only local network candidates were gathered${
      outcome.complete ? '' : ' (gathering also timed out)'
    }. This connection will only work between devices on the same network.`,
  }
}
