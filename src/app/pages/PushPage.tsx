import { Check, ClipboardCopy, LogIn, LogOut, Mic, MicOff, Monitor, MonitorOff, Radio, RefreshCw, Video, VideoOff, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { streamRegistry } from '@/services/media/stream-registry'
import { readJson, writeJson } from '@/services/persistence/local-store'
import { useCamera } from '@/hooks/useCamera'
import { useMicrophone } from '@/hooks/useMicrophone'
import { useAudioMixer } from '@/hooks/useAudioMixer'
import { useGuestMedia } from '@/hooks/useGuestMedia'
import { useGuestScreenShare } from '@/hooks/useGuestScreenShare'
import { useGuestSession } from '@/hooks/useGuestSession'
import { useInviteLink } from '@/hooks/useInviteLink'
import { useMediaDevices } from '@/hooks/useMediaDevices'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { DeviceButton } from '@/components/shared/DeviceButton'
import { TextField } from '@/components/shared/Field'
import { Notice, StatusDot } from '@/components/shared/Status'
import { CallGrid, type CallTile } from '@/components/guests/CallGrid'
import { SharedScreenView, type SharedScreen } from '@/components/guests/SharedScreenView'
import { VideoTile } from '@/components/guests/VideoTile'
import { useIsSpeaking } from '@/hooks/useIsSpeaking'

/**
 * `/push/:room` — the guest view.
 *
 * Shaped like a meeting: a **lobby** where you set a name and check your
 * camera before anyone sees you, then a **call** with the other guests in a
 * grid, a shared screen above it, and a control bar.
 *
 * What it is *not* is a studio. No mixer, no scenes, no recorder: a push view
 * is a sender, and anything else here is something for a nervous guest to get
 * wrong.
 *
 * THE DIRECTOR IS NOT IN THE ROOM
 * -------------------------------
 * A control room conducts from behind the scenes: it receives every guest and
 * sends nothing back, so it has no tile here. Guests see guests.
 *
 * MEDIA GOES THROUGH THE SERVER
 * -----------------------------
 * Every guest publishes once to the media server and receives everyone else
 * from it. Nobody ever hears themselves back: a participant never consumes
 * its own streams.
 *
 * Director commands arrive through the server, which has checked the sender's
 * role, and are applied to this guest's real tracks — a remote mute genuinely
 * stops their audio.
 */

/** Remembered across visits so a rejoin does not mean retyping. */
const NAME_KEY = 'guest-name'

export function PushPage() {
  const { room: rawRoom } = useParams<{ room: string }>()
  const session = useStudioSession()
  const showToast = useStudioStore((state) => state.showToast)

  const room = normalizeRoomName(rawRoom ?? '')
  const parameters = useUrlParameters()

  const devices = useMediaDevices()
  const camera = useCamera()
  const microphone = useMicrophone()
  const mixer = useAudioMixer()
  const screenShare = useGuestScreenShare()
  const invite = useInviteLink()

  const [ready, setReady] = useState(false)
  /** The name under which this guest joined, or null while still in the lobby. */
  const [joinedAs, setJoinedAs] = useState<string | null>(null)
  const [name, setName] = useState(() => parameters.label ?? readJson<string>(NAME_KEY, '') ?? '')
  const [joining, setJoining] = useState(false)
  const [roomLinkCopied, setRoomLinkCopied] = useState(false)

  const media = useGuestMedia({ room: ready ? room : '', label: joinedAs, key: parameters.key })
  const guestSession = useGuestSession()
  const { snapshot } = media

  const speaking = useIsSpeaking(
    microphone.active && !microphone.muted ? (microphone.source?.id ?? null) : null,
  )

  const displayName = guestSession.assignedLabel ?? joinedAs ?? parameters.label ?? 'Guest'

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room, { mode: 'peer' })
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  const started = useRef(false)
  useEffect(() => {
    if (!ready || started.current) return
    if (!parameters.autoStart) return
    started.current = true
    if (!parameters.noVideo) void camera.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, parameters.autoStart, parameters.noVideo])

  /**
   * Join the room with whatever the guest has actually turned on. Starts
   * nothing: the lobby has toggles for both devices and whatever state they
   * are in is what joins. The AudioContext is initialised here because this
   * click is a user gesture.
   */
  const join = async () => {
    const label = name.trim() || 'Guest'
    setJoining(true)
    try {
      await mixer.initialize()
      writeJson(NAME_KEY, label)
      setJoinedAs(label)
    } finally {
      setJoining(false)
    }
  }

  const copyRoomLink = async () => {
    const url = invite.roleLink('push', room)
    const ok = await invite.copy(url)
    if (ok) {
      setRoomLinkCopied(true)
      window.setTimeout(() => setRoomLinkCopied(false), 2000)
      return
    }
    showToast(`Room link: ${url}`, 'info')
  }

  const leave = () => {
    media.leave()
    setJoinedAs(null)
  }

  useEffect(() => {
    if (parameters.unknown.length === 0) return
    showToast(
      `Unrecognised URL parameter${parameters.unknown.length === 1 ? '' : 's'}: ${parameters.unknown.join(', ')}`,
      'error',
    )
  }, [parameters.unknown, showToast])

  // The server ended the session (kicked, replaced elsewhere): back to the lobby.
  useEffect(() => {
    if (snapshot.status !== 'closed' || !snapshot.closedBecause || !joinedAs) return
    showToast(
      snapshot.closedBecause === 'kicked'
        ? 'The director removed you from the room.'
        : snapshot.closedBecause === 'replaced'
          ? 'You joined this room from another tab, which took over.'
          : 'The server closed the session.',
      'error',
    )
    setJoinedAs(null)
  }, [joinedAs, showToast, snapshot.closedBecause, snapshot.status])

  const joinBlocker = useMemo((): string | null => {
    if (!media.supported) return 'This browser does not support WebRTC, so it cannot join a room.'
    return null
  }, [media.supported])

  if (!rawRoom || !room) return <Navigate to="/" replace />

  const inLobby = !joinedAs
  const connected = snapshot.status === 'joined'
  const failed = snapshot.status === 'failed'
  const mirroredSelf = parameters.mirror || camera.mirrored
  const permissionDenied = camera.status === 'denied' || microphone.status === 'denied'
  const micOff = !microphone.active || microphone.muted

  /* ------------------------------------------------------------------ tiles */
  const cameraStream = camera.source?.streamKey ? streamRegistry.getStream(camera.source.streamKey) : null

  const cameraEmptyLabel =
    camera.status === 'denied'
      ? 'Camera blocked'
      : camera.status === 'unavailable'
        ? 'No camera'
        : guestSession.cameraMutedByDirector
          ? 'Muted by director'
          : 'Camera off'

  const selfTile: CallTile = {
    key: 'self',
    stream: camera.active ? cameraStream : null,
    label: `${displayName} (you)`,
    // Own audio is never played back: that is an acoustic feedback loop.
    muted: true,
    mirrored: mirroredSelf,
    speaking,
    micMuted: micOff,
    ...(screenShare.sharing ? { badge: 'sharing' } : {}),
    emptyLabel: cameraEmptyLabel,
  }

  const guests = media.remotes

  /**
   * The one shared screen, if there is one. Two people presenting at once is
   * a social problem, not a layout problem: the most recent wins.
   */
  const remoteSharer = [...guests].reverse().find((view) => view.screenStream) ?? null
  const sharedScreen: SharedScreen | null = screenShare.sharing
    ? { label: `${displayName} (you)`, stream: null, isSelf: true }
    : remoteSharer
      ? { label: remoteSharer.participant.label, stream: remoteSharer.screenStream, isSelf: false }
      : null

  const tiles: CallTile[] = [
    ...guests.map(
      (view): CallTile => ({
        key: view.participant.id,
        stream: view.hasVideo ? view.stream : null,
        label: view.participant.label,
        muted: false,
        micMuted: view.participant.micMuted || !view.hasAudio,
        emptyLabel: view.participant.cameraMuted ? 'Camera off' : view.stream ? 'Camera off' : 'Connecting…',
        ...(view.participant.sharing ? { badge: 'sharing' } : {}),
      }),
    ),
    selfTile,
  ]

  /* ------------------------------------------------------------- mic / cam */
  const toggleCamera = () => {
    if (camera.active) {
      camera.stop()
      return
    }
    void camera.start()
  }

  const toggleMicrophone = async () => {
    if (microphone.active) {
      microphone.toggleMuted()
      return
    }
    await mixer.initialize()
    const ok = await microphone.start()
    if (ok && parameters.startMuted) microphone.setMuted(true)
  }

  const pickCamera = (deviceId: string) => {
    void (camera.active ? camera.switchDevice(deviceId) : camera.start(deviceId || undefined))
  }

  const pickMicrophone = (deviceId: string) => {
    if (microphone.active) {
      void microphone.switchDevice(deviceId)
      return
    }
    void (async () => {
      await mixer.initialize()
      await microphone.start(deviceId || undefined)
    })()
  }

  const mediaControls = (
    <>
      <DeviceButton
        active={!micOff}
        onToggle={() => void toggleMicrophone()}
        label={micOff ? 'Turn microphone on' : 'Turn microphone off'}
        disabled={parameters.noAudio}
        devices={devices.microphones.map((device) => ({ id: device.deviceId, label: device.label }))}
        selectedId={microphone.deviceId ?? ''}
        onSelect={pickMicrophone}
        menuLabel="Choose a microphone"
      >
        {micOff ? <MicOff aria-hidden="true" className="h-4 w-4" /> : <Mic aria-hidden="true" className="h-4 w-4" />}
      </DeviceButton>

      <DeviceButton
        active={camera.active}
        onToggle={toggleCamera}
        label={camera.active ? 'Turn camera off' : 'Turn camera on'}
        disabled={parameters.noVideo}
        devices={devices.cameras.map((device) => ({ id: device.deviceId, label: device.label }))}
        selectedId={camera.deviceId ?? ''}
        onSelect={pickCamera}
        menuLabel="Choose a camera"
      >
        {camera.active ? <Video aria-hidden="true" className="h-4 w-4" /> : <VideoOff aria-hidden="true" className="h-4 w-4" />}
      </DeviceButton>
    </>
  )

  const statusTone = connected ? 'active' : failed ? 'error' : joinedAs ? 'pending' : 'idle'
  const statusLabel = connected
    ? snapshot.role === 'producer'
      ? 'Connected · producer'
      : 'Connected'
    : failed
      ? 'Connection failed'
      : snapshot.status === 'recovering'
        ? 'Reconnecting'
        : joinedAs
          ? 'Connecting'
          : 'Not joined'

  const copyButton = (
    <Button variant="outline" size="sm" onClick={() => void copyRoomLink()}>
      {roomLinkCopied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />}
      {roomLinkCopied ? 'Copied' : 'Copy room link'}
    </Button>
  )

  return (
    <main className="flex h-full flex-col bg-deck-950">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-deck-700 bg-deck-900 px-3">
        <Radio aria-hidden="true" className="h-4 w-4 text-accent-400" />
        <span className="text-sm font-semibold text-ink-100">
          LiveDeck<span className="text-accent-400"> Guest</span>
        </span>
        <code className="url-box truncate text-ink-400">/{room}</code>
        <div className="ml-auto flex items-center gap-2">
          {guestSession.onAir ? (
            <span className="flex items-center gap-1.5 bg-live-500/15 px-2 py-1 ring-1 ring-live-500/40">
              <span className="h-2 w-2 animate-live-pulse rounded-full bg-live-500" />
              <span className="text-[10px] font-bold tracking-wider text-live-400 uppercase">On air</span>
            </span>
          ) : null}
          <StatusDot tone={statusTone} label={statusLabel} />
        </div>
      </header>

      {inLobby ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4">
          <div className="flex w-full max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="text-base font-semibold text-ink-100">Ready to join?</h1>
              <p className="text-xs leading-relaxed text-ink-400">
                Room <strong className="text-ink-200">{room}</strong>. Check your camera first — nothing is
                sent anywhere until you join. A director does not have to be here: guests in the same room
                see each other.
              </p>
            </div>

            <VideoTile
              stream={camera.active ? cameraStream : null}
              label={displayName}
              muted
              mirrored={mirroredSelf}
              emptyLabel={cameraEmptyLabel}
              className="aspect-video w-full"
            />

            <div className="flex items-center justify-center gap-2">{mediaControls}</div>

            <TextField
              label="Your name"
              value={name}
              placeholder="Ana"
              onChange={setName}
              hint="How you appear in the director's control room."
            />

            <Button
              variant="primary"
              disabled={joining || Boolean(joinBlocker)}
              onClick={() => void join()}
              title={joinBlocker ?? undefined}
            >
              <LogIn aria-hidden="true" className="h-4 w-4" />
              {joining ? 'Joining…' : 'Join room'}
            </Button>

            {joinBlocker ? (
              <p className="text-[11px] leading-relaxed text-ink-400">{joinBlocker}</p>
            ) : (
              <p className="text-[11px] leading-relaxed text-ink-500">
                Joining announces you to the room and sends whatever you have turned on to the media
                server, which forwards it to the director and the other guests.
              </p>
            )}

            {parameters.key ? (
              <Notice>This link carries a room key. If it is valid you join with the producer role.</Notice>
            ) : null}

            {copyButton}

            {permissionDenied ? <PermissionHelp camera={camera} microphone={microphone} /> : null}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {guestSession.cue ? (
            <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-accent-500 bg-accent-500/10 px-3 py-2">
              <p className="flex-1 text-sm leading-snug text-accent-400">{guestSession.cue.text}</p>
              <Button variant="ghost" size="icon-sm" onClick={guestSession.dismissCue} aria-label="Dismiss cue">
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col gap-2 bg-black p-2">
            {guests.length === 0 ? (
              <div className="flex shrink-0 flex-col items-center gap-2 pt-2 text-center">
                <p className="text-sm text-ink-300">
                  {failed ? 'The connection failed.' : connected ? 'You are the only one here.' : 'Joining…'}
                </p>
                <p className="max-w-sm text-[11px] leading-relaxed text-ink-500">
                  Send the room link to whoever should join. A director is not required — guests in the
                  same room see each other.
                </p>
                {copyButton}
              </div>
            ) : null}

            {sharedScreen ? <SharedScreenView screen={sharedScreen} /> : null}
            <CallGrid tiles={tiles} compact={Boolean(sharedScreen)} />
          </div>

          <div className="flex shrink-0 flex-col gap-2 border-t border-deck-700 bg-deck-900 px-3 py-2">
            <div className="flex items-center justify-center gap-2">
              {mediaControls}

              <Button
                variant={screenShare.sharing ? 'live' : 'outline'}
                size="sm"
                aria-pressed={screenShare.sharing}
                disabled={screenShare.busy || screenShare.unsupported}
                title={
                  screenShare.unsupported
                    ? 'This browser cannot share a screen'
                    : 'Share a screen or window alongside your camera'
                }
                onClick={screenShare.toggle}
              >
                {screenShare.sharing ? <MonitorOff aria-hidden="true" className="h-3.5 w-3.5" /> : <Monitor aria-hidden="true" className="h-3.5 w-3.5" />}
                {screenShare.sharing ? 'Stop sharing' : 'Share screen'}
              </Button>

              <Button variant="outline" size="sm" onClick={() => void copyRoomLink()}>
                {roomLinkCopied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />}
                {roomLinkCopied ? 'Copied' : 'Invite'}
              </Button>
              <Button variant="live" size="sm" onClick={leave}>
                <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
                Leave
              </Button>
            </div>

            {permissionDenied ? (
              <div className="mx-auto w-full max-w-xl">
                <PermissionHelp camera={camera} microphone={microphone} />
              </div>
            ) : null}

            {snapshot.error ? (
              <div className="mx-auto w-full max-w-xl">
                <Notice tone="error">{snapshot.error}</Notice>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </main>
  )
}

/** Recovery path for a denied permission, with a retry that really retries. */
function PermissionHelp({
  camera,
  microphone,
}: {
  camera: ReturnType<typeof useCamera>
  microphone: ReturnType<typeof useMicrophone>
}) {
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="error">
        Permission was denied. Allow camera and microphone access for this site in your browser’s
        address-bar controls, then retry.
      </Notice>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          void camera.retry()
          void microphone.retry()
        }}
      >
        <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
        Retry
      </Button>
    </div>
  )
}
