# LiveDeck Studio

A video production studio that runs in the browser. Bring in camera, screen
share and remote guests, compose them into scenes, mix the audio, switch layouts
live, and record the finished program — with no installation and no accounts.

The joining workflow follows a **meeting tool**: you open a control room, copy
one room link, and send it. Whoever opens it sets a name, clicks **Join room**,
and appears in your control room — nothing to paste back.

Participants' audio and video go through a **media server** (an SFU built on
[mediasoup](https://mediasoup.org)) that ships in [`server/`](server/). Each
participant sends its camera once and receives everyone else from the server,
which is what lets a room hold a dozen people. The server also decides who may
control whom. Everything *except* joining a room — capture, scenes, mixing,
recording — works with no server at all. See [The media server](#the-media-server).

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
              Local recording (IndexedDB, chunked)
```

```
Guest A ─┐                       ┌─ Guest A hears B + C, never A
Guest B ─┼──▶  media server  ───┼─ Guest B hears A + C
Guest C ─┘   (mediasoup SFU)     └─ Director receives A, B, C
                   │
          authorizes every control command
```

---

## Contents

- [Quick start](#quick-start)
- [Scripts](#scripts)
- [Browser requirements](#browser-requirements)
- [Rooms and roles](#rooms-and-roles)
- [Solo links share one feed](#solo-links-share-one-feed)
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
- [The media server](#the-media-server)
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
npm --prefix server run dev            # media server -> http://localhost:3001
```

Name a room (or click **New code**) and click **Open director**. Start your
camera from the Sources tab, then copy the room link from the Guests tab and
send it. Your guest opens it, types a name, clicks **Join room**, and appears in
your control room.

Without the media server running, the Guests panel says so plainly. Nothing
else depends on it: capture, scenes, the mixer and the recorder all work alone.

Media capture requires a **secure context**. `localhost` counts as one, so plain
HTTP works in development. Deploying over `http://` to any other host will stop
`getUserMedia` from working at all — the app detects this and says so rather
than blaming permissions.

There are no API keys and no accounts. Environment variables are all optional
on a laptop — see [`.env.example`](.env.example) for the studio (server
address) and [`server/.env.example`](server/.env.example) for the server
(ports, allowed origins, room-key secret, announced address, TURN).

**Media goes through the server and is never stored there.** The SFU forwards
RTP between participants; it does not decode, mix or record anything.

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
| `/director/:room` | Director | The control room: guest tiles, scenes, mixer, recorder, room links |
| `/push/:room` | Guest | A sender — camera, microphone, screen — and a view of the other guests |
| `/scene/:room` | Scene output | The composed program with zero chrome, at the logical canvas size |
| `/solo/:room/:sourceId` | Solo | One feed, uncomposed, for a downstream tool to lay out itself |

Navigating to a room creates it; there is no separate "new project" step.

### Joining a room

A room name **is** enough to connect: the guest opens `/push/:room`, sets a
display name, and clicks **Join room**. The server introduces them to everyone
in the room; there is no offer to carry and nothing to paste back.

Joining is a deliberate click rather than something that happens on page load,
for one reason: a guest's camera and microphone should not enter someone else's
production because they opened a URL. The click is also the user gesture
browsers require before an `AudioContext` will run.

### Roles are decided by the server

Four roles exist, and the server assigns one at join from the **room key** the
client presents — never from anything the client claims about itself:

| Role | Gets it by | May |
| --- | --- | --- |
| director | opening an empty room first, or the director key | everything: publish the program, control, cue, rename, kick, read the keys |
| producer | the producer key (`/push/:room?key=…`) | mute, cue and rename guests; never on-air, never kick, never touch the director |
| guest | nothing — the default | publish own media, mute itself, see and hear the others |
| viewer | asking for it | receive only |

The first control room to open an **empty** room claims it and stores the
director key in that browser, so a reload keeps the role. Once a room has
people in it, only the key grants director. The Guests tab offers a guest link
and a producer link; treat the producer link like a password.

A request to control another participant names only the target. The sender is
whoever owns the socket, and the server checks that sender's role against the
capability table in [`shared/authorization.ts`](shared/authorization.ts)
before forwarding. A guest's browser has no button to mute another guest, and
a browser that sends the command anyway gets `forbidden`.

### A room name is not access control

A room name authenticates nothing: anyone who can reach the server and guesses
the name joins **as a guest**. That is deliberate — guests should not need
accounts. What a guest can *do* is bounded by the role table above, and the
keys are what gate the roles. If guessing matters, set `ALLOWED_ORIGINS` and
run the server where only your studio can reach it.

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

A guest shares from the guest view, and the screen goes out **alongside**
their camera as its own producer (with its audio as a second one, when the
browser provided a track). Receivers get both: the camera stays in the grid,
the screen takes the featured region, and the control room gets a separate
*screen* source it can place independently of the face.

Every producer carries its *source* (`camera`, `screen`, `screen-audio`…) in
the signaling, so nobody has to guess what a video track is of, and a
participant joining mid-share receives the screen like any other producer.

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

Every guest publishes once to the media server and receives the others from
it, so a room of twelve costs each laptop one encode and one upload. See
[The media server](#the-media-server).

### The director is not in the room

A control room **receives every guest and sends nothing back**. It has no tile
in the call, no feed, and no presence in the layout — guests see guests. It
used to send its composed program to each of them, which encoded the canvas
once per guest for a feed nobody needed and put a black rectangle (an empty
program is a black canvas) in the middle of a call the director is not part of.

The control room still has a session with the media server, because that is
how the guests' media reaches it and how its commands — remote mute, cue,
on-air tally — reach them, authorized on the way.

A participant is somebody the **server's roster** announced, with the label
and role the server holds for them. Media arrives tagged with the producer's
participant id, so a stream can never appear as a person the room did not
announce.

### Nothing starts by itself

Joining does not switch on a camera or a microphone. The lobby has a toggle for
each, and whatever state they are in is what joins — arriving in a room already
broadcasting is the one decision a conferencing tool must never make for
somebody. The `AudioContext` is still prepared on the join click, because
browsers will not start one without a gesture, but preparing a mixer captures
nothing.

Turning either on later simply publishes a new producer; a device switch
replaces the track on the existing one. Nothing is renegotiated with other
participants, because nobody is connected to them — only to the server.

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

Real media over WebRTC, through the media server. Guests join by room link.
See [The media server](#the-media-server) for how it works and what it needs.

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

## The media server

```
Browser                                   server/
  MediaSession ── WebSocket /signal ──▶  signaling handlers ── RoomManager
   ├ send transport  ──── RTP ─────────▶  mediasoup Router (one per room)
   │   mic / camera / screen producers      ├ WebRtcTransport per participant & direction
   └ recv transport  ◀─── RTP ──────────    ├ Producer per published track
       one consumer per remote producer     └ Consumer per (participant, producer)
```

### Why an SFU

In a mesh every participant encodes its camera once *per peer* and uploads all
of them, so a twelve-person room is twelve encodes and eleven uploads on every
laptop. With a Selective Forwarding Unit each participant encodes once, sends
once, and the server forwards; the cost moves to a machine built for it. The
server never decodes: it forwards RTP packets, picks simulcast layers per
receiver, and that is all.

### The protocol

One WebSocket per participant carries requests (answered by id) and
notifications. Every message is a Zod schema in
[`shared/protocol.ts`](shared/protocol.ts), compiled into both halves and
validated on both ends: the server does not trust browsers, and the browser
does not trust the server.

```
join, getRouterRtpCapabilities, createWebRtcTransport, connectWebRtcTransport,
restartIce, produce, consume, resumeConsumer, pauseConsumer, closeConsumer,
setConsumerLayers, pauseProducer, resumeProducer, closeProducer, updateState,
control, getRoomKeys, leave, ping
```

No request carries the sender's id or role; the server knows which socket sent
it. `join` carries an optional room key, which is how roles are earned.

### The join sequence

1. Connect the socket.
2. `join` — the server answers with the participant's id, role, the roster,
   every producer already in the room, short-lived ICE servers and the
   router's RTP capabilities.
3. Load the mediasoup `Device`.
4. Create the send transport (not for viewers) and the receive transport.
5. Consume every producer the room already has; each consumer is created
   paused and resumed once its track is wired.
6. Publish whatever local tracks were requested, before or after joining.

Transports connect lazily on the first produce or consume.

### Quality

Cameras are sent as three simulcast layers (quarter, half, full), screens as
one sharp low-rate layer with `contentHint: 'detail'`, audio as Opus with DTX
on microphones. A quality controller samples both transports every two seconds
and moves a downlink and an uplink tier through a hysteresis machine — three
bad samples to step down, ten good ones to step up — selecting the simulcast
layer the server forwards for every remote video and capping the camera's
layers. A single lost burst never changes the picture.

### Mix-minus

A participant never consumes its own producers, and the server refuses a
request to. So each guest hears everyone *but themselves*, by construction
rather than by subtraction, and the director's program receives everyone.

### Reconnection

The socket reconnects with backoff. On reconnect the session re-joins with a
**resume token**; if the server still holds the participant (it keeps a
dropped participant's transports for thirty seconds), ICE is restarted on both
transports and local producers are kept. If it does not, the session rebuilds
from scratch: new transports, local tracks re-published, remote producers
re-consumed. Identity is whatever the server reports, so the director keeps
one tile per person either way. Every step has a timeout; nothing sits in
"connecting" forever. The network coming back or the tab becoming visible
triggers a check immediately rather than at the next heartbeat.

### Honest status reporting

A participant is `connected` only when the studio's receive transport is
connected and the server lists them. Whether their media is arriving is a
separate fact, shown separately. Diagnostics render every unavailable metric
as an em dash instead of inventing numbers.

### Running the server

```bash
cd server
npm install
npm run dev          # http://localhost:3001, signaling on ws://localhost:3001/signal
```

The studio already points there. The address is blank by default and resolved:
`VITE_SIGNALING_URL` if set at build time, else `ws://<hostname>:3001` when the
page URL carries a port (development), else the page's own origin. Override it
in **Settings → Media server**. `/healthz` reports rooms, participants,
connections and workers.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ALLOWED_ORIGINS` | *unset* | Comma-separated browser origins allowed to connect; unset means any, and the server warns |
| `ROOM_KEY_SECRET` | *generated* | Director and producer keys are HMACs of the room name with this. Unset, keys change on every restart and the server warns |
| `MEDIASOUP_ANNOUNCED_ADDRESS` | *unset* | The address clients can reach for media. Required for anything but localhost |
| `MEDIASOUP_PORT` | `40000` | First media port; each worker takes the next one, UDP and TCP |
| `MEDIASOUP_WORKERS` | CPUs, max 4 | mediasoup worker processes; rooms are placed on the least loaded |
| `CLOUDFLARE_TURN_KEY_ID` / `..._API_TOKEN` | *unset* | Cloudflare Realtime TURN |
| `TURN_URLS` / `TURN_STATIC_AUTH_SECRET` | *unset* | A coturn-compatible relay using `use-auth-secret` |
| `TURN_TTL_SECONDS` | `3600` | Credential lifetime, 600–7200 |

### TURN

Media now terminates at the server, so a participant only has to reach *it*.
Most networks can, over UDP; where UDP is blocked the transport falls back to
TCP. A participant behind a NAT that blocks both still needs a TURN relay, and
the studio says so when ICE fails.

Credentials are minted **per session**, delivered only inside the
authenticated join response, and expire after `TURN_TTL_SECONDS`. There is no
endpoint that hands a credential to whoever asks; the previous design served
one 24-hour credential to any request, which was a free relay for anyone who
found the URL.

### Hardening

- WebSocket frames are capped at 256 KB (`maxPayload`), matching the largest
  SDP the protocol accepts.
- Per-address and total connection caps at upgrade.
- A socket that has not joined within fifteen seconds is closed; dead sockets
  are reaped by a thirty-second heartbeat.
- Rate limiting is a token bucket **per category** — room operations, media
  signaling, ICE restarts, control, keepalive — so a burst of consumer
  requests on join cannot starve an ICE restart during a network change. A
  refused request is answered with `rate-limited`, never dropped.
- The protocol has no field for a client to claim an identity or role.

### Deployment

The server holds rooms and routers in one process's memory and needs a
reachable UDP (and TCP) media port. That means a container or VM with those
ports published — Fly.io, a VPS, Kubernetes with a host port — and
`MEDIASOUP_ANNOUNCED_ADDRESS` set to what clients can reach. It does not run on
a serverless platform, and Render's web services publish only one HTTP port,
so on Render media is limited to TCP through a TURN relay; see
[`render.yaml`](render.yaml). Scaling past one process needs a room-to-instance
mapping first.

```bash
# from the repository root
docker build -f server/Dockerfile -t livedeck-server .
docker run --rm -p 3001:3001 -p 40000-40003:40000-40003/udp -p 40000-40003:40000-40003/tcp \
  -e ALLOWED_ORIGINS=https://studio.example.com \
  -e MEDIASOUP_ANNOUNCED_ADDRESS=203.0.113.10 \
  -e ROOM_KEY_SECRET=$(openssl rand -base64 32) \
  livedeck-server
```

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
  opening a room link does not download the mixer, recorder or scene editor,
  none of which their page can use. Diagnostics and every dialog
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

The browser suite starts both the studio and the media server. If port 3001 is
already taken by something else, point both at a free one:

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
accumulate streams, config survives a reload but capture does not); **E** room
joining, including the participant lifecycle — leaving removes a guest, and
rejoining or reloading does not duplicate them; **F** the scene window, which
asserts that the mirrored program really decodes *moving* frames rather than
showing a single stuck image; **G** device pickers, the speaking indicator, and
solo sharing; **H** guests among themselves — two guests sent nothing but a
room link decode each other's video with no control room involved, a third
joining an existing pair sees both, a director in the room stays invisible to
guests, joining switches nothing on, a camera turned on *after* joining still
reaches the other side, and a screen share gets its own region; **I**
authorization and recovery — guest A drives its session directly to mute,
relabel, cue, put on air and kick guest B and the server answers `forbidden`
to each while B's window is untouched; the director's tile control does flip
B's microphone and a cue lands on B's screen; then B's network is cut and
restored, and B comes back as the same participant with the director still
holding one tile; **L** a twelve-participant load run, which only runs under
`LIVEDECK_LOAD=1`.

Every scenario runs against the real media server — Playwright starts
`server/` alongside the dev server. A limit worth stating: all contexts run on
one machine, so media always reaches the server over the loopback. It verifies
the workflow, the authorization and the state machine, **not** NAT traversal
across the internet, which needs two real networks.

## Known limitations

Collected honestly in one place.

1. **The media server must be reachable over UDP or TCP on its media port.**
   A host that publishes only HTTP (Render's web services, serverless
   platforms) cannot carry media directly; a TURN relay in front is the
   fallback and costs latency. Set `MEDIASOUP_ANNOUNCED_ADDRESS` to the
   public address, or nothing outside the host will connect.
2. **One process.** Rooms and routers live in memory; rooms do not span
   instances and a restart drops every room (clients reconnect and re-join).
3. **Screen capture targets are chosen by the browser, not the app.**
4. **Display audio is not guaranteed.** `audio: true` is a request; whether a
   track arrives depends on the OS, browser and surface. The app inspects the
   tracks and says when none arrived.
5. **A recording is finalized only on Stop.** Chunks are stored every second,
   so a crash loses at most the last one and the recording is recovered on
   the next load with a duration computed from the chunk timestamps — but
   the last slice is gone.
6. **WebM files carry a duration but no cues.** Browsers and most players
   seek them; some editors want a cues index, which needs a full re-mux
   (a WebCodecs + MP4 path is the next step). Safari records MP4 natively.
7. **The compositor paints on the main thread.** A worker-timed clock keeps
   frames flowing when the tab is hidden, but a very heavy UI frame can still
   delay a paint. Moving painting into a worker needs frame providers that
   do not depend on `HTMLVideoElement`.
8. **Output quality cannot exceed the sources.**
9. **Pausing a recording is unavailable** where `MediaRecorder.pause` is
   missing. The control is disabled with an explanation.
10. **Large recordings may exceed the storage quota.** Recording refuses to
    start with less than 200 MB free, and a quota error mid-recording stops
    it and keeps what was stored.
11. **Precise drag editing is impractical on small screens.**
12. **Local image and video files are capped at 500 MB** and live in
    IndexedDB.
13. **A scene window mirrors the control room, so it depends on it.** The
    program is sent to it over a loopback peer connection inside the same
    browser. With no control room open it falls back to its own compositor.
14. **Remote control needs the server.** Commands go through it so it can
    authorize them; without a connection the UI disables them.
15. **The director key lives in the browser that claimed the room.** Lose
    that browser's storage and the key is gone with it; set `ROOM_KEY_SECRET`
    so a known key can be re-derived, or open the room while it is empty to
    claim it again.
16. **The room name is not a password.** It grants the guest role to anyone
    who reaches the server. The keys are what gate the director and producer
    roles.

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

15. With the media server running, open the **Guests** tab and copy the
    **guest link**. One link, reusable, no fields to fill in.
16. Open it in a second browser profile, or on another device on the same
    network. Type a name and click **Join room**.
17. The guest appears in the control room under the name *they* chose, and both
    sides report *Connected* from their real transport state. Nothing was
    pasted anywhere.
18. Click **Leave room** on the guest to drop the connection and return to the
    join screen.
19. From the guest's tile, click **Mic** under "Remote". Watch the *guest's own*
    window flip to "Unmute" — the command went through the server and disabled
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

**A guest is listed but no media arrives** — The browser could not reach the
media server's media port. On a laptop the server auto-detects its LAN
address; anywhere else `MEDIASOUP_ANNOUNCED_ADDRESS` must be the public
address and the UDP/TCP media ports must be published (`docker run -p
40000-40003:40000-40003/udp …`). The server's startup line prints what it is
announcing. A guest behind a NAT that blocks both UDP and TCP needs TURN: set
the Cloudflare or coturn variables in `server/.env`; credentials are then
issued per session inside the join.

**"Could not reach the media server", but it is up** — Most likely
`ALLOWED_ORIGINS` does not contain the studio's origin, and the socket is being
refused with a 403. The browser hides the HTTP status of a failed WebSocket
handshake, so the console says only *"WebSocket connection failed"*. Check the
server's startup log, which prints the effective allow-list, and compare it
with the studio's origin exactly — `scheme://host`, no trailing slash.

**"Could not reach the media server"** — It is not running, or something else
is on its port. Start it with `npm --prefix server run dev` and check
`http://localhost:3001/healthz` returns JSON with `rooms`, `peers` and
`workers`. If an HTML page comes back instead, a *different* process owns the
port. Either free it or set `VITE_SIGNALING_URL` and the server's `PORT` to a
free one.

**Guests open the room link but never appear** — Check the Guests panel says
*In the room as director* first. Then confirm the guest actually clicked
**Join room** — opening the link alone announces nothing, by design. Both
sides must also be on the same server and the same room name.

**The control room says it is in the room as a guest** — This browser does not
hold the director key: somebody else claimed the room first, or this browser's
storage was cleared. Open the room with the director link (`?key=…`) from the
browser that holds it, or wait for the room to empty and open it again to
claim it. Set `ROOM_KEY_SECRET` on the server so keys survive restarts.

**A remote command is refused** — The server answered `forbidden`: this
session's role may not do that to that participant. Producers cannot put
guests on air or kick them, and nobody below director can act on the
director. The toast names the refusal.

**Remote mute does nothing** — The session to the media server is not up. The
buttons are disabled when that is the case; if they are enabled and the
command still fails, a toast says why.

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
│   ├── guests/           guest tiles, call grid, room links
│   ├── audio/            mixer, level meters
│   ├── recording/        transport controls, library
│   ├── diagnostics/      diagnostics panel
│   └── shared/           button, panel, fields, dialog, status, toast, error boundary
├── hooks/                one responsibility each; the only React↔service bridge
├── media/                the SFU client: signaling client, media session,
│                         encodings, quality manager and controller, session store
├── services/
│   ├── media/            stream registry (ownership), device + capture services
│   ├── composition/      compositor, frame clock, composition model, interaction
│   │                     controller, frame providers, asset cache, program link
│   ├── audio/            mixer graph, master chain, meter worklet, meter bus
│   ├── recording/        recording engine, MIME negotiation, WebM duration, recovery
│   ├── signaling/        server address, ICE server parsing, URL parameters
│   ├── sources/          source factory, default placement, stream keys
│   └── persistence/      localStorage, schemas, issues, documents, assets (IndexedDB),
│                         recordings (IndexedDB, chunked), object URLs
├── stores/               zustand stores, one per domain
├── types/                domain types
├── utils/                geometry, snapping, audio math, formatting, errors, ids
├── lib/                  capability detection, class-name helper
└── test/                 browser API stubs and mediasoup doubles for the unit suite
e2e/                      Playwright scenarios, including authorization, recovery
                          and a twelve-participant load run
shared/                   protocol schemas and the role capability table — compiled
                          into both the browser and the server
server/                   the media server: signaling + mediasoup SFU
├── Dockerfile            container image; build context is the repo root
└── src/
    ├── mediasoup/        config, worker pool, room (router + transports +
    │                     producers + consumers), peer
    ├── rooms/            room manager and limits
    ├── signaling/        WebSocket server, request handlers, room keys
    ├── security/         rate limiting by category, connection caps
    ├── turn/             per-session TURN credentials (Cloudflare or coturn)
    ├── http.ts           landing page and /healthz
    └── server.ts         wiring and shutdown
render.yaml               Render blueprint (HTTP only; see the note inside)
```

## Final note

The central workflow is: **open a room → send a link → compose scenes → mix
audio → switch layouts → record the finished production → preview and
download.** The media pipeline was built first; the interface was built around
it.

Where a browser cannot do something, this project says so rather than faking it.
