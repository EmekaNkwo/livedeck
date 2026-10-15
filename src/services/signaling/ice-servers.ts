import type { IceServer } from '@shared/protocol'

/**
 * Parse the settings-dialog ICE server list.
 *
 * One URL per entry. TURN credentials may be appended as
 * `turn:host:port|username:password`; the split is on the *first* `|` and
 * the *first* `:` after it, so a password containing a colon survives.
 */
export function parseIceServerUrls(urls: readonly string[]): IceServer[] {
  const servers: IceServer[] = []
  for (const raw of urls) {
    const entry = raw.trim()
    if (!entry || !/^(stun|stuns|turn|turns):/i.test(entry)) continue
    const pipe = entry.indexOf('|')
    if (pipe === -1) {
      servers.push({ urls: [entry] })
      continue
    }
    const url = entry.slice(0, pipe).trim()
    const credentials = entry.slice(pipe + 1)
    const colon = credentials.indexOf(':')
    if (colon === -1) {
      servers.push({ urls: [url], username: credentials })
      continue
    }
    servers.push({
      urls: [url],
      username: credentials.slice(0, colon),
      credential: credentials.slice(colon + 1),
    })
  }
  return servers
}
