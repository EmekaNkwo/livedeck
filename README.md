# LiveDeck Studio

A video production studio that runs in the browser. Bring in camera, screen
share and remote guests, compose them into scenes, mix the audio, switch layouts
live, and record the finished program — with no installation and no accounts.

The joining workflow follows a **meeting tool**: you open a control room, copy
one room link, and send it. Whoever opens it sets a name, clicks **Join room**,
and appears in your control room — nothing to paste back. Introducing the two
sides needs a signaling relay, which ships in [`server/`](server/) and is the
default.

Everything *except* joining works with no backend at all, and a
zero-infrastructure joining path is still supported: in **Manual** mode the
invite link carries the connection details itself. See
[Signaling transports](#signaling-transports).

The production engine underneath follows **OBS**: a logical canvas, saved scenes
you cut between, a real audio mixer, and a recorder that captures the composed
program output.

```
/director/:room        the control room — guests, scenes, mixer, recorder
/push/:room            a guest's sender: camera + microphone, nothing else
/scene/:room           a clean program output, for capturing in OBS
/solo/:room/:sourceId  one feed, clean, no composition
```

```
Camera / Screen / Guest sources
              │
              ▼
       Source Manager ──────── StreamRegistry (ref-counted stream ownership)
              │
              ▼
        Scene Engine  ──────── scenes, transforms, layers, transitions
              │
              ▼
     Program Compositor ────── one Canvas 2D render loop
              │
      ┌───────┴────────┐
      ▼                ▼
 Live Preview    canvas.captureStream()
 (same canvas)          │
                        ├──────── Program video track
                        │
  Mic / Guests / Media ─┤
      │                 │
      ▼                 │
  Audio Mixer ──────────┤
  (Web Audio graph)     │
      │                 ▼
      └──────────▶ MediaRecorder
                        │
                        ▼
              Local recording (IndexedDB)
```

---

## Contents

- [Quick start](#quick-start)
- [Scripts](#scripts)
- [Browser requirements](#browser-requirements)
- [Rooms and roles](#rooms-and-roles)
- [Solo links share one feed](#solo-links-share-one-feed)
- [Invite links (Manual mode)](#invite-links-manual-mode)
- [URL parameters](#url-parameters)
- [The director is not in the room](#the-director-is-not-in-the-room)
- [Nothing starts by itself](#nothing-starts-by-itself)
- [Who can share a screen](#who-can-share-a-screen)
- [A room does not need a director](#a-room-does-not-need-a-director)
- [The guest view is a meeting, not a studio](#the-guest-view-is-a-meeting-not-a-studio)
- [Director controls](#director-controls)
- [Operation modes](#operation-modes)
- [Architecture](#architecture)
- [The source model](#the-source-model)
- [Resource ownership and cleanup](#resource-ownership-and-cleanup)
- [The scene model](#the-scene-model)
- [Coordinate system](#coordinate-system)
- [The canvas compositor](#the-canvas-compositor)
- [Scene transitions](#scene-transitions)
- [The audio graph](#the-audio-graph)
- [The recording pipeline](#the-recording-pipeline)
- [WebRTC and signaling](#webrtc-and-signaling)
- [Signaling transports](#signaling-transports)
- [Deploying the relay with Docker](#deploying-the-relay-with-docker)
- [Persistence](#persistence)
- [Performance decisions](#performance-decisions)
- [Accessibility](#accessibility)
- [Testing strategy](#testing-strategy)
- [Known limitations](#known-limitations)
- [Guided demonstration](#guided-demonstration)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)

---

## Quick start

```bash
npm install
npm run dev                            # studio  -> http://localhost:5173

# in a second terminal — needed for guests to join by room link
npm install --prefix server
npm --prefix server run dev            # relay   -> http://localhost:3001
```

Name a room (or click **New code**) and click **Open director**. Start your
camera from the Sources tab, then copy the room link from the Guests tab and
send it. Your guest opens it, types a name, clicks **Join room**, and appears in
your control room.

Without the relay running, the Guests panel says so plainly and points at
Settings › Signaling › **Manual** — which needs nothing running, at the cost of
one link per guest and a reply to paste back.

Media capture requires a **secure context**. `localhost` counts as one, so plain
HTTP works in development. Deploying over `http://` to any other host will stop
`getUserMedia` from working at all — the app detects this and says so rather
than blaming permissions.

There are no API keys and no accounts. Environment variables are all optional —
see [`.env.example`](.env.example) for the studio (relay address, TURN servers)
and [`server/.env.example`](server/.env.example) for the relay (port, allowed
origins).

**Media never touches a server.** The relay forwards the text of the handshake
and nothing else; audio and video go directly between browsers in both
transports.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck all projects, then production build |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc -b` across app, node and e2e projects |
| `npm run lint` | oxlint over `src` and `e2e` |
| `npm test` | Vitest unit and integration suite |
| `npm run test:coverage` | Vitest with a V8 coverage report |
| `npm run e2e` | Playwright browser tests (run `npm run e2e:install` once first) |
| `npm run verify` | typecheck + lint + unit tests |

## Browser requirements

Everything is gated on real feature detection (`src/lib/capabilities.ts`), never
on user-agent sniffing. Missing capabilities are reported in the lobby and in
the diagnostics panel with an explanation of what degrades.

| Capability | Required for | If missing |
| --- | --- | --- |
| Secure context | All capture | **Blocking** — nothing can be captured |
| `getUserMedia` | Camera, microphone | **Blocking** |
| `canvas.captureStream` | Recording, peer sending | **Blocking** for output |
| `getDisplayMedia` | A guest sharing a screen | Share button disabled |
| `MediaRecorder` | Recording | Composition and preview still work |
| Web Audio API | Mixing, meters, recorded audio | Video-only recording |
| `RTCPeerConnection` | Peer Connection Mode | Local Studio Mode unaffected |
| IndexedDB | Persisting recordings | Recordings are download-only |
| `MediaRecorder.pause` | Pausing a recording | Start/stop still work |

Developed and verified against current Chromium. Firefox and Safari work for
composition, mixing and recording; Safari records MP4/H.264 rather than WebM
(the recorder negotiates this — see [the recording pipeline](#the-recording-pipeline)).

### Media permissions

- The camera and microphone are requested separately, and only when you click
  the relevant button — nothing prompts on page load.
- Permission state is read via the Permissions API where available. Firefox
  rejects `query({name: 'camera'})`, so the state falls back to `unknown` and is
  inferred from the next capture attempt.
- A denied permission produces a specific recovery path (retry, choose another
  device, continue without) rather than a generic error.
- Device labels are blank until permission has been granted at least once; the
  app substitutes positional names ("Camera 1").

---

## Rooms and roles

A **room** is just a name. A **role** is a URL, and the role decides what the
page *is* — not what it shows. A push view has no mixer and no recorder; a scene
view has no interface at all.

| Route | Role | What it is |
| --- | --- | --- |
| `/director/:room` | Director | The control room: guest tiles, scenes, mixer, recorder, invite links |
| `/push/:room` | Guest | A sender — camera and microphone, and the one link to send back |
| `/scene/:room` | Scene output | The composed program with zero chrome, at the logical canvas size |
| `/solo/:room/:sourceId` | Solo | One feed, uncomposed, for a downstream tool to lay out itself |

Navigating to a room creates it; there is no separate "new project" step.

### Joining a room

With the relay running — the default — a room name **is** enough to connect: the
guest opens `/push/:room`, sets a display name, and clicks **Join room**. Only
the director offers; if both sides offered on sight they would glare and produce
two half-negotiated peers with no media.

Joining is a deliberate click rather than something that happens on page load,
for one reason: a guest's camera and microphone should not enter someone else's
production because they opened a URL. Capture starts with that click too, which
is also the user gesture browsers require before an `AudioContext` will run.

In **Manual** mode there is no server to match peers, so a room name alone
cannot connect anybody — the invite link establishes the connection instead,
and the guest page shows no join control because there is nothing to join.

### A room name is not access control

A room name authenticates nothing and authorizes nothing. With the relay
running this has teeth: anyone who can reach it and guesses the name **will**
join that room and be offered a connection. There is no account, no token and
no access check — none of which could exist without a backend that owns
identity, which this is not. The UI says so wherever a room name appears.

### The scene route is the OBS integration

`/scene/:room` renders the program output and literally nothing else — no
header, no controls, no cursor, because anything there would be captured. Open
it in a second window and point a window-capture source at it. A short hint
appears for a few seconds for whoever opened it directly, then is removed from
the DOM entirely so it can never land in a recording.

**The control room sends it the program.** This is not an optimisation: a
`MediaStream` belongs to the context that created it, and streams are never
persisted, so a second window loading the same saved scenes gets source
definitions with no media attached — a black output with every live source
missing. Instead the director publishes the composed canvas plus the mixed
audio over a **loopback RTCPeerConnection**, handshaken through a
`BroadcastChannel`. No server, no STUN, nothing leaves the machine; both ends
are the same browser, so host candidates always pair.

So the scene window shows the *actual* program pixels — camera, screen share,
guests, transitions and all. The audio track is carried too, but the element is
muted: a second unmuted playout of a live microphone in another window is an
acoustic feedback loop, and the control room already decides whether to monitor.

With no control room open there is nothing to mirror, so it falls back to its
own compositor — which still draws everything serializable, like colour
backgrounds, text and the scene layout — and the hint says plainly that live
sources need the control room.

### Solo links share one feed

A guest tile has **Share**, and a selected source has **Copy solo link** in the
properties panel. Both produce `/solo/:room/:sourceId` — that feed alone,
uncomposed, with no interface.

This is how you hand one camera to somebody without giving them the control
room: a second operator capturing one guest as a separate layer, or a stream
that needs the raw feed rather than your composition. The link is tied to the
room *and* that source id, so it stops resolving when the source is removed
rather than silently showing a different feed.

It arrives over the same loopback mirror the scene window uses, so the control
room has to be open in another window — and a solo window opened *before* its
source is started connects anyway and picks up the track when it appears,
because the publisher declares the m-lines up front and attaches the track with
`replaceTrack`.

A solo link is **not** access control, exactly like a room name: anyone holding
it can open that feed while the control room is publishing.

## Invite links (Manual mode)

Everything in this section describes the **Manual** transport — the
zero-infrastructure path. With the relay there is one reusable room link with no
payload in it, so none of this applies.

With no server to match peers by room, the link **carries the offer itself**:

```
https://host/push/sunday-service#i=LD1z:q1Z2…
                └─ role ┘└─ room ┘└─ the offer ┘
```

No guest name is baked in. A name in a link is wrong the moment it is
forwarded, and guests name themselves on the join screen — so the director
never types it in either transport.

The guest opens it, their browser already has everything it needs, and it
answers automatically. They get one link back for the director to apply.

Three decisions worth stating:

- **The payload is in the fragment, after `#`.** Fragments are never sent to a
  server — not in the request line, not in logs, not in a `Referer`. So even on
  someone else's static host, the offer never reaches them. A query string would
  leak it into access logs.
- **It is DEFLATE-compressed** via `CompressionStream`, because an SDP with a
  full candidate set runs to several kilobytes and base64 adds a third on top.
  SDP is extremely repetitive, so this typically takes 60–75% off. Browsers
  without the API fall back to uncompressed transparently.
- **The fragment is cleared once consumed**, with `replaceState`, so a reload
  cannot re-apply a stale offer and it is not reachable with the back button.

A pasted answer is accepted as a full link, a bare token, or raw JSON, because
people paste all three. Each failure mode gets its own message: a truncated
link, an answer pasted where an invite belongs, or text that is not a LiveDeck
payload at all.

### Still one manual step

The guest's answer has to come back by hand — no server can carry it. It is
presented as a link they can send rather than a blob to paste into the right
box, but it is a step, and the UI does not pretend otherwise.

## URL parameters

Configuring a session through the link, as VDO.Ninja does. Every parameter below
does something real; unrecognised keys are **reported in the view** rather than
silently ignored, so a typo surfaces.

| Parameter | Value | Effect |
| --- | --- | --- |
| `&label=` `&name=` | text | Display name for the participant |
| `&muted` `&mute` | flag | Join with the microphone track disabled |
| `&novideo` | flag | Do not request a camera at all |
| `&noaudio` | flag | Do not request a microphone at all |
| `&quality=` | 480 \| 720 \| 1080 | Short-edge resolution for capture and output |
| `&fps=` `&framerate=` | 24 \| 30 \| 60 | Frame rate for capture and recording |
| `&ratio=` `&aspect=` | 16:9 \| 9:16 \| 1:1 \| 4:3 | Program canvas aspect ratio |
| `&cleanoutput` `&clean` | flag | Hide every interface element |
| `&mirror` | flag | Mirror the local camera preview |
| `&autostart` `&autojoin` | flag | Request the camera immediately on load |
| `&scene=` | number | Which scene to show on load, 0-based |

Flags work bare (`&muted`) or with a value (`&muted=false`). The in-app cheat
sheet is generated from the parser's own list, so a parameter cannot be
documented without being implemented, or vice versa.

`&autostart` starts the *camera* only. Audio still needs a click, because
browsers will not start an `AudioContext` without a user gesture — promising
otherwise would just produce a silent guest.

### Who can share a screen

**Guests can. The control room cannot.** The director's role is to conduct and
structure scenes out of what the room sends it; the material comes from the
participants. There is no screen capture in the control room at all — no
button, no command, no shortcut.

A guest shares from the guest view, and it **replaces their camera** rather
than joining it. One outgoing video track means no renegotiation with every
peer in the mesh when a share starts, and no doubling of that guest's upload
for its duration. The trade is explicit and is the one every meeting tool
makes: while sharing, that guest's camera is not going out — to anyone,
including the director's program, where their feed becomes the screen.

Nothing in WebRTC says what a track is *of* — a shared document and a face
arrive as the same kind of video — so the sharer reports it over the control
channel (`{type: 'sharing'}`), validated as strictly as every other message
because it is remote input that drives layout. Receivers give it the
screen region. It is re-announced whenever the peer set changes, or somebody
joining mid-share would see nothing being shared at all.

The shared screen gets **its own region** above the participant grid, never a
cell inside it. A screen is a different kind of thing from a face: a different
shape (a desktop is not 16:9), read rather than glanced at, and only worth
sharing if it is large. As a grid cell it resized everybody else the instant
anyone started or stopped, and the layout lurched.

The sharer is never shown their own screen — sharing the tab containing the
call renders it inside itself, forever — so they get a placeholder, and their
own tile reports that their camera is not going out.

### A room does not need a director

Guests in the same room connect to **each other**, so a room works as a plain
call with no control room in it at all. One guest opens `/push/:room`, sends the
link on with **Invite**, and the next one appears — no director, no scenes, no
recorder.

Who offers is decided by role, because exactly one side must or both create a
connection and glare:

| | Offers to | Why |
| --- | --- | --- |
| Director → guest | every guest | It has the initiative: it is the one peer guaranteed to be in the room exactly once |
| Guest → guest | the peer with the lesser id | Neither has standing, so the tie breaks on peer id — both sides run the same comparison and reach opposite conclusions, so precisely one offers |
| Guest → director | never | The director will offer |

A guest's inbound streams are **not** turned into sources. A guest has no
scenes, no mixer strip and no compositor to put one in, so building a
production model nothing renders would only add mixer channels duplicating
audio that is already playing through the participant's own video element. Only
a control room does that.

This is a **full mesh**, which is what makes it work without a server-side
mixer — and also what caps the room size: every guest encodes its camera once
per peer, so cost grows with the square of the room. See
[Known limitations](#known-limitations).

### The director is not in the room

A control room **receives every guest and sends nothing back**. It has no tile
in the call, no feed, and no presence in the layout — guests see guests. It
used to send its composed program to each of them, which encoded the canvas
once per guest for a feed nobody needed and put a black rectangle (an empty
program is a black canvas) in the middle of a call the director is not part of.

The peer connection stays, because it carries the guests' media *to* the
control room and the control channel back — remote mute, cue, on-air tally.

A participant is somebody the **room roster** announced. Identity comes from
the relay, not from media: an SDP envelope does not carry the sender's name or
role, so a stream from a peer the room never announced is not rendered as a
person. Without that rule the control room's own empty m-lines appeared as a
phantom guest with no video.

### Nothing starts by itself

Joining does not switch on a camera or a microphone. The lobby has a toggle for
each, and whatever state they are in is what joins — arriving in a room already
broadcasting is the one decision a conferencing tool must never make for
somebody. The `AudioContext` is still prepared on the join click, because
browsers will not start one without a gesture, but preparing a mixer captures
nothing.

Turning either on later works, which is less obvious than it sounds. Nothing
here renegotiates — manual signaling could not without another copy/paste
round, and in a mesh it would mean a fresh offer to every peer — so the m-lines
present at offer time are all there will ever be. Every connection therefore
declares **send-capable** audio and video m-lines up front, even with nothing
to send, and a track that appears later is attached with `replaceTrack`. They
used to be `recvonly`, which left no sender to put a later track into: a guest
who joined with their camera off stayed invisible for the whole call however
many times they pressed the button, and a screen share reached nobody.

### The guest view is a meeting, not a studio

A **lobby** — set a name, check your camera, join — and then a **call**:
everybody in one grid, including this guest's own camera, and a control bar.
The mic and camera controls are split: the left half toggles, the right half
opens a device picker, because "turn my camera off" and "use my *other* camera"
are different intentions and burying the second one in a settings page is how
people join on the wrong device.

Columns come from the participant count rather than being fixed — two people
get half the width each, four get a 2×2 — and `grid-auto-rows: 1fr` makes rows
share the height, because rows sized to content leave a band of dead space
under the last one.

A **shared screen** is not in that grid. It gets its own region above it, and
the grid becomes a scrolling strip of faces beneath. See
[Who can share a screen](#who-can-share-a-screen).

Both the stage and the tiles are sized to their container, not to the video.
`max-width`/`max-height` caps an element at its *intrinsic* size, so a 720p
program sat at 1280×720 in the middle of a wider stage and refused to grow;
sizing to the container and letting `object-contain` letterbox fills the space
given without ever distorting the aspect.

### Speaking indicators, not level meters

There is no dB meter anywhere in the guest view — not in the lobby, not in the
call. A level meter answers *how loud*, which is a question for setting up a
mix; the question a participant actually has is *am I being heard*, and a ring
around a face answers that better than a moving bar. The mixer in the control
room still has real meters, because that is where loudness is the point.

The control room shows the same indicator on each guest tile, read from their
mixer channel. That channel taps **pre-fader**, so a guest muted in the local
mix still registers as speaking — which is exactly how an operator notices
somebody is talking while muted. A guest who muted their *own* microphone is
genuinely not audible, and the indicator reports muted instead of speaking.

Detection uses a threshold above room noise plus a short hold, because speech
has gaps between syllables and a bare threshold test flickers through every one
of them.

## Director controls

A VDO.Ninja director genuinely mutes a guest, rather than just dropping them
from their own monitor. That needs a second path alongside the media, so each
peer connection carries an `RTCDataChannel` running a small typed protocol.

The two kinds of control are separated everywhere, in the code and on screen:

| | Travels | Effect | Can it fail? |
| --- | --- | --- | --- |
| **Remote** — mute mic, mute camera, cue, on-air tally | Data channel | Changes the guest's **own tracks** (`track.enabled = false`) | Yes — the channel may not be open, so each command returns a result and the UI reports failure |
| **Local** — mute in mix, hide video, solo | Nothing | This machine's program output only | No — but the guest is never told |

Conflating them would mean telling an operator they had silenced someone when
they had only silenced their own speakers.

Supporting details:

- The guest **reports its real track state back**, read off the tracks rather
  than from a local boolean. So the control room shows what the guest's hardware
  is doing, and a guest unmuting themselves is visible upstream.
- Remote controls are **disabled with an explanation** when the channel is not
  open, rather than appearing to work.
- Every inbound message is **structurally validated** before it can touch a
  `MediaStreamTrack`. Payloads are remote input from a peer that could send
  anything; `muted: "true"` is rejected rather than coerced, cue text is
  length-bounded, and unknown types are dropped.
- The channel is **ordered and reliable**: an out-of-order "unmute" arriving
  before a "mute" would leave a guest muted with the director's UI disagreeing.
- A 5-second heartbeat measures control latency and detects a dead channel. It
  is torn down with the channel, so a closed peer never leaves a timer running.
- **Solo** is a reversible edit to the active scene — the soloed item is fitted
  to the canvas and brought to the front, everything else is hidden, and exiting
  restores the exact prior state from a snapshot. An item that was *already*
  hidden stays hidden. Doing it this way means solo is visible in the scene, is
  recorded like any other change, and needs no special case in the renderer.

---

## Operation modes

The two modes are genuinely different, and the UI never blurs them.

### Local Studio Mode

Everything runs on your device: capture, composition, mixing, recording.
**No signaling server, no network dependency of any kind.**

This is the whole production pipeline minus the guests — camera, screen share,
microphone, images, video, text and colour sources, composed into scenes, mixed,
and recorded to a file. Nothing here needs a second participant.

### Peer Connection Mode

Real browser-to-browser media over WebRTC. Guests join by room link with the
relay running, or through the
[invite-link workflow](#invite-links-manual-mode) in Manual mode. See
[WebRTC and signaling](#webrtc-and-signaling) for the ICE details and the real
limitations.

There is deliberately **no mock signaling adapter that pretends to connect two
devices**. An in-memory event bus cannot carry SDP between browsers, and
presenting one as if it could would be a lie.

---

## Architecture

### The core rule

**Presentation is strictly separated from business logic.** Components render
state, display controls, and call actions. They do not own the media lifecycle,
the recording engine, WebRTC orchestration, audio processing or scene rules.

- **Services** (`src/services/`) are plain TypeScript classes and functions with
  no React dependency. They own browser APIs and live objects.
- **Hooks** (`src/hooks/`) are the only bridge. Each has one responsibility and
  exposes a service's capability as state plus actions.
- **Stores** (`src/stores/`) hold serializable state, split by domain.
- **Components** (`src/components/`) render.

Concretely: no component constructs an `RTCPeerConnection`, builds a recording
pipeline, creates an `AudioNode`, or drives the compositor's render loop. The
objective is that the studio could be redesigned without rewriting any of its
media logic.

### State domains

| Store | Holds | Persisted |
| --- | --- | --- |
| `studioStore` | Session metadata, capture status, UI state (selection, panels, dialogs, drag) | Session only |
| `sourceStore` | Source definitions | Yes (stream refs stripped) |
| `sceneStore` | Scenes, items, transforms, active scene, live transition | Yes (transition is not) |
| `guestStore` | Guest identity, **separately** peer transport state, peer stats and control-channel state | Identity only |
| `audioStore` | Mixer channel configuration | Yes (monitoring forced off) |
| `recordingStore` | Recorder status, library metadata | Metadata in IndexedDB |
| `settingsStore` | Output quality, editor and accessibility preferences | Yes |

Three categories of state are deliberately kept apart: **persistent
configuration**, **ephemeral session state** (live streams, connections, active
recording), and **UI state**.

Zustand selectors are used throughout so a telemetry tick, a timer, or an audio
meter never re-renders the whole studio.

---

## The source model

```ts
type MediaSource = {
  id: string
  name: string
  type: SourceType       // camera | microphone | screen | remote-video |
                         // remote-audio | image | video | text | color-background
  visible: boolean
  locked: boolean
  muted: boolean
  layer: number
  settings: SourceSettings   // discriminated union, type-specific, serializable
  streamKey: string | null   // index into the StreamRegistry — never a MediaStream
  volume: number
  createdAt: number
}
```

`visible`, `locked` and `layer` on a source are the **defaults applied when it
is placed into a scene**. The authoritative per-scene values live on the
matching `SceneItem`, because the same source can appear in several scenes with
different visibility and stacking. The Sources panel edits the current scene's
item — the same model OBS uses.

Live objects are never stored on a source. `streamKey` is a string index into
the `StreamRegistry`, which is what makes a source serializable and what allows
several sources to share one capture.

## Resource ownership and cleanup

This is the most load-bearing piece of the design, so it gets a precise rule.

> **Each source definition that holds a `streamKey` owns exactly one reference
> in the `StreamRegistry`. The capture stops only when the count reaches zero.**

- Acquiring a capture **registers** the key (count 1) for the source about to be
  created.
- **Duplicating** a source **retains** the key (+1) — the clone shares the
  capture, because two views of one camera is the point and a second
  `getUserMedia` call for the same device often fails outright.
- **Removing** a source **releases** the key (−1).
- Preview components and the compositor **read** from the registry without
  retaining. They can do that safely because a source reference always outlives
  any view of it.

No component and no hook ever calls `track.stop()` directly. This is what
prevents the classic failures: closing the inspector blacking out the camera, or
deleting a duplicated source killing the original's video. Both are covered by
tests.

The registry also owns one hidden `<video>` element per video stream, which the
compositor draws from — so scene rendering is decoupled from whatever the UI
happens to be mounting.

When a track ends on its own (the browser's own "Stop sharing" button, a device
unplugged, an OS privacy shutter), the registry disposes the entry regardless of
reference count and notifies listeners, which convert it into application state.
The UI updates itself rather than continuing to claim it is sharing.

Removing a guest closes its `RTCPeerConnection` as well as releasing its
sources. Dropping only the guest row would leave a live peer — with its ICE
agent, transports and stats timer — running with nothing referencing it.

Explicit cleanup exists for: MediaStream tracks, AudioContext nodes, animation
frames, intervals, canvas resources, video element references, MediaRecorder
listeners, peer connections, signaling listeners, object URLs, resize observers
and keyboard listeners. Ending a session releases everything that session owned,
in a deliberate order (stop drawing → stop recording → close transports →
release media and audio). Leaving a *panel* releases nothing.

## The scene model

```ts
type Scene = {
  id: string                  // always referenced by id, never by name
  name: string
  order: number
  transition: { type: 'cut' | 'fade' | 'crossfade'; durationMs: number }
  items: SceneItem[]
  createdAt: number
}

type SceneItem = {
  sourceId: string
  transform: SourceTransform
  visible: boolean
  locked: boolean
  layer: number               // higher = drawn on top
  mirrored: boolean
  opacity: number
}
```

Scenes are addressed by id, so renaming one can never break a persisted
reference. Deleting the active scene moves the program output to a neighbour —
the output always has somewhere to point — and the last remaining scene cannot
be deleted at all.

## Coordinate system

All placement is in **normalized logical canvas space**: `x`, `y`, `width` and
`height` are fractions of the logical output (0 = left/top, 1 = right/bottom).

```ts
type SourceTransform = {
  x: number; y: number; width: number; height: number
  rotation: number                               // degrees, clockwise, about the centre
  crop?: { top: number; right: number; bottom: number; left: number }
}
```

One representation is shared by the editor, the compositor and the recorder,
which is why changing the output resolution or resizing the browser window never
disturbs a composition. `crop` insets are fractions of the **source frame**, not
the canvas, so a crop survives resizing the item.

Every edit passes through `normalizeTransform`, which clamps extents to a usable
minimum, caps them at one canvas, keeps a grabbable part of the item on screen,
and stops opposing crop insets from consuming the whole frame. No typed, pasted
or dragged value can push a composition into an unrecoverable state.

**Gesture math happens in viewport pixels, not normalized units.** Normalized
space is a unit square while the canvas usually is not, so rotating there would
shear the item. The interaction controller
(`src/services/composition/interaction-controller.ts`) is a set of pure
functions over an immutable gesture state — drag, resize, rotate and crop on
rotated, snapped, aspect-locked boxes — which is why it is unit-testable without
a DOM. The React hook only translates pointer events into gesture updates.

## The canvas compositor

A single `CanvasCompositor` owns the program canvas and the render loop.

**The preview and the recording are the same pixels.** The `<canvas>` in the
studio *is* the program canvas; `captureStream()` for the recorder and for peer
senders is taken from that same element. There is no second compositor, so
preview and output cannot drift. Editor chrome — selection boxes, resize
handles, snap guides — is a separate DOM layer, which is why it never appears in
a recording.

- A `FrameProvider` resolves each source into something drawable, so the render
  loop knows nothing about source types and adding one does not touch it.
- Missing, loading, ended or undecodable sources degrade to "not drawn" with a
  reason, never to a thrown exception.
- `drawImage`'s 9-argument form maps the cropped sub-rectangle of the source onto
  the destination box, which is what makes crop affect real output.
- Rotation and mirroring are applied about the item's centre, matching the
  editor overlay's CSS transform exactly.
- The loop is driven by `requestAnimationFrame` but gated to a target rate, and
  **skipped entirely** when nothing is animating and no live media is on screen
  (a `revision` counter on the stores detects static changes). The captured
  stream simply holds its last frame, which is correct.
- Logical output is independent of the window. Dimensions are forced even,
  because most hardware encoders require it.

Two constraints here were found by browser testing rather than by reasoning,
and both are load-bearing:

- **React must not set the canvas `width`/`height` attributes.** Assigning a
  canvas dimension attribute resets its backing store, so React re-applying the
  same value on an unrelated re-render blanked the program output — and the
  compositor then skipped the repaint, because its change-detection revision had
  not moved. The compositor owns those attributes exclusively.
- **`desynchronized: true` is not used on the context.** It makes `getImageData`
  read back a stale or empty buffer in Chromium (verified: a drawn white frame
  read back as transparent black). For a canvas whose pixels are the product,
  reliable readback beats the small latency win.
- **The studio renders exactly one layout.** The desktop and mobile trees are
  different components, so rendering both and hiding one with `lg:hidden` mounted
  two `ProgramCanvas` instances — and the compositor attached to the hidden one.
  `useBreakpoint` picks a single layout, which also stops every panel's effects
  from running twice.

Output formats: `16:9`, `9:16`, `1:1`, `4:3` at 480p/720p/1080p. The named
resolution always describes the **short** edge, so 720p in 9:16 is 720 wide.

## Scene transitions

`cut` (instant), `fade` (dip through the background) and `crossfade` (direct
dissolve), with a configurable duration up to 3s. Transitions are rendered by
the compositor from a `startedAt` timestamp, so **they appear in recordings**.
Two scratch canvases are used during a transition so per-layer opacity is not
multiplied by the transition alpha twice.

React is told only when a transition *finishes* — one state update per switch
instead of one per frame.

Production transitions are configured per scene and are **independent of the
interface's reduced-motion setting**, which only affects UI chrome.

## The audio graph

Per channel:

```
MediaStream
  → MediaStreamAudioSourceNode
  → inputGain      (dB trim)
  → analyser       ← pre-fader tap: meters keep moving while muted
  → faderGain      (volume × mute — this is what reaches the program)
  → mixBus
  └→ monitorGain   (local listen, silent by default)
```

Program bus:

```
mixBus → masterGain → analyser → MediaStreamAudioDestinationNode  → recorder
                               └→ programMonitorGain → speakers
```

The analyser sits **before** the fader deliberately: a muted channel still shows
level, which is how an operator notices a muted guest is talking. The recorder
taps the destination node, so what you hear in the file is exactly what the
faders and mutes produced.

### Three distinct mute concepts, never conflated

| Operation | Effect | Where |
| --- | --- | --- |
| **Mute input** | `track.enabled = false` — nothing is captured or recorded | Capture panel |
| **Mute in mix** | Channel excluded from the program bus; capture and metering continue | Mixer |
| **Monitoring** | Whether a channel reaches your speakers. **Off by default** | Mixer |
| **Mute a guest** | Excludes them from *your local mix only*. The remote peer is not told and keeps sending | Guests panel |

Monitoring is off by default because routing a live microphone to the speakers
in a browser tab is an acoustic feedback loop.

### Implementation notes

- The `AudioContext` is created lazily **from a user gesture** (starting the
  microphone, or an explicit "Enable audio engine" button), because browsers
  otherwise start it suspended and no audio flows. It is resumed automatically
  when the tab returns to the foreground.
- `useAudioMixer` **reconciles** rather than rebuilds: it compares the channels
  that should exist against the ones the mixer has and makes only the
  difference. A fader move updates a `GainNode` in place; it never recreates a
  `MediaStreamAudioSourceNode`. Gain changes are ramped, because an abrupt
  change on a live signal is an audible click that lands in the recording.
- Combined gain is hard-clamped, so no fader position can blow out the recording
  or the user's speakers.
- Meters are published on a **separate pub/sub bus** at 20Hz and written
  straight to DOM nodes as a CSS transform. They cost **zero React renders**.
  Subscriptions are per channel and are torn down with the component.

## The recording pipeline

```
Program canvas ──▶ canvas.captureStream(fps) ──▶ video track ─┐
                                                              ├─▶ MediaRecorder ──▶ Blob
Audio mixer ─────▶ MediaStreamAudioDestination ──▶ audio track┘
```

Because there is no separate render or mix for recording, scene switches,
transforms, crops, rotations, hidden sources, mutes and fader moves are all in
the file **by construction**.

### Format negotiation

Browser support genuinely diverges — Chrome and Firefox prefer WebM (VP9/VP8 +
Opus), Safari only produces MP4 (H.264 + AAC) and rejects WebM outright. The
recorder probes candidates in preference order with
`MediaRecorder.isTypeSupported` and uses the first accepted one. Nothing is
hardcoded.

The downloaded file's extension is derived from the MIME type the recorder
**actually produced**, not the one requested, because browsers are permitted to
substitute and the file must match its contents.

### Honesty

`status` reaches `'complete'` only after `MediaRecorder` has fired `stop` **and**
a non-empty blob has been assembled. `finalizing` is a real, visible state.
A recording that finishes with no data is reported as a failure, not a success.

A `1000ms` timeslice is used so chunks are flushed as they go — a crash
mid-recording does not lose everything, and memory does not grow unbounded in
one opaque buffer.

### Error handling

Structured, recoverable-flagged errors for: unsupported browser, no supported
format, canvas capture failure, recorder construction failure (with a bare-options
retry, since some builds accept a MIME type but reject bitrate hints), mid-recording
failure, empty finalization, and quota exhaustion.

If IndexedDB cannot store the blob, the entry is marked **"Not stored"**, kept in
memory, and the UI says plainly that it is downloadable now but will be lost on
reload. Nothing is silently dropped.

Recordings live **on your device only**. Nothing is ever uploaded.

Reloading or closing the page during a recording triggers a browser warning. The
browser will not let a file be finalized during `beforeunload`, so the honest
thing is to warn that the recording will be lost rather than pretend it can be
saved.

## WebRTC and signaling

### Architecture

```
PeerConnectionManager   owns RTCPeerConnection lifecycle; no UI, no store, no transport
ControlChannel          the director ↔ guest command path (RTCDataChannel)
SignalingAdapter        the transport seam (interface)
  ├─ ManualSignalingAdapter       out-of-band exchange, no infrastructure (default)
  └─ WebSocketSignalingAdapter    rooms + trickle ICE via the optional relay
invite-link             encodes an envelope into a shareable URL fragment
ICE configuration       STUN/TURN parsing, gathering, connectivity assessment
Remote media handler    binds incoming tracks to guest sources
Connection diagnostics  real getStats() output
```

Every transport that could ever be used — manual exchange, a WebSocket service,
a QR code, `BroadcastChannel` between tabs — implements one `SignalingAdapter`
interface. The studio UI and the peer manager know only about that type, plus
the capability flags it advertises:

| Flag | Meaning |
| --- | --- |
| `crossDevice` | Can reach a genuinely separate device |
| `requiresManualExchange` | A human has to carry the handshake |
| `supportsRooms` | Peers find each other by name |
| `supportsTrickleIce` | Candidates can be sent incrementally |

The UI reads these rather than checking which adapter is installed, which is
why switching transports changes the Guests panel from the copy-a-link flow to
a room status view instead of leaving dead controls on screen.

### The workflow

```
Director creates offer → ICE gathering completes → link generated
       ↓
Guest opens the link → offer applied automatically → answers → gets a link back
       ↓
Director applies the answer → ICE connectivity checks → connected
       ↓
Control channel opens → remote mute, cue and on-air tally become available
```

The data channel is created by the **offering** side, so its m-line is in the
offer and no second negotiation round is needed — which this signaling could not
perform without another link exchange.

### Vanilla ICE, and why

This applies to the **manual** transport only. Manual exchange has **no channel
for incremental (trickle) ICE candidates** — the user would have to copy a fresh
code every time one appeared. So LiveDeck waits for gathering to complete and
exports a single SDP with every candidate already embedded.

The server transport does not have this constraint: a live socket can carry
candidates as they are discovered, so `WebSocketSignalingAdapter` advertises
`supportsTrickleIce` and the peer manager sends each one immediately. Inbound
candidates that arrive before `setRemoteDescription` are buffered and flushed
after it, since applying one to a connection with no remote description throws.

The trade-offs of the vanilla path, which the UI states before you invest in it:

- Setup is slower — a second or two spent gathering.
- Gathering **times out after 5s** rather than hanging, because a
  configured-but-unreachable TURN server can keep `iceGatheringState` at
  `gathering` indefinitely. A partial candidate set is still worth trying, and
  the UI says the set may be incomplete.
- **A STUN-only configuration discovers no relay candidates.** Two peers behind
  symmetric NAT, or behind a firewall that blocks UDP, will gather candidates,
  exchange them, fail every connectivity check, and land in `failed`. That is a
  real network limitation, not a bug, and traversing it requires a TURN relay.
  The supported fix is [Cloudflare Realtime TURN](#cloudflare-realtime-turn),
  minted by the relay; a static server also works in **Settings → ICE servers**
  as `turn:host:port|username:password`. This one is **not** solved by signaling
  alone: media is peer-to-peer in both transports, so the same NAT limits apply.

After gathering, the candidate set is assessed and reported in plain language:
relay present → good; public (srflx) present → works on most home and office
networks, with the symmetric-NAT caveat spelled out; host-only → same network
only; none → will not connect.

### Cloudflare Realtime TURN

The supported way to get a relay. The signaling server mints **short-lived**
TURN credentials from Cloudflare and serves them to the studio; the studio puts
them in front of its STUN servers when it builds a peer connection.

**Setup.** Cloudflare dashboard → Realtime → TURN → create a key. Put the two
values in `server/.env`:

```bash
CLOUDFLARE_TURN_KEY_ID=<the "Turn Token ID">
CLOUDFLARE_TURN_API_TOKEN=<shown once, at creation>
# Optional. Seconds, default 86400, range 600–172800.
CLOUDFLARE_TURN_TTL_SECONDS=86400
```

Nothing to configure in the studio. The credential endpoint is **derived** from
the signaling relay address, because they are the same process — wherever
`/signal` is reachable, `/ice-servers` is too. `VITE_ICE_SERVERS_URL` overrides
that for the one deployment where credentials come from somewhere else.

Restart the relay and check the startup line, which states which mode TURN is
in. A typo in the key id is otherwise indistinguishable from no configuration
at all, and both look identical from the browser: no relay candidates.

```
[livedeck-signaling] TURN: Cloudflare key 2f9c1ab4…, ttl 86400s, served at GET /ice-servers
[livedeck-signaling] TURN: not configured (STUN only). Set CLOUDFLARE_TURN_KEY_ID and …
```

**Why the token lives on the server.** The Cloudflare API token can mint
credentials for your account indefinitely. A `VITE_*` variable is compiled into
the browser bundle, so putting it there publishes it to anyone who opens
devtools — your relay bandwidth, your bill. The token stays in the relay
process; the browser only ever receives a username/credential pair that expires
on its own. This is the one piece of LiveDeck that genuinely needs a server.

**What it costs in latency.** Credentials are fetched on the path that precedes
`new RTCPeerConnection`, because ICE servers are fixed at construction and
WebRTC offers no way to add one to a live connection. That is one HTTP request,
once: `turn-credentials.ts` caches the grant until five minutes before expiry,
and `turn.ts` caches it server-side until ten minutes before, so a twelve-guest
room is one call to Cloudflare rather than twelve. Simultaneous joins on a cold
cache share a single in-flight request on both sides.

**What happens when it breaks.** Every failure path degrades to STUN-only
rather than throwing, because a lost relay is a weaker connection while a thrown
error would abort handshakes that never needed one. The operator gets a toast
naming the cause — a 403 says to check the token specifically, since a rotated
token is the common case — and the toast is latched so a down relay raises it
once rather than once per guest per attempt. A relay with **no** TURN key
configured is silent: that is the project's default, not a fault, and
`describeIceFailure` already explains it at the point a connection actually
fails.

Credentials are passed to `buildPeerConfiguration` as structured
`IceServerConfig` objects rather than through the
`turn:host:port|username:password` settings syntax. That format splits the
credential pair on the first `:`, and a generated Cloudflare username or
base64 credential may contain one — routing a secret through it would truncate
it and produce a 401 that looks like a wrong token.

### Honest status reporting

A peer becomes `'connected'` **only** when `RTCPeerConnection.connectionState`
reports `connected`. Creating an offer, exchanging codes, or having a guest row
in the list never produces a connected status.

Guest identity and transport state are separate maps in `guestStore`. **A guest
existing in the list says nothing about whether a connection succeeded.**

- `disconnected` is reported as *reconnecting*, not failed — ICE often recovers.
- `failed` explains itself in terms of NAT and firewalls.
- A guest with no peer yet reports exactly that, and diagnostics renders every
  unavailable metric as an em dash instead of inventing RTT and bitrate numbers.

Connection codes are untrusted clipboard input and are validated structurally
before anything reaches `setRemoteDescription`: wrong version, truncated SDP
(the most common real mistake), missing peer id, and wrong direction ("that is
an answer code — paste the host's offer here instead") each get a specific,
actionable message.

Codes are base64 with an `LD1:` prefix so they survive chat clients and email,
which happily reflow raw multi-line SDP. Clipboard writes can fail; the copy
button reports failure honestly and a selectable textarea is always available
as a manual fallback.

The host sends its **program output** to guests — the composed canvas plus the
mixed audio — which is what makes this a production feed rather than a webcam
call. `replaceTrack` is used for source swaps so no renegotiation round is
needed, which manual signaling could not perform without another copy/paste.

### Sessions are not access control

A session ID is a short, human-shareable label for coordinating a production. It
**authenticates nothing and authorizes nothing** — there is no server to check it
against. Knowing an ID grants no access to anybody's media; media only ever flows
over a peer connection both sides explicitly completed. The UI says this wherever
an ID appears.

## Signaling transports

Two transports ship. The choice is in **Settings → Signaling**, and it changes
only *how the two sides find each other* — media is peer-to-peer either way, and
no server ever sees a frame of video.

| | Signaling server (default) | Manual |
| --- | --- | --- |
| Infrastructure | A Node process you run | None |
| Guest joins by | Opening the room link and clicking Join | Opening a link that carries the offer |
| The link | One, reusable, short | One per guest, a few kilobytes |
| Answer comes back | Automatically | By hand |
| ICE | Trickle — candidates stream | Vanilla — gathers fully first |
| Time to connect | Typically under a second | A second or two of gathering, plus the human round-trip |
| Works on static hosting | No — needs the relay reachable | Yes |

**Manual remains fully supported**, and is one setting away in
Settings › Signaling. The original constraint of this project was to need no
backend, and that path is unchanged: nothing is transmitted to anybody, because
the offer rides in the URL fragment, which browsers never send to a server.

The default changed because the manual flow has one genuinely awkward step that
no amount of frontend cleverness removes — see below.

### Why a server at all

The manual flow has one genuinely awkward step: the guest's answer has to travel
back to the director by hand (see limitation 2 below). No amount of frontend
cleverness removes it — returning an answer requires something both parties can
reach. The relay is that something, and nothing more.

### What the relay does and does not do

It does:

- Keep a map of room name → connected peers, in memory only.
- Forward `offer`, `answer` and `candidate` messages between peers **in the same
  room**, inferring the sender from the connection rather than trusting a claim
  in the message.
- Announce arrivals and departures so the director knows who to offer to.
- Rate-limit each peer, cap peers per room and rooms per server, and drop
  sockets that stop answering heartbeats.

It does not:

- Touch media. Audio and video never pass through it.
- Persist anything. There is no database; restarting it empties every room.
- Authenticate anyone. **A room name is not a password** — see below.

### Running it

```bash
cd server
npm install
npm run dev          # http://localhost:3001, relay on ws://localhost:3001/signal
```

That is all — the studio already points there. The address field is **blank by
default and resolved**, not hardcoded:

1. `VITE_SIGNALING_URL`, if set at build time.
2. `ws://<hostname>:3001` when the page URL carries a port, i.e. development.
3. The page's own origin otherwise, for a deployment behind a proxy that also
   fronts `/signal`.

Override it in **Settings → Signaling** for a relay hosted anywhere else.
`/healthz` reports room counts and is the reliable way to confirm the relay —
rather than some other process — is what is answering that port.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind (not `HOSTNAME` — Windows pre-sets that to the machine name) |
| `ALLOWED_ORIGINS` | *unset* | Comma-separated origins allowed to connect |

`ALLOWED_ORIGINS` is **unset by default and the server warns about it on
startup**, because an unset allow-list accepts connections from any page on the
internet. That is convenient on a laptop and wrong anywhere else.

The wire protocol lives in [`shared/signaling-protocol.ts`](shared/signaling-protocol.ts),
imported by both the browser client and the server so the two cannot drift. Both
sides validate every message; the server is untrusted input to the client just as
much as the reverse.

### It will not run on Vercel's serverless runtime

This is worth stating plainly because the stack suggests otherwise. A WebSocket
relay needs a long-lived process holding connections in memory. Serverless
functions are short-lived and individually isolated, and a Next.js route handler
cannot access the HTTP server's `upgrade` event at all — which is why
[`server/src/server.ts`](server/src/server.ts) starts Next *programmatically*
inside a plain Node `http` server that owns that event itself.

So it needs somewhere that runs a persistent process: a VPS, a container,
Fly.io, Railway, Render, a Node host. The static studio can still be deployed
anywhere; only the relay has this requirement.

Scaling past one process would need shared room state (Redis, say) and sticky
sessions. That is out of scope here, and the in-memory limits are small enough
to be honest about: 12 peers per room, 500 rooms.

### A room name is not a password

Restating what [Rooms and roles](#a-room-name-is-not-access-control) says,
because with a relay in play it has more teeth: anyone who can reach it and
guesses a room name **will** join that room and be offered a connection.

Treat the room name as a rendezvous label, not a credential. **New code** on the
landing page generates one in the `abc-defg-hij` shape meeting tools use —
roughly 47 bits, which makes it impractical to guess, but that is obscurity, not
access control. If it matters, run the relay on a network you control and set
`ALLOWED_ORIGINS`. The UI states this wherever a room name is shown.

### Deploying the relay with Docker

[`server/Dockerfile`](server/Dockerfile) builds it, and
[`render.yaml`](render.yaml) is a Render blueprint for it.

**The build context is the repository root, not `server/`.** This is the one
thing that is easy to get wrong: `server/src/signaling.ts` imports
`../../shared/signaling-protocol`, because the wire protocol is compiled into
both the browser client and the server so the two cannot drift. A context of
`server/` cannot see half of its own source.

```bash
# from the repository root
docker build -f server/Dockerfile -t livedeck-signaling .
docker run --rm -p 3001:3001 -e ALLOWED_ORIGINS=http://localhost:5173 \
  livedeck-signaling
```

On Render, as a **Docker** web service — or just apply the blueprint:

| Setting | Value |
| --- | --- |
| **Root Directory** | **blank** |
| Dockerfile Path | `./server/Dockerfile` |
| Docker Build Context Directory | `.` |
| Health Check Path | `/healthz` |
| `ALLOWED_ORIGINS` | wherever the studio is served from |
| Instances | 1 — see below |

**Leave Root Directory empty.** It re-roots every other path, so setting it to
`server` — the intuitive thing to do for a service that lives in `server/` —
makes the two paths below it resolve inside `server/server/`, and puts `shared/`
outside the context altogether. The build then fails on three `COPY` steps with
`"/shared": not found`, and the context loads as `2B` because BuildKit only
fetches paths a `COPY` actually references. The blueprint avoids this by not
setting `rootDir` at all.

Then point the studio at it: **Settings → Signaling → Server address**,
`wss://your-service.onrender.com`. Or set `VITE_SIGNALING_URL` at build time so
every device gets it without being configured.

A few decisions the image encodes:

- **`PORT` is honoured, not pinned.** Render injects its own port and the
  server reads whatever it is given; the image only sets a default so a bare
  `docker run` works. `HOST` defaults to `0.0.0.0`, because a container's
  loopback is not reachable from Render's router.
- **`/healthz` is the health check, not `/`.** It is the relay's own endpoint,
  registered ahead of Next, and it reports room and peer counts — so a pass
  means the *relay* is up rather than that something is answering the port.
  That distinction is not academic: a different process holding the port fails
  in the most confusing way available, with the WebSocket connecting at the TCP
  level and then never upgrading.
- **It runs as the unprivileged `node` user**, and the container is PID 1 so it
  receives `SIGTERM` directly — the server closes sockets on it and gives up
  after 5s rather than being killed by the host.
- **One instance.** Room state lives in one process's memory, so a second
  instance would split rooms across them: two guests given the same room name
  could land on different instances and never find each other. Scaling out
  needs shared state and sticky sessions first.
- **Platform-wrong native binaries are pruned.** The lockfile lists every
  platform variant of Next's SWC binding and of sharp's libvips as optional
  dependencies, and npm installs each one that *could* match — so a glibc base
  image ships a musl build of each alongside, 174MB that can never load. The
  glibc SWC binary is deliberately kept: `next.config.ts` is TypeScript and
  Next transpiles it with SWC at startup, so it is a runtime dependency.

Verified by running the real browser suite against the container: Scenario E
passes with the studio pointed at the containerized relay rather than a local
`npm run dev`.

## Persistence

| What | Where | Why |
| --- | --- | --- |
| Session index, per-session documents (sources, scenes, guests, mixer config) | localStorage | Small, serializable |
| Studio preferences | localStorage | Operator-level, not per-production |
| Recording blobs + metadata | IndexedDB | A short 1080p recording is tens of MB; localStorage is string-only and caps at a few MB |

**Only serializable configuration is persisted.** `MediaStream`s, DOM nodes,
`AudioNode`s and `RTCPeerConnection`s are never written — they cannot be, and
they would be meaningless after a reload. On save, `streamKey` is nulled and
peer bindings cleared; capture is re-acquired after a reload, with a fresh
permission prompt if the browser requires one.

Documents are keyed by session id, so reopening a session restores *that*
production rather than whatever was edited last. Autosave is debounced at 600ms
— a drag gesture produces a transform update per frame, and serializing each one
would be wasteful — and flushes on teardown and `pagehide`.

A corrupt or partially-written document is normalized defensively rather than
being allowed to crash the studio on open. When localStorage is unavailable
(Safari private mode), an in-memory adapter keeps the app working; it just will
not remember anything.

## Performance decisions

- **The render loop is outside React.** The compositor's snapshot callback reads
  store state with `getState()`, not a subscription. A camera moving on the
  canvas costs **zero** React renders at up to 60fps.
- **Frames are skipped** when nothing is animating and no live media is present.
- **Audio meters bypass React** entirely via the meter bus, writing CSS
  transforms directly. `transform` rather than `width`, so no layout is forced
  20 times a second per channel.
- **Drag gestures are coalesced** to one transform update per animation frame.
- **Preview frame rate is capped independently** of the recording rate, and the
  compositor switches to the full rate while recording so the file is never
  silently degraded.
- **Pointer capture** on `window` keeps gestures alive past the canvas edge and
  guarantees the up handler fires, so a drag can never get stuck on.
- **Lazy loading is per role.** Each role view is its own chunk, so a guest
  opening an invite link downloads ~4kB gzipped — not the mixer, recorder or
  scene editor, none of which their page can use. Diagnostics and every dialog
  split out again on first use.
- **Decoded assets are cached** per source rather than re-decoded per frame.
- **Device switches use `applyConstraints`** on the live track first, falling
  back to a full re-acquire only if the browser rejects it — avoiding a visible
  drop-out.
- `alpha: false` and `desynchronized` on the canvas context, skipping per-pixel
  blending with the page.

### Quality settings are honest

Output resolution and frame rate change the real pipeline. The settings dialog
also inspects live track settings and warns when the request exceeds what the
sources can sustain — "the highest-resolution live source is 720p, below the
1080p output; the recording will be upscaled rather than genuinely sharper", and
similarly for frame rate. The studio does not promise quality it cannot deliver.

## Accessibility

- Real semantic controls throughout: the scene strip is a `tablist` with
  arrow-key navigation, the source list is a `listbox`, every slider and toggle
  is a labelled form element.
- **Every geometric operation has a numeric equivalent.** Position, size,
  rotation, crop, layer order, lock and visibility are all labelled form
  controls in the properties panel. **Drag-and-drop is never the only way to
  configure a source** — this is covered by tests.
- Dialogs are `role="dialog"` + `aria-modal` with a trapped tab cycle, focus
  moved in on open and restored on close, and Escape to dismiss.
- Keyboard shortcuts are suspended inside text fields, textareas, selects and
  `contenteditable`, so Delete cannot destroy a source while you are renaming
  it. Only the specific documented combinations are prevented from reaching the
  browser.
- **Status is never communicated by colour alone**: every state carries a
  distinct icon shape and a text label.
- Live regions announce recording state and toasts (assertive for errors,
  polite otherwise).
- Focus rings are deliberately prominent, using `:focus-visible`.
- Reduced motion follows the OS preference by default and can be forced either
  way. It affects interface animation only — production transitions are a
  separate, explicit setting.
- Row actions are always in the DOM rather than hidden behind hover, so they are
  reachable by keyboard and touch.

## Testing strategy

469 unit and integration tests (Vitest + React Testing Library) plus 46
Playwright browser tests across eight scenarios.

```bash
npm test                 # unit + integration
npm run test:coverage    # with coverage
npm run e2e:install      # once — downloads Chromium
npm run e2e              # browser scenarios
```

The browser suite starts both the studio and the relay. If port 3001 is already
taken by something else, point both at a free one:

```bash
LIVEDECK_RELAY_PORT=3100 npm run e2e
```

### What is tested where, and why

**Pure logic** (no mocks needed): geometry and transform normalization, crop
resolution, snapping, gesture math for drag/resize/rotate/crop including rotated
and aspect-locked cases, audio math (RMS, dB, meter curves, gain resolution),
composition model resolution and layer ordering, transition progress, canvas
size derivation, format negotiation, signaling payload validation, ICE
connectivity assessment, invite-link encode/decode round trips, URL parameter
parsing, and control-message validation.

**Stores**: scene creation/deletion/duplication/switching, item ordering and
dense relayering, hydration including stale references, source lifecycle.

**Services with scripted doubles**: the stream registry's reference-counting
invariant (including the "delete the duplicate, original keeps running" case),
recorder state transitions, peer connection state reporting, and the control
channel — that a command is only *claimed* delivered when the channel is open,
that hostile payloads are dropped, and that the heartbeat never outlives the
channel.

**Integration through hooks**: source lifecycle with real store wiring — stream
release on delete, shared captures on duplicate, scene and mixer cleanup — and
solo's reversibility, including that an already-hidden item is not revealed on
exit.

**Components**: scene switching changes `activeSceneId` (the value the
compositor reads) rather than only highlighting a card; the properties panel's
numeric path writes through to the real transform; locking genuinely protects an
item.

### An explicit caveat

> **The unit tests use structural stubs for media APIs that jsdom does not
> implement. Passing them is not evidence of real-world media or connectivity
> behaviour.** A scripted `MediaRecorder` proves the state machine, not that a
> browser produces a playable file. A scripted `RTCPeerConnection` proves the
> handshake logic, not NAT traversal.

That is what the Playwright suite is for. It runs Chromium with
`--use-fake-device-for-media-stream`, which supplies a synthetic camera and
microphone that produce **actual frames and samples**, so the pipeline under test
is the production one. The browser tests assert on real pipeline state — canvas
backing-store dimensions, sampled canvas pixels, track `readyState`, registered
stream counts, compositor frame counts — not just on rendered labels.

The eight scenarios: **A** local studio (devices → sources → scene → arrange →
switch → record → preview → download, including that the blob is decodable by
the browser's own player and the filename extension matches the real MIME type);
**B** source composition (camera over screen share, transforms, layer order,
hide, record across a scene switch); **C** resource cleanup (delete releases the
stream, duplicate-then-delete keeps the original alive, recording releases its
capture, leaving a room stops every track, repeated start/stop cycles do not
accumulate streams, config survives a reload but capture does not); **D** invite
links and peers (Manual mode); **E** room joining (the default), including the
participant lifecycle — leaving removes a guest, and rejoining or reloading does
not duplicate them; **F** the scene window, which asserts that the mirrored
program really decodes *moving* frames rather than showing a single stuck
image; **G** device pickers, the speaking indicator, and solo sharing —
including that a copied solo link really decodes the feed it names in a
*different* window; **H** the guest-to-guest mesh — two guests sent nothing but
a room link decode each other's video with no control room involved, a third
joining an existing pair sees both, two guests share the width evenly, a
director in the room stays invisible to guests, joining switches nothing on, a
camera turned on *after* the handshake still reaches the other side, and a
screen share replaces the sharer's camera and gets its own region.

Scenario D is worth describing in full, because it exercises the parts that are
easiest to fake. It asserts that the generated link's **fragment really contains
gathered ICE candidates** (decoding and inflating it in the browser to check),
that a wrong-direction or malformed paste is named specifically, and then runs a
complete handshake across two browser contexts: the guest *opens the link*,
`?label=` is applied, the offer is consumed and the fragment cleared, an answer
link appears unprompted, and both sides reach a genuine `connected` state. It
then proves the control channel end-to-end — the director mutes the guest's
microphone and the assertion is that the **guest's own window** flips to
"Unmute", which can only happen if the command crossed the data channel and
disabled their track. A cue is checked the same way. Finally it verifies the
scene route contains **no banner, no buttons and no tablist**, and that
`?ratio=9:16&quality=1080` really resizes the canvas to 1080×1920.

Scenario E is the default path, and runs against the real relay — Playwright
starts `server/` alongside the dev server. A guest context is given nothing but
`/push/<room>`: it asserts the join control is present and the director's list
is *empty* until the guest clicks it, that the name the guest typed is what
appears in the control room, that both sides reach a genuine `connected` state,
that no manual-exchange controls exist on either side, and that the control
channel still crosses to the guest's own tracks. The transport is seeded through
the persisted setting rather than clicked through Settings, because switching it
mid-test would tear down and rebuild the adapter.

Even so, a limit worth stating: both contexts run on one machine, so host
candidates always match and the connection always succeeds. It verifies the
workflow and the state machine, **not** NAT traversal. Cross-network
connectivity cannot be proven from a test runner on a single host and needs
manual two-device testing.

## Known limitations

Collected honestly in one place.

1. **Without a TURN relay, some peer connections will fail.** Symmetric NAT or
   UDP-blocking firewalls need one. **This is the most common cause of
   "connection failed", and signaling alone does not fix it** — media is
   peer-to-peer in both transports, so the same NAT limits apply either way.
   The fix is [Cloudflare Realtime TURN](#cloudflare-realtime-turn): two
   variables in `server/.env` and the relay mints credentials per connection.
   A static server also works, under Settings › ICE servers as
   `turn:host:port|username:password` or baked in via `VITE_TURN_URLS` — but
   those credentials ship in the browser bundle, so use them only for a relay
   you do not mind strangers using. Either way the studio reports `failed` and
   says which of the three cases it was (relay present and still failed, public
   address only, or host candidates only), rather than faking a connected state.
2. **In Manual mode, an invite link gets you most of the way, not all of it.**
   The link carries the offer, so the guest needs no setup — but their answer
   still has to come back by hand, because no server can carry it. This is why
   the relay is the default; it is also why Manual still exists, for installs
   that cannot run one. See [Signaling transports](#signaling-transports).
3. **Screen capture targets are chosen by the browser, not the app.** Which
   screens, windows and tabs you may pick is entirely the browser's native
   picker. The app cannot enumerate or pre-select a target, and can only read
   what was picked when the browser reports `displaySurface` (Chrome does;
   others do not).
4. **Room size is capped by the mesh.** Every participant sends its camera to
   every other one, so encode cost and uplink grow with the square of the room.
   The relay refuses a 13th peer, but the practical ceiling is lower and
   depends on the weakest machine in the room — a handful of guests, not a
   dozen. Going further needs a server-side mixer (an SFU), which is a
   different architecture and not what this is.
5. **Display audio is not guaranteed.** `audio: true` is a request. Whether a
   track arrives depends on the OS, browser and chosen surface — Chrome on
   Windows can share tab and system audio, macOS generally cannot share a whole
   screen's audio, Firefox and Safari largely do not offer it. The app inspects
   the actual tracks and explains when none arrived.
6. **A recording in progress is lost if the page is closed.** The browser will
   not allow finalization during `beforeunload`.
7. **Output quality cannot exceed the sources.** 1080p60 from a 720p30 camera
   upscales and repeats frames; the settings dialog says so.
8. **Pausing a recording is unavailable** where `MediaRecorder.pause` is
   missing. The control is disabled with an explanation.
9. **Large recordings may exceed the storage quota.** They stay downloadable for
   the session and are marked "Not stored".
10. **Precise drag editing is impractical on small screens.** The mobile layout
   keeps the preview and recording status visible and points to the numeric
   controls, rather than pretending touch dragging on a 360px-wide canvas is
   equivalent.
11. **Local image and video files are capped at 40MB** and held in memory for
    the session, since they are read as data URLs.
12. **Invite links are long** — a few kilobytes even compressed, because they
    contain a full SDP. They paste fine into chat and email, but they are not
    pretty, and some SMS clients will break them across lines.
13. **A scene window mirrors the control room, so it depends on it.** The
    program is sent to it over a loopback peer connection, because a
    `MediaStream` cannot cross a browsing context — so closing the control room
    stops the mirror, and the scene window says so rather than freezing on the
    last frame. With no control room open it falls back to its own compositor,
    which can draw the saved scene layout but none of the live sources. It is
    not an independent process.
14. **Remote control needs an open data channel.** Before a peer connects only
    the local controls apply — the UI disables the remote ones rather than
    pretending.
15. **The signaling server is not serverless-deployable.** It holds WebSocket
    connections and room state in one process's memory, so it needs a
    persistent host — not Vercel functions — and it does not scale past a single
    instance without shared state. Limits are 12 peers per room and 500 rooms.
16. **A room name is not access control, in either transport.** With the relay
    running, anyone who can reach it and guesses the name joins the room. There
    is no authentication anywhere in this project, and adding real accounts
    would mean a backend that owns identity.
17. **Room joining requires the relay to be running.** It is the default
    transport, so a fresh install with nothing on port 3001 reports "Could not
    reach the signaling server" and no guest can join until it is up or
    Signaling is switched to Manual. The studio cannot fall back silently:
    quietly demoting rooms to the copy-a-link flow is how "guests just don't
    appear" happens.

## Guided demonstration

Reproduces the full production workflow in about three minutes.

1. Open the app, type the room name "demo", and click **Open director**.
2. In the **Sources** tab, **start camera**. The preview appears in the program
   canvas; the status reads *Active* only once a live track exists.
3. **Start microphone**. A mixer channel appears with a live meter — speak and
   watch it move.
4. **Add a source → Background** and pick a colour. It fills the frame.
5. Select **Camera**, then either drag it on the canvas or set `Width 320`,
   `X 920`, `Y 500` numerically — a picture-in-picture in the lower right.
   Drag to confirm snap guides latch to the edges and centre.
6. Click **New scene** — it becomes the live scene immediately, since you
   create a scene in order to build it. Rename it "Split", arrange the camera
   and the background side-by-side, and set its transition to
   **Crossfade, 400ms**.

   A screen share would arrive here as a *guest's* feed: the control room has
   no screen capture of its own. See [Who can share a screen](#who-can-share-a-screen).
7. **Switch between the scenes.** Watch the program canvas actually dissolve —
   the output changes, not just the highlighted card.
8. In **Mix & record**, pull the host mic fader down. Each live audio source
   has its own channel with a pre-fader meter.
9. **Start recording**. The ON AIR tally lights and the timer runs.
10. **Switch scenes while recording**, move the camera, hide a source, adjust a
    fader.
11. **Stop & save**. Watch it pass through *Writing the file* before reporting
    *Saved to the library*.
12. Open the **recording library**, **Preview** the result, and confirm the
    scene switches, the transforms, the hidden source and the fader moves are
    all in the file. Then **Download** it.
13. Open **Diagnostics** to see real compositor frame rate, live track states
    and stream reference counts.

### The room workflow

15. With the relay running, open the **Guests** tab and click
    **Copy room link**. One link, reusable, no fields to fill in.
16. Open it in a second browser profile, or on another device on the same
    network. Type a name and click **Join room**.
17. The guest appears in the control room under the name *they* chose, and both
    sides report *Connected* from their real `connectionState`. Nothing was
    pasted anywhere.
18. Click **Leave room** on the guest to drop the connection and return to the
    join screen.
19. From the guest's tile, click **Mic** under "Remote". Watch the *guest's own*
    window flip to "Unmute" — the command crossed the data channel and disabled
    their track, it did not just change your mix.
20. Type a message in **Cue all** and send it. It appears as an alert on the
    guest's page.
21. Open the **Scene output link** from the Scenes tab in a new window — a clean
    program feed with no interface, ready to capture in OBS.

## Troubleshooting

**"Camera permission was denied"** — Allow it for the site in the address-bar
controls, then click Retry. A site-level block cannot be overridden by the page.

**"The device is in use by another application"** — Close other apps holding the
camera. On Windows, check the privacy indicator in the taskbar.

**Camera status is Idle after a reload** — Expected. Streams cannot be
persisted, so capture is re-acquired explicitly. Scenes and layouts came back.

**No display audio when sharing** — Platform-dependent; see limitation 5. Try
sharing a **browser tab** rather than a whole screen, which is the surface most
likely to offer audio.

**Recording has no audio** — The audio engine needs a user gesture. Start the
microphone or click *Enable audio engine*, then record again. Also check that
the channel is not muted in the mixer.

**Recording unavailable** — No format supported by both the browser and
`MediaRecorder`. Diagnostics lists what was probed.

**"Not stored" on a recording** — The storage quota was exceeded. Download it
now; it will be lost on reload. Delete older recordings to free space.

**Peer connection reaches `failed`** — Both sides gathered candidates but could
not reach each other. The error says which case it is, because the fix differs:
*public address found but unreachable* is symmetric NAT or a UDP-blocking
firewall and needs a **TURN server**; *only local-network candidates* means STUN
itself never answered; *a relay was present and it still failed* points at the
TURN server's own credentials or reachability. Set
`CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` in `server/.env` — see
[Cloudflare Realtime TURN](#cloudflare-realtime-turn) — or add a static server
under Settings › ICE servers as `turn:host:port|username:password`. **Switching
to the signaling server does not fix this** — media is peer-to-peer either way.
See limitation 1.

**TURN is configured but no relay candidate appears** — Check in this order.
The relay's startup line states whether it read the Cloudflare key at all; if
it says *not configured*, the variables are not in that process's environment
(`server/.env` is not auto-loaded — set them in the shell or your host's
config). If it says configured, open `GET /ice-servers` on the relay directly:
`{"configured":false}` means the same thing, a 502 carries the Cloudflare error
verbatim, and a 200 with URLs means the relay is fine and the studio could not
reach it — usually `ALLOWED_ORIGINS` missing the studio's origin, which
withholds the CORS header and makes the fetch fail in the browser only. The
studio toasts the cause either way; a 403 from Cloudflare specifically means the
API token is wrong or rotated.

**"Could not reach the signaling server", but the relay is up** — Most likely
`ALLOWED_ORIGINS` does not contain the studio's origin, and the socket is being
refused with a 403. You cannot see that from the browser: it hides the HTTP
status of a failed WebSocket handshake, so the console says only *"WebSocket
connection failed"*. Check the relay's startup log, which prints the effective
allow-list, and compare it with the studio's origin exactly — `scheme://host`,
no trailing slash, and `https` not `http` if the studio is served over TLS. A
`curl` probe is not a valid test here: a client that sends no `Origin` header at
all is allowed through by design, so curl passes while every browser is
refused.

**"Could not reach the signaling server"** — The relay is not running, or
something else is on its port. Start it with `npm --prefix server run dev` and
check `http://localhost:3001/healthz` returns JSON. If that returns an HTML page
instead, a *different* process owns the port — which fails in the most
confusing way available, because the WebSocket connects at the TCP level and
then never upgrades, leaving the studio in *Connecting…* indefinitely. Either
free the port or set `VITE_SIGNALING_URL` and the relay's `PORT` to a free one.

**Guests open the room link but never appear** — Check the Guests panel reports
*Connected to the signaling server* first; that is a separate fact from any
guest having connected. Then confirm the guest actually clicked **Join room** —
opening the link alone announces nothing, by design. Both sides must also be on
the same relay and the same room name.

**The relay serves an unrelated page, or refuses to start** — `server/.next` is
a build cache; a stale one from another project produces both. Delete it and
restart. Next's dev server also holds a lock allowing only one instance per
directory, so kill any existing one before starting a second.

**"The link may have been truncated"** — Only part of the link was copied.
Invite links are long; use the Copy button, or select the whole textarea.

**Remote mute does nothing** — The control channel is not open. The buttons are
disabled when that is the case; if they are enabled and the command still fails,
a toast says so.

**The scene window is black** — Open the director view for the same room in
another window. The scene window is a *mirror*: live sources (camera, screen
share, guests) exist only in the control room's tab and are sent to it, so with
no control room open there is nothing to show and the hint says so. If the
control room *is* open, check that its own program canvas is not empty.

**Meters are flat but the device is Active** — The AudioContext is suspended.
Click anywhere in the studio, or use *Enable audio engine*.

**Preview looks choppy** — Lower the preview frame rate cap in Settings. The
recording rate is unaffected. Diagnostics shows the measured compositor rate.

## Project structure

```
src/
├── app/                  routes and role pages (landing, director, push, scene, solo)
├── components/
│   ├── layout/           room bar, director control room
│   ├── studio/           program canvas, editor overlay, settings, palette, URL help
│   ├── sources/          source list, capture controls, properties, add-source
│   ├── scenes/           scene strip
│   ├── guests/           guest tiles, invite-link panel
│   ├── audio/            mixer, level meters
│   ├── recording/        transport controls, library
│   ├── diagnostics/      diagnostics panel
│   └── shared/           button, panel, fields, dialog, status, toast
├── hooks/                one responsibility each; the only React↔service bridge
├── services/
│   ├── media/            stream registry (ownership), device + capture services
│   ├── composition/      compositor, composition model, interaction controller,
│   │                     frame providers, asset cache, program link (the
│   │                     scene-window mirror)
│   ├── audio/            mixer graph, meter bus
│   ├── recording/        recording engine, MIME negotiation
│   ├── webrtc/           peer manager, control channel, ICE, getStats
│   ├── signaling/        adapter interface, manual + websocket adapters,
│   │                     invite links, URL parameters, validation
│   ├── sources/          source factory, default placement, stream keys
│   └── persistence/      localStorage, IndexedDB, documents, object URLs
├── stores/               zustand stores, one per domain
├── types/                domain types
├── utils/                geometry, snapping, audio math, formatting, errors, ids
├── lib/                  capability detection, class-name helper
└── test/                 browser API stubs for the unit suite
e2e/                      Playwright scenarios A–H
shared/                   the signaling wire protocol — the only code compiled by
                          both the browser client and the server
server/                   signaling relay (Next.js + ws). Required for guests to
                          join by room link; everything else runs without it
├── Dockerfile            container image; build context is the repo root
└── src/
    ├── rooms.ts          room registry, limits, rate limiting (all the logic)
    ├── signaling.ts      WebSocket plumbing, heartbeat, origin checks
    └── server.ts         Node http server that owns `upgrade`, with Next inside
render.yaml               Render blueprint for the relay
```

---

## Final note

The central workflow is: **open a room → send a link → compose scenes → mix
audio → switch layouts → record the finished production → preview and
download.** The media pipeline was built first; the interface was built around
it.

Where a browser cannot do something, this project says so rather than faking it.
