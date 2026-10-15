import { useCallback, useState } from 'react'
import type { RoomRole } from '@/types/room'

/**
 * Build and copy room links.
 *
 * Clipboard writes genuinely fail — a non-secure context, a browser that needs
 * user activation, a denied permission — so `copy` reports whether it actually
 * worked and every link is also rendered in a selectable box as a manual
 * fallback. Nothing here claims a copy succeeded when it did not.
 */

export type UseInviteLink = {
  copied: boolean
  copyFailed: boolean
  /** Build a plain role link, with optional query parameters. */
  roleLink: (role: RoomRole, room: string, extra?: Record<string, string>) => string
  /** Build a `/solo/:room/:sourceId` link for one feed. */
  soloLink: (room: string, sourceId: string) => string
  copy: (text: string) => Promise<boolean>
}

export function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

export function useInviteLink(): UseInviteLink {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const roleLink = useCallback(
    (role: RoomRole, room: string, extra?: Record<string, string>): string => {
      const query = new URLSearchParams(extra ?? {}).toString()
      return `${currentOrigin()}/${role}/${encodeURIComponent(room)}${query ? `?${query}` : ''}`
    },
    [],
  )

  const soloLink = useCallback(
    (room: string, sourceId: string): string =>
      `${currentOrigin()}/solo/${encodeURIComponent(room)}/${encodeURIComponent(sourceId)}`,
    [],
  )

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setCopyFailed(false)
      setTimeout(() => setCopied(false), 2000)
      return true
    } catch {
      setCopied(false)
      setCopyFailed(true)
      return false
    }
  }, [])

  return { copied, copyFailed, roleLink, soloLink, copy }
}
