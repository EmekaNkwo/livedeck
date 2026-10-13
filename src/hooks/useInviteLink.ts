import { useCallback, useState } from 'react'
import type { SignalEnvelope } from '@/types/peer'
import type { RoomRole } from '@/types/room'
import type { InviteLink } from '@/services/signaling/invite-link'
import {
  buildAnswerLink,
  buildInviteLink,
  currentOrigin,
} from '@/services/signaling/invite-link'
import { buildParameterQuery } from '@/services/signaling/url-parameters'
import type { OutputResolutionId } from '@/types/scene'
import { useStudioStore } from '@/stores/studioStore'

/**
 * Generate and copy invite / answer links.
 *
 * Clipboard writes genuinely fail — a non-secure context, a browser that needs
 * user activation, a denied permission — so `copy` reports whether it actually
 * worked and every link is also rendered in a selectable box as a manual
 * fallback. Nothing here claims a copy succeeded when it did not.
 */

export type GuestInviteOptions = {
  label?: string
  startMuted?: boolean
  noVideo?: boolean
  noAudio?: boolean
  quality?: OutputResolutionId | null
}

export type UseInviteLink = {
  link: InviteLink | null
  copied: boolean
  copyFailed: boolean
  building: boolean

  /** Build a `/push/:room` link carrying the host's offer. */
  buildGuestInvite: (
    envelope: SignalEnvelope,
    room: string,
    options?: GuestInviteOptions,
  ) => Promise<InviteLink | null>
  /** Build a `/director/:room` link carrying the guest's answer. */
  buildAnswer: (envelope: SignalEnvelope, room: string) => Promise<InviteLink | null>
  /** Build a plain role link with no signaling payload. */
  roleLink: (role: RoomRole, room: string, extra?: Record<string, string>) => string
  /**
   * Build a `/solo/:room/:sourceId` link for one feed.
   *
   * The share-a-single-source workflow: hand someone one guest's camera, or a
   * screen share, without giving them the control room. Separate from
   * `roleLink` because the solo route carries a second path segment rather
   * than a query parameter.
   */
  soloLink: (room: string, sourceId: string) => string
  copy: (text?: string) => Promise<boolean>
  clear: () => void
}

export function useInviteLink(): UseInviteLink {
  const showToast = useStudioStore((state) => state.showToast)
  const [link, setLink] = useState<InviteLink | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [building, setBuilding] = useState(false)

  const buildGuestInvite = useCallback(
    async (
      envelope: SignalEnvelope,
      room: string,
      options?: GuestInviteOptions,
    ): Promise<InviteLink | null> => {
      setBuilding(true)
      setCopied(false)
      setCopyFailed(false)
      try {
        const built = await buildInviteLink({
          envelope,
          room,
          role: 'push',
          origin: currentOrigin(),
          params: buildParameterQuery({
            label: options?.label ?? null,
            startMuted: options?.startMuted ?? false,
            noVideo: options?.noVideo ?? false,
            noAudio: options?.noAudio ?? false,
            quality: options?.quality ?? null,
          }),
        })
        setLink(built)
        return built
      } catch {
        showToast('The invite link could not be generated in this browser.', 'error')
        return null
      } finally {
        setBuilding(false)
      }
    },
    [showToast],
  )

  const buildAnswer = useCallback(
    async (envelope: SignalEnvelope, room: string): Promise<InviteLink | null> => {
      setBuilding(true)
      setCopied(false)
      setCopyFailed(false)
      try {
        const built = await buildAnswerLink({ envelope, room, origin: currentOrigin() })
        setLink(built)
        return built
      } catch {
        showToast('The answer link could not be generated in this browser.', 'error')
        return null
      } finally {
        setBuilding(false)
      }
    },
    [showToast],
  )

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

  const copy = useCallback(
    async (text?: string): Promise<boolean> => {
      const value = text ?? link?.url
      if (!value) return false
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setCopyFailed(false)
        // Reset so a second copy still gives feedback.
        setTimeout(() => setCopied(false), 2000)
        return true
      } catch {
        setCopied(false)
        setCopyFailed(true)
        return false
      }
    },
    [link],
  )

  const clear = useCallback(() => {
    setLink(null)
    setCopied(false)
    setCopyFailed(false)
  }, [])

  return {
    link,
    copied,
    copyFailed,
    building,
    buildGuestInvite,
    buildAnswer,
    roleLink,
    soloLink,
    copy,
    clear,
  }
}
