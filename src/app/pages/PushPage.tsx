import {
  Check,
  ClipboardCopy,
  LogIn,
  LogOut,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  Video,
  VideoOff,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { normalizeRoomName } from '@/types/room'
import { cn } from '@/lib/cn'
import { clearSignalFragment, readSignalFromFragment } from '@/services/signaling/invite-link'
import { streamRegistry } from '@/services/media/stream-registry'
import { readJson, writeJson } from '@/services/persistence/local-store'
import { useCamera } from '@/hooks/useCamera'
import { useMicrophone } from '@/hooks/useMicrophone'
import { useAudioMixer } from '@/hooks/useAudioMixer'
import { useGuestSession } from '@/hooks/useGuestSession'
import { useInviteLink } from '@/hooks/useInviteLink'
import { useMediaDevices } from '@/hooks/useMediaDevices'
import { useStudioSession } from '@/hooks/useStudioSession'
import { useUrlParameters } from '@/hooks/useUrlParameters'
import { useWebRTC } from '@/hooks/useWebRTC'
import { useGuestStore } from '@/stores/guestStore'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { DeviceButton } from '@/components/shared/DeviceButton'
import { TextField } from '@/components/shared/Field'
import { Notice, StatusDot } from '@/components/shared/Status'
import { LevelMeter } from '@/components/audio/LevelMeter'
import { ParticipantTile } from '@/components/guests/ParticipantTile'
import { useIsSpeaking } from '@/hooks/useIsSpeaking'
import { SpeakingIndicator } from '@/components/audio/SpeakingIndicator'

/**
 * `/push/:room` — the guest view.
 *
 * Shaped like a meeting, because that is what it is from the guest's side:
 * a **lobby** where you set a name and check your camera before anyone sees
 * you, then a **call** — the director's program feed on the main stage, your
 * own camera as a small tile over it, and a control bar.
 *
 * What it is *not* is a studio. No mixer, no scenes, no recorder: a push view
 * is a sender, and anything else here is something for a nervous guest to get
 * wrong.
 *
 * THE STAGE DEPENDS ON WHETHER A DIRECTOR IS IN THE ROOM
 * ------------------------------------------------------
 * With a director, the stage is the **composed program** and the other guests
 * are a strip beneath it. The program is what is going to air, including this
 * guest framed the way the director framed them, so it is the thing to give
 * the space to — a participant grid would be a second, parallel answer to
 * "what is happening", and the wrong one to trust.
 *
 * With no director the room is just a call, so the stage *is* the participant
 * grid. A room full of guests and no control room is a supported
 * configuration: guests connect to each other in a full mesh, so one can be
 * created and used with nobody producing it.
 *
 * TWO WAYS IN, AND THE PAGE KNOWS WHICH IT IS
 * -------------------------------------------
 * With a signaling relay the room link is the whole invitation: set a name,
 * click **Join room**, and the control room sees you. That is deliberately an
 * explicit action rather than something that happens on load — a guest's
 * camera and microphone should not enter someone else's production because
 * they opened a URL.
 *
 * Without a relay the link itself carries the director's offer in its
 * fragment, which is consumed automatically and answered with a link to send
 * back. There is nothing to join in that mode, so no join control is shown.
 *
 * Director commands arrive over the data channel and are applied to this
 * guest's real tracks, so a remote mute genuinely stops their audio.
 *
 * NO METER ONCE YOU ARE IN
 * ------------------------
 * The lobby shows a level meter, because there the question is "is my
 * microphone working at all" and a moving bar is the answer. In the call it is
 * replaced by a speaking indicator on the person's own tile: mid-production
 * the useful question is "am I being heard right now", and a dB reading is a
 * worse answer to that than a ring around your face.
 */

/** Remembered across visits so a rejoin does not mean retyping. */
const NAME_KEY = 'guest-name'

export function PushPage() {
  const { room: rawRoom } = useParams<{ room: string }>()
  const location = useLocation()
  const session = useStudioSession()
  const showToast = useStudioStore((state) => state.showToast)

  const room = normalizeRoomName(rawRoom ?? '')
  const parameters = useUrlParameters()

  const devices = useMediaDevices()
  const camera = useCamera()
  const microphone = useMicrophone()
  const mixer = useAudioMixer()
  const guestSession = useGuestSession()
  const invite = useInviteLink()

  const [ready, setReady] = useState(false)
  /**
   * The name under which this guest joined, or null while still in the lobby.
   *
   * Doubles as the joined flag, and is deliberately frozen at the moment of
   * joining: the label is announced to the room, and letting it change under a
   * live connection would re-join the room and restart negotiation.
   */
  const [joinedAs, setJoinedAs] = useState<string | null>(null)
  const [name, setName] = useState(() => parameters.label ?? readJson<string>(NAME_KEY, '') ?? '')
  const [joining, setJoining] = useState(false)
  const [answerUrl, setAnswerUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [roomLinkCopied, setRoomLinkCopied] = useState(false)
  const selfViewRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLVideoElement | null>(null)

  const webrtc = useWebRTC({
    send: 'camera',
    onControlMessage: guestSession.handleControlMessage,
    // Only once joined. Passing the room before then would announce this guest
    // to the director the instant the page loaded.
    ...(joinedAs ? { room, role: 'guest' as const, label: joinedAs } : {}),
  })

  const peerStates = useGuestStore((state) => state.peerStates)
  const peer = Object.values(peerStates)[0] ?? null

  /*
   * Whether this guest is audible right now.
   *
   * Sampled from the meter bus rather than subscribed to it — this drives
   * conditional markup, so it needs a render, and the meter's own 20Hz rate
   * would be 20 renders a second for a ring that only has two states.
   */
  const speaking = useIsSpeaking(
    microphone.active && !microphone.muted ? (microphone.source?.id ?? null) : null,
  )

  /** Rooms mean a join control; the manual transport has nothing to join. */
  const roomsSupported = webrtc.signaling.capabilities.supportsRooms
  const transportState = webrtc.signaling.transportState

  const displayName = guestSession.assignedLabel ?? joinedAs ?? parameters.label ?? 'Guest'

  useEffect(() => {
    if (!room) return
    session.ensureRoom(room, { mode: 'peer' })
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  /**
   * Start capture per the link's parameters.
   *
   * `autoStart` is honoured for the camera, but audio still needs an explicit
   * click, because browsers will not start an AudioContext without a gesture —
   * promising otherwise would just produce a silent guest.
   */
  const started = useRef(false)
  useEffect(() => {
    if (!ready || started.current) return
    if (!parameters.autoStart) return
    started.current = true
    if (!parameters.noVideo) void camera.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, parameters.autoStart, parameters.noVideo])

  /**
   * Join the room.
   *
   * Capture is acquired *before* joining, for two reasons: the click is the
   * user gesture that lets an AudioContext start at all, and a guest who joins
   * with no tracks appears in the control room as a connected participant
   * sending nothing, which looks like a broken connection rather than a
   * microphone that was never started.
   */
  const join = async () => {
    const label = name.trim() || 'Guest'
    setJoining(true)
    try {
      if (!parameters.noVideo && !camera.active) await camera.start()
      if (!parameters.noAudio && !microphone.active) {
        await mixer.initialize()
        const ok = await microphone.start()
        if (ok && parameters.startMuted) microphone.setMuted(true)
      }
      writeJson(NAME_KEY, label)
      setJoinedAs(label)
    } finally {
      setJoining(false)
    }
  }

  /**
   * Copy the room link, so a guest can invite the next one.
   *
   * A room does not need a director, so the guest view needs its own way to
   * grow the room — otherwise the only path to a second participant runs
   * through a control room that may never open.
   */
  const copyRoomLink = async () => {
    const url = `${window.location.origin}/push/${encodeURIComponent(room)}`
    const ok = await invite.copy(url)
    if (ok) {
      setRoomLinkCopied(true)
      window.setTimeout(() => setRoomLinkCopied(false), 2000)
      return
    }
    showToast(`Room link: ${url}`, 'info')
  }

  /** Leave: drop the peer connections and return to the lobby. */
  const leave = () => {
    webrtc.closeAll()
    setJoinedAs(null)
    setAnswerUrl(null)
  }

  /** Apply the offer from an invite link, then produce an answer link. */
  const consumedHash = useRef<string | null>(null)
  useEffect(() => {
    if (!ready) return
    const hash = location.hash
    if (!hash || consumedHash.current === hash) return
    consumedHash.current = hash

    void (async () => {
      const result = await readSignalFromFragment(hash)
      if (result.status === 'none') return
      if (result.status === 'invalid') {
        showToast(result.error, 'error')
        clearSignalFragment()
        return
      }
      if (result.signal.kind !== 'offer') {
        showToast('That link carries an answer, not an invite.', 'error')
        clearSignalFragment()
        return
      }

      clearSignalFragment()
      // The answer envelope is returned directly — reading it back off the
      // hook would see this render's stale value.
      const envelope = await webrtc.acceptOfferEnvelope(result.signal.envelope)
      if (envelope) {
        const built = await invite.buildAnswer(envelope, room)
        if (built) setAnswerUrl(built.url)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, ready])

  /**
   * Once an answer has been published, keep the returned link in sync.
   *
   * The envelope arrives asynchronously after ICE gathering, so the effect
   * above can run before it exists. Only the manual transport needs this: with
   * a relay the answer is delivered for us and there is no link to show.
   */
  useEffect(() => {
    if (roomsSupported) return
    const envelope = webrtc.signaling.lastEnvelope
    if (!envelope || envelope.kind !== 'answer' || answerUrl) return
    void invite.buildAnswer(envelope, room).then((built) => {
      if (built) setAnswerUrl(built.url)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtc.signaling.lastEnvelope, answerUrl, room, roomsSupported])

  /** Bind the local camera to the self-view. */
  useEffect(() => {
    const element = selfViewRef.current
    if (!element) return
    const key = camera.source?.streamKey
    const stream = key ? streamRegistry.getStream(key) : null
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) {
      void element.play().catch(() => {
        // Autoplay refused; the guest still sees the controls.
      })
    }
    return () => {
      // A viewer, not an owner — the registry owns the tracks.
      element.srcObject = null
    }
  }, [camera.source?.streamKey, camera.status, joinedAs])

  /** Bind the director's program feed to the main stage. */
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const stream = webrtc.programStream
    if (element.srcObject !== stream) element.srcObject = stream
    if (stream) {
      void element.play().catch(() => {
        // Autoplay with sound can be refused until the guest interacts. They
        // have already clicked Join, so this is unexpected — but a frozen
        // frame beats an exception.
      })
    }
    return () => {
      element.srcObject = null
    }
  }, [webrtc.programStream])

  useEffect(() => {
    if (parameters.unknown.length === 0) return
    showToast(
      `Unrecognised URL parameter${parameters.unknown.length === 1 ? '' : 's'}: ${parameters.unknown.join(', ')}`,
      'error',
    )
  }, [parameters.unknown, showToast])

  /**
   * Why the join button is unavailable, or null when it is available.
   *
   * Spelled out rather than left as a disabled control with no explanation,
   * because every reason here is something someone can act on.
   */
  const joinBlocker = useMemo((): string | null => {
    if (!webrtc.supported) {
      return 'This browser does not support WebRTC, so it cannot send to a director.'
    }
    if (transportState === 'failed') {
      return 'The signaling server cannot be reached, so there is no room to join. Ask the director to check that their relay is running.'
    }
    if (transportState === 'connecting' || transportState === 'reconnecting') {
      return 'Connecting to the signaling server…'
    }
    if (transportState !== 'connected') {
      return 'Not connected to the signaling server yet.'
    }
    return null
  }, [transportState, webrtc.supported])

  if (!rawRoom || !room) return <Navigate to="/" replace />

  const connected = peer?.status === 'connected'
  /*
   * Everyone except the director.
   *
   * The director's feed is the stage when there is one, so including it in the
   * participant list would show the program twice.
   */
  const participantsWithoutDirector = webrtc.participants.filter(
    (participant) => participant.role !== 'director',
  )
  const mirroredSelf = parameters.mirror || camera.mirrored
  const inLobby = roomsSupported && !joinedAs
  const permissionDenied = camera.status === 'denied' || microphone.status === 'denied'

  /* -------------------------------------------------------------- self video */
  const selfVideo = (
    <>
      {camera.active ? (
        <video
          ref={selfViewRef}
          muted
          playsInline
          aria-label="Your camera preview"
          className={cn('h-full w-full object-cover', mirroredSelf && 'scale-x-[-1]')}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink-500">
          <VideoOff aria-hidden="true" className="h-6 w-6" />
          <p className="px-2 text-center text-[11px] leading-tight">
            {camera.status === 'denied'
              ? 'Camera blocked'
              : camera.status === 'unavailable'
                ? 'No camera'
                : 'Camera off'}
          </p>
        </div>
      )}
      {guestSession.cameraMutedByDirector ? (
        <p className="absolute top-1 left-1 bg-live-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase">
          Muted by director
        </p>
      ) : null}
    </>
  )

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
    // A click is exactly when the browser permits an AudioContext to start.
    await mixer.initialize()
    const ok = await microphone.start()
    if (ok && parameters.startMuted) microphone.setMuted(true)
  }

  const micOff = !microphone.active || microphone.muted

  /**
   * Switch camera device, starting it if it is off.
   *
   * `switchDevice` applies constraints to the live track where the browser
   * allows it, which avoids a visible drop-out; picking a device while off is
   * treated as "start on this one" rather than being ignored.
   */
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

  /** The mic and camera controls, shared by the lobby and the call bar. */
  const mediaControls = (
    <>
      <DeviceButton
        active={!micOff}
        onToggle={() => void toggleMicrophone()}
        label={micOff ? 'Turn microphone on' : 'Turn microphone off'}
        disabled={parameters.noAudio}
        devices={devices.microphones.map((device) => ({
          id: device.deviceId,
          label: device.label,
        }))}
        selectedId={microphone.deviceId ?? ''}
        onSelect={pickMicrophone}
        menuLabel="Choose a microphone"
      >
        {micOff ? (
          <MicOff aria-hidden="true" className="h-4 w-4" />
        ) : (
          <Mic aria-hidden="true" className="h-4 w-4" />
        )}
      </DeviceButton>

      <DeviceButton
        active={camera.active}
        onToggle={toggleCamera}
        label={camera.active ? 'Turn camera off' : 'Turn camera on'}
        disabled={parameters.noVideo}
        devices={devices.cameras.map((device) => ({
          id: device.deviceId,
          label: device.label,
        }))}
        selectedId={camera.deviceId ?? ''}
        onSelect={pickCamera}
        menuLabel="Choose a camera"
      >
        {camera.active ? (
          <Video aria-hidden="true" className="h-4 w-4" />
        ) : (
          <VideoOff aria-hidden="true" className="h-4 w-4" />
        )}
      </DeviceButton>
    </>
  )

  return (
    <main className="flex h-full flex-col bg-deck-950">
      {/* ----------------------------------------------------------- header */}
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
              <span className="text-[10px] font-bold tracking-wider text-live-400 uppercase">
                On air
              </span>
            </span>
          ) : null}
          <StatusDot
            tone={
              connected
                ? 'active'
                : peer?.status === 'failed'
                  ? 'error'
                  : peer || joinedAs
                    ? 'pending'
                    : 'idle'
            }
            label={
              connected
                ? 'Connected'
                : peer?.status === 'failed'
                  ? 'Connection failed'
                  : peer
                    ? 'Connecting'
                    : joinedAs
                      ? 'In room'
                      : 'Not joined'
            }
          />
        </div>
      </header>

      {/* ============================================================ LOBBY */}
      {inLobby ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4">
          <div className="flex w-full max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="text-base font-semibold text-ink-100">Ready to join?</h1>
              <p className="text-xs leading-relaxed text-ink-400">
                Room <strong className="text-ink-200">{room}</strong>. Check your camera first —
                nothing is sent anywhere until you join. A director does not have to be here:
                guests in the same room see each other.
              </p>
            </div>

            <div className="relative aspect-video overflow-hidden border border-deck-700 bg-deck-950">
              {selfVideo}
            </div>

            {/*
              Pre-join device controls, the way a meeting lobby works: toggle
              on the left, pick which device on the right.
            */}
            <div className="flex items-center justify-center gap-2">{mediaControls}</div>

            {/*
              A meter, but only here. In the lobby the question is whether the
              microphone works at all, and a moving bar answers it directly.
            */}
            {microphone.active ? (
              <div className="flex items-center gap-2 border border-deck-700 bg-deck-900 px-2.5 py-2">
                <span className="shrink-0 text-[11px] text-ink-400">Your level</span>
                <LevelMeter channelId={microphone.source?.id ?? null} label="Your microphone" />
              </div>
            ) : null}

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
                Joining starts your camera and microphone and announces you to the director. Your
                video goes straight to them, not through any server.
              </p>
            )}

            {roomsSupported ? (
              <Button variant="outline" size="sm" onClick={() => void copyRoomLink()}>
                {roomLinkCopied ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {roomLinkCopied ? 'Copied' : 'Copy room link'}
              </Button>
            ) : null}

            {permissionDenied ? <PermissionHelp camera={camera} microphone={microphone} /> : null}
          </div>
        </div>
      ) : (
        /* ============================================================= CALL */
        <div className="flex min-h-0 flex-1 flex-col">
          {/* A director cue — the one thing a guest must not miss. */}
          {guestSession.cue ? (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-2 border-b border-accent-500 bg-accent-500/10 px-3 py-2"
            >
              <p className="flex-1 text-sm leading-snug text-accent-400">{guestSession.cue.text}</p>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={guestSession.dismissCue}
                aria-label="Dismiss cue"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}

          {/* ------------------------------------------------------- stage */}
          <div className="relative flex min-h-0 flex-1 flex-col gap-2 bg-black p-2">
            {webrtc.programStream ? (
              /*
               * `h-full w-full`, not `max-h-full max-w-full`.
               *
               * A max-* pair caps the element at its *intrinsic* size, so a
               * 720p program sat at 1280×720 in the middle of a larger stage
               * and refused to grow. Sizing to the container and letting
               * `object-contain` letterbox fills the space given while still
               * never distorting the aspect.
               */
              <video
                ref={stageRef}
                autoPlay
                playsInline
                aria-label="The director's program feed"
                className="min-h-0 w-full flex-1 bg-black object-contain"
              />
            ) : participantsWithoutDirector.length > 0 ? (
              /*
               * No director: the room is a call, so the participants *are* the
               * stage. `auto-fit` rather than a fixed column count, so one
               * other person gets the whole width and five share it — the
               * grid follows the room instead of the room being squeezed into
               * a layout chosen in advance.
               */
              <div className="grid min-h-0 w-full flex-1 content-center gap-2 overflow-y-auto [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                {participantsWithoutDirector.map((participant) => (
                  <ParticipantTile key={participant.peerId} participant={participant} />
                ))}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center text-ink-500">
                <Radio aria-hidden="true" className="h-8 w-8" />
                <p className="text-sm text-ink-300">
                  {peer?.status === 'failed'
                    ? 'The connection failed.'
                    : 'You are the only one here.'}
                </p>
                <p className="max-w-sm text-[11px] leading-relaxed text-ink-500">
                  Send the room link to whoever should join. If a director opens this room, their
                  composed program takes over this space.
                </p>
                {roomsSupported ? (
                  <Button variant="outline" size="sm" onClick={() => void copyRoomLink()}>
                    {roomLinkCopied ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {roomLinkCopied ? 'Copied' : 'Copy room link'}
                  </Button>
                ) : null}
              </div>
            )}

            {/*
              With a director on the stage, the other guests go in a strip.

              Fixed height and horizontally scrollable: the program is the
              thing being watched, so a growing number of participants must not
              eat into it.
            */}
            {webrtc.programStream && participantsWithoutDirector.length > 0 ? (
              <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                {participantsWithoutDirector.map((participant) => (
                  <ParticipantTile
                    key={participant.peerId}
                    participant={participant}
                    className="h-24 w-40 shrink-0 sm:h-28 sm:w-48"
                  />
                ))}
              </div>
            ) : null}

            {/*
              Self-view, floating over the stage the way a meeting does.

              A `figure`/`figcaption` rather than a div and a paragraph: this is
              a thumbnail *with a caption naming who it is*, which is exactly
              what the pair means, and it gives the name a real relationship to
              the video instead of being loose text positioned nearby.
            */}
            <figure
              className={cn(
                'absolute right-3 bottom-3 m-0 aspect-video w-32 overflow-hidden border bg-deck-950 shadow-lg transition-colors sm:w-44',
                // The ring is the "you are being heard" signal, replacing the
                // meter that used to sit in the control bar.
                speaking ? 'border-accent-400' : 'border-deck-600',
              )}
            >
              {selfVideo}
              <figcaption className="absolute bottom-0 left-0 flex items-center gap-1 bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">
                <SpeakingIndicator speaking={speaking} muted={micOff} />
                {displayName}
              </figcaption>
            </figure>
          </div>

          {/* -------------------------------------------------- control bar */}
          <div className="flex shrink-0 flex-col gap-2 border-t border-deck-700 bg-deck-900 px-3 py-2">
            <div className="flex items-center justify-center gap-2">
              {mediaControls}

              {roomsSupported ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => void copyRoomLink()}>
                    {roomLinkCopied ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {roomLinkCopied ? 'Copied' : 'Invite'}
                  </Button>
                  <Button variant="live" size="sm" onClick={leave}>
                    <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
                    Leave
                  </Button>
                </>
              ) : null}
            </div>

            {permissionDenied ? (
              <div className="mx-auto w-full max-w-xl">
                <PermissionHelp camera={camera} microphone={microphone} />
              </div>
            ) : null}

            {peer?.error ? (
              <div className="mx-auto w-full max-w-xl">
                <Notice tone="error">{peer.error}</Notice>
              </div>
            ) : null}

            {/* ------------------------------------------- answer link */}
            {answerUrl ? (
              <div className="mx-auto flex w-full max-w-xl flex-col gap-2 border border-accent-600 bg-accent-500/5 p-3">
                <p className="text-[10px] font-semibold tracking-wider text-accent-400 uppercase">
                  Send this back to the director
                </p>
                <p className="text-[11px] leading-relaxed text-ink-400">
                  This room has no signaling server, so this last step is manual. Send them this
                  link — one click on their side completes the connection.
                </p>
                <label className="sr-only" htmlFor="answer-link">
                  Your answer link
                </label>
                <textarea
                  id="answer-link"
                  readOnly
                  rows={2}
                  value={answerUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  className="url-box w-full resize-y border border-deck-600 bg-deck-950 px-2 py-1.5 text-ink-300"
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void invite.copy(answerUrl).then((ok) => {
                        setCopied(ok)
                        if (ok) setTimeout(() => setCopied(false), 2000)
                      })
                    }}
                  >
                    {copied ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <ClipboardCopy aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                  <span className="font-mono text-[10px] text-ink-500">
                    {answerUrl.length} chars
                  </span>
                </div>
                {invite.copyFailed ? (
                  <p className="text-[11px] text-live-400">
                    Clipboard access was refused — select the link above and copy it manually.
                  </p>
                ) : null}
              </div>
            ) : !peer && !roomsSupported ? (
              <div className="mx-auto w-full max-w-xl">
                <Notice>
                  Waiting for an invite. This room has no signaling server, so opening{' '}
                  <code className="url-box">/push/{room}</code> on its own cannot connect you — the
                  director’s invite link fills this page in automatically.
                </Notice>
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
