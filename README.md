# LiveDeck Studio

A video production studio that runs in the browser. Combine camera, screen share
and guest feeds into composed scenes, mix the audio, switch layouts live, and
record the finished production — with no installation and **no backend**.

This is a production *switcher*, not a video calling app. The distinction is the
whole point: sources are arranged on a logical canvas, scenes are saved
compositions you cut between, audio runs through a real mixer, and what gets
recorded is the composed program output.

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
npm run dev          # http://localhost:5173
```

Open the lobby, name a production, and click **Create session**. Then start your
camera from the Capture panel.

Media capture requires a **secure context**. `localhost` counts as one, so plain
HTTP works in development. Deploying over `http://` to any other host will stop
`getUserMedia` from working at all — the app detects this and says so rather
than blaming permissions.

There are no environment variables, no API keys and no server to run.

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
| `getDisplayMedia` | Screen sharing | Screen share hidden |
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

## Operation modes

The two modes are genuinely different, and the UI never blurs them.

### Local Studio Mode (default)

Everything runs on your device: capture, composition, mixing, recording.
**No signaling server, no network dependency of any kind.**

Guests in this mode are *simulated*: an animated canvas plus a generated tone,
wrapped in a real `MediaStream`. They travel the exact same path as a remote
peer — stream registry, compositor, mixer, recorder — which is what makes the
demo exercise the real pipeline rather than a mock. They are labelled
"Simulated" everywhere, and the word `SIMULATED FEED` is burned into their video
pixels so it survives into a downloaded recording.

### Peer Connection Mode

Real browser-to-browser media over WebRTC, using **manual signaling**: you copy
a connection code from one browser and paste it into the other. See
[WebRTC and signaling](#webrtc-and-signaling) for the workflow and its real
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
| `guestStore` | Guest identity, **separately** peer state and peer stats | Identity only |
| `audioStore` | Mixer channel configuration | Yes (monitoring forced off) |
| `recordingStore` | Recorder status, library metadata | Metadata in IndexedDB |
| `settingsStore` | Output quality, editor and accessibility preferences | Yes |
| `simulationStore` | Demo flags, injected-event log | No |

Four categories of state are deliberately kept apart: **persistent
configuration**, **ephemeral session state** (live streams, connections, active
recording), **UI state**, and **simulation state**.

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
  simulated: boolean
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
SignalingAdapter        the transport seam (interface)
  └─ ManualSignalingAdapter    copy & paste
ICE configuration       STUN/TURN parsing, gathering, connectivity assessment
Remote media handler    binds incoming tracks to guest sources
Connection diagnostics  real getStats() output
```

Every transport that could ever be used — manual exchange, a WebSocket service,
a QR code, `BroadcastChannel` between tabs — implements one `SignalingAdapter`
interface. The studio UI and the peer manager know only about that type, so a
networked adapter can be added later without touching either.

### The manual workflow

```
Host creates offer → ICE gathering completes → host copies the code
       ↓
Guest pastes it → guest creates answer → guest copies the code
       ↓
Host pastes the answer → ICE connectivity checks → connected
```

### Vanilla ICE, and why

Manual exchange has **no channel for incremental (trickle) ICE candidates** —
the user would have to copy a fresh code every time one appeared. So LiveDeck
waits for gathering to complete and exports a single SDP with every candidate
already embedded.

The trade-offs, which the UI states before you invest in the flow:

- Setup is slower — a second or two spent gathering.
- Gathering **times out after 5s** rather than hanging, because a
  configured-but-unreachable TURN server can keep `iceGatheringState` at
  `gathering` indefinitely. A partial candidate set is still worth trying, and
  the UI says the set may be incomplete.
- **A STUN-only configuration discovers no relay candidates.** Two peers behind
  symmetric NAT, or behind a firewall that blocks UDP, will gather candidates,
  exchange them, fail every connectivity check, and land in `failed`. That is a
  real network limitation, not a bug, and traversing it requires a TURN server —
  which would mean running infrastructure this project deliberately does not
  have. Add your own in **Settings → ICE servers** using
  `turn:host:port|username:password`.

After gathering, the candidate set is assessed and reported in plain language:
relay present → good; public (srflx) present → works on most home and office
networks, with the symmetric-NAT caveat spelled out; host-only → same network
only; none → will not connect.

### Honest status reporting

A peer becomes `'connected'` **only** when `RTCPeerConnection.connectionState`
reports `connected`. Creating an offer, exchanging codes, or having a guest row
in the list never produces a connected status.

Guest identity and transport state are separate maps in `guestStore`. **A guest
existing in the list says nothing about whether a connection succeeded.**

- `disconnected` is reported as *reconnecting*, not failed — ICE often recovers.
- `failed` explains itself in terms of NAT and firewalls.
- Simulated guests have no transport, so diagnostics reports "simulated — no
  peer connection" instead of inventing RTT and bitrate numbers.

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
permission prompt if the browser requires one. Simulated sources and guests are
dropped on save, because a generated feed cannot be restored from a definition.

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
- **Lazy loading**: the studio is split from the lobby, and diagnostics plus
  every dialog are separate chunks fetched on first use. Initial JS is ~138kB
  gzipped.
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

320 unit and integration tests (Vitest + React Testing Library) plus four
Playwright browser scenarios.

```bash
npm test                 # unit + integration
npm run test:coverage    # with coverage
npm run e2e:install      # once — downloads Chromium
npm run e2e              # browser scenarios
```

### What is tested where, and why

**Pure logic** (no mocks needed): geometry and transform normalization, crop
resolution, snapping, gesture math for drag/resize/rotate/crop including rotated
and aspect-locked cases, audio math (RMS, dB, meter curves, gain resolution),
composition model resolution and layer ordering, transition progress, canvas
size derivation, format negotiation, signaling payload validation, ICE
connectivity assessment.

**Stores**: scene creation/deletion/duplication/switching, item ordering and
dense relayering, hydration including stale references, source lifecycle.

**Services with scripted doubles**: the stream registry's reference-counting
invariant (including the "delete the duplicate, original keeps running" case),
recorder state transitions, peer connection state reporting.

**Integration through hooks**: source lifecycle with real store wiring — stream
release on delete, shared captures on duplicate, scene and mixer cleanup.

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

The four scenarios: **A** local studio (devices → sources → scene → arrange →
switch → record → preview → download, including that the blob is decodable by
the browser's own player and the filename extension matches the real MIME type);
**B** source composition (camera over screen share, transforms, layer order,
hide, record across a scene switch); **C** resource cleanup (delete releases the
stream, duplicate-then-delete keeps the original alive, recording releases its
capture, ending a session stops every track, repeated start/stop cycles do not
accumulate streams, config survives a reload but capture does not); **D** peer
mode (offer contains gathered candidates, malformed and wrong-direction codes
are rejected specifically, and a full handshake between two browser contexts).

Even scenario D has a limit worth stating: both contexts run on one machine, so
host candidates always match and the connection always succeeds. It verifies the
workflow and the state machine, **not** NAT traversal. Cross-network
connectivity cannot be proven from a test runner on a single host and needs
manual two-device testing.

## Known limitations

Collected honestly in one place.

1. **STUN-only means some peer connections will fail.** Symmetric NAT or
   UDP-blocking firewalls need a TURN relay, which this project does not host.
   The studio reports `failed` rather than faking a connected state.
2. **Manual signaling cannot be automatic.** There is no server, so there is no
   invite link that "just connects". Codes are carried by hand.
3. **Screen capture targets are chosen by the browser, not the app.** Which
   screens, windows and tabs you may pick is entirely the browser's native
   picker. The app cannot enumerate or pre-select a target, and can only read
   what was picked when the browser reports `displaySurface` (Chrome does;
   others do not).
4. **Display audio is not guaranteed.** `audio: true` is a request. Whether a
   track arrives depends on the OS, browser and chosen surface — Chrome on
   Windows can share tab and system audio, macOS generally cannot share a whole
   screen's audio, Firefox and Safari largely do not offer it. The app inspects
   the actual tracks and explains when none arrived.
5. **A recording in progress is lost if the page is closed.** The browser will
   not allow finalization during `beforeunload`.
6. **Output quality cannot exceed the sources.** 1080p60 from a 720p30 camera
   upscales and repeats frames; the settings dialog says so.
7. **Pausing a recording is unavailable** where `MediaRecorder.pause` is
   missing. The control is disabled with an explanation.
8. **Large recordings may exceed the storage quota.** They stay downloadable for
   the session and are marked "Not stored".
9. **Simulated guests are not remote participants.** They are generated locally
   and labelled as such, including a watermark burned into their video.
10. **Precise drag editing is impractical on small screens.** The mobile layout
    keeps the preview and recording status visible and points to the numeric
    controls, rather than pretending touch dragging on a 360px-wide canvas is
    equivalent.
11. **Local image and video files are capped at 40MB** and held in memory for
    the session, since they are read as data URLs.

## Guided demonstration

Reproduces the full production workflow in about three minutes.

1. Open the app and **create a session** named "Demo".
2. **Start camera** in the Capture panel. The preview appears in the program
   canvas; the status reads *Active* only once a live track exists.
3. **Start microphone**. A mixer channel appears with a live meter — speak and
   watch it move.
4. **Share screen** and pick any window. It is added as a source and letterboxed
   to fit.
5. In the Sources list, select **Screen** and use the properties panel's
   **Fill** button to make it the background.
6. Select **Camera**, then either drag it on the canvas or set `Width 320`,
   `X 920`, `Y 500` numerically — a picture-in-picture in the lower right.
   Drag to confirm snap guides latch to the edges and centre.
7. Click **New scene** — it becomes the live scene immediately, since you
   create a scene in order to build it. Rename it "Split", arrange camera and
   screen side-by-side, and set its transition to **Crossfade, 400ms**.
8. **Switch between the scenes.** Watch the program canvas actually dissolve —
   the output changes, not just the highlighted card.
9. In the demo panel, **Add a simulated guest feed**. It appears as a real source
   with a moving frame counter, marked *Simulated*, with its own mixer channel.
10. Pull the **host mic fader** down and the guest fader up.
11. **Start recording**. The ON AIR tally lights and the timer runs.
12. **Switch scenes while recording**, move the camera, hide a source, adjust a
    fader.
13. **Stop & save**. Watch it pass through *Writing the file* before reporting
    *Saved to the library*.
14. Open the **recording library**, **Preview** the result, and confirm the
    scene switches, the transforms, the hidden source and the fader moves are
    all in the file. Then **Download** it.
15. Open **Diagnostics** to see real compositor frame rate, live track states
    and stream reference counts.

Optional peer demonstration: switch to **Peer Connection**, open **Connect a
real guest**, create an offer, and paste the code into a second browser (a
different profile, or another device on the same network). The guest produces an
answer; paste it back. Both sides report their real connection state throughout.

## Troubleshooting

**"Camera permission was denied"** — Allow it for the site in the address-bar
controls, then click Retry. A site-level block cannot be overridden by the page.

**"The device is in use by another application"** — Close other apps holding the
camera. On Windows, check the privacy indicator in the taskbar.

**Camera status is Idle after a reload** — Expected. Streams cannot be
persisted, so capture is re-acquired explicitly. Scenes and layouts came back.

**No display audio when sharing** — Platform-dependent; see limitation 4. Try
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
not reach each other: symmetric NAT or a UDP-blocking firewall. Check the ICE
assessment in the invite dialog. A TURN server is required; see limitation 1.

**"The connection code is truncated"** — Only part of the code was copied. Use
the Copy button, or select the whole textarea.

**Meters are flat but the device is Active** — The AudioContext is suspended.
Click anywhere in the studio, or use *Enable audio engine*.

**Preview looks choppy** — Lower the preview frame rate cap in Settings. The
recording rate is unaffected. Diagnostics shows the measured compositor rate.

## Project structure

```
src/
├── app/                  routes and pages (lobby, studio)
├── components/
│   ├── layout/           session bar, studio shell (desktop + mobile)
│   ├── studio/           program canvas, editor overlay, settings, palette
│   ├── sources/          source list, capture controls, properties, add-source
│   ├── scenes/           scene strip
│   ├── guests/           guest panel, invite / signaling workflow
│   ├── audio/            mixer, level meters
│   ├── recording/        transport controls, library
│   ├── diagnostics/      diagnostics panel, demo panel
│   └── shared/           button, panel, fields, dialog, status, toast
├── hooks/                one responsibility each; the only React↔service bridge
├── services/
│   ├── media/            stream registry (ownership), device + capture services
│   ├── composition/      compositor, composition model, interaction controller,
│   │                     frame providers, asset cache
│   ├── audio/            mixer graph, meter bus
│   ├── recording/        recording engine, MIME negotiation
│   ├── webrtc/           peer manager, ICE, getStats
│   ├── signaling/        adapter interface, manual adapter, payload validation
│   ├── sources/          source factory, default placement, stream keys
│   ├── persistence/      localStorage, IndexedDB, documents, object URLs
│   └── simulation/       synthetic media generation
├── stores/               zustand stores, one per domain
├── types/                domain types
├── utils/                geometry, snapping, audio math, formatting, errors, ids
├── lib/                  capability detection, class-name helper
└── test/                 browser API stubs for the unit suite
e2e/                      Playwright scenarios A–D
```

---

## Final note

The central workflow is: **capture media → compose scenes → mix audio → switch
layouts → record the finished production → preview and download.** The media
pipeline was built first; the interface was built around it.

Where a browser cannot do something, this project says so rather than faking it.
