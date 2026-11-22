# PANote — a palm-started page flip locks the Pencil out for 320 ms

Status: **SHIPPED** 2026-09-28 in `b174a71` (a pen that cancels a palm-flip draws on that same
touch) and `881d866` (swipe-to-flip OFF by default). Pinned by `test/note-palm.test.mjs` (d2) and,
through the REAL `endFlipDrag` rather than a stub, by `test/note-pencil-routing.test.mjs` (D) with
its revert-mutation in `test/note-pencil-routing-mutation.test.mjs`.

**The settle window is closed too** (2026-10-11, branch `fix/panote-flip-settle-pen`): with
swipe-to-flip turned ON, a nib that landed while a finger flip was still SETTLING was dropped. One
of the owner's Pencil logs caught exactly that — see "Closed: a nib landing while a flip settles"
just below.

A Pencil complaint is **still open** — see "Open" at the end. With swipe-to-flip OFF (the default)
a palm cannot start a flip at all, and nine logs taken that way recorded no failure.

## Closed: a nib landing while a flip settles (2026-10-11)

Status: **FIXED** on `fix/panote-flip-settle-pen`. Pinned by `test/note-flip-settle-pen.test.mjs`
(a synthetic replay of the device sequence, each layer on its own, the guards, everyday writing)
and `test/note-flip-settle-pen-mutation.test.mjs` (a mutation per layer and per guard).

**Device evidence** (owner's iPad, build `79470ba`, swipe-to-flip ON, finger drawing OFF, pen
tool; summarised, no raw data in the repo):

1. A resting hand — two direct touches, radii about 42 and 52 — landed on the ink; both armed the
   flip gesture (`d:"gesture-armed"`). The second replaced the first as the tracked gesture, so one
   then logged `d:"touch-unarmed"` and the other `d:"arming"` then `d:"flip-begin"` (`fl` 1).
2. About 140 ms later iPadOS cancelled BOTH touches: `pointercancel` and `lostpointercapture` for
   each, then `touchcancel`, no `touchend`. A cancel snaps back, through the animated path: the flip
   SETTLES for `FLIP_MS + 40` = 320 ms with no finger left.
3. 286 ms after the cancel — inside the settle — the nib landed. Its `pointerdown` (pressure 0.08,
   buttons 1) targeted `.pan-flip`, the page-turn overlay (z-index 2); its `touchstart` there logged
   `d:"guard-prevent"`.
4. About 40 ms later the settle cleared `fl`. Every pen move from then on — 104 of them, about
   440 ms, pressure 0.08..0.50 — arrived on the ink with `pen:null`, `dr:false`, `d:"no-stroke"`. No
   ink until the owner lifted and re-gripped; the next pen-down on the ink drew normally.

Nine other logs (swipe-to-flip OFF, about 730 pen contacts): every pen-down on the ink produced
`draw` / `extend` / `end`.

**Why `b174a71` did not cover it.** It made `penTookOver` cancel a LIVE finger flip at once. Here
the finger was already gone: the flip was settling with `flipTouch` null, so `penTookOver` returned
early — and the nib's `pointerdown` never reached the ink's handler anyway, because the overlay took
it. That is the window this plan's first version named and left open ("a nib landing inside that
window is dropped") because flipping is off by default; the owner turned it on.

**The fix, three layers** (`web/note-ui.inline.html`, "A NIB THAT LANDS WHILE A PAGE-TURN SETTLES"
in the routing block, and "THE SETTLE" in the flip code):

1. **Settle takeover** (`penLandsInFlip`). A pen `pointerdown` in the writing area runs the pending
   settle at once (`settleFlipNow`): `flipTo` and `endFlipDrag` now schedule their end through
   `scheduleSettle`, and the takeover runs the SAME closure the timer would have — commit or
   snap-back as the finger's release decided — and clears the timer, so the end never runs twice
   and never cuts the next flip short. A nib that landed DURING a page-turn but off the ink (on the
   overlay, or on bare stage, because mid-turn the page box is slid aside) is then routed to
   `onDown` on the same `pointerdown`: the stroke starts at once, on the page the flip settled on.
   The same covers a nib landing off the ink during a LIVE palm drag. A pen tap on a bar keeps its
   animation; the T tool never inks; outside a page-turn, bare stage still draws nothing.
2. **The overlay takes no input** (`.pan-flip{pointer-events:none}`). Nothing relied on touching
   it: the finger that drives a flip is captured before the overlay shows (on the ink at
   `flip-begin`, on a gutter at `pointerdown`; Chromium also captures a touch implicitly at
   `pointerdown`), and in Chromium a finger flip completes identically before and after.
3. **Late start** (`lateStart`). A pen moving ON the glass over the ink — `buttons` and `pressure`
   both above 0 — with no stroke (`drawing` false) and no pen owning the surface (`penId` null)
   starts its stroke where it is, through `onDown` (the one start path), logged
   `d:"late-start"`. Never for hover, touch or mouse; never in the T tool or with a popover open;
   Select and a turning page are refused before it is reached (and `onDown` refuses a turning page
   on its own); never for a contact whose `pointerdown` — read on `window`, before any handler can
   swallow it — landed outside the writing area or with a popover open, and never after that
   contact's `pointerup` / `pointercancel`. The eraser late-starts too: it erases along its path
   and owns the surface.

**Each layer on its own**, the same synthetic sequence, in the harness and in Chromium (CDP touch
and pen, 820x1180, the real PANote; base = `main`):

| build | the nib's `pointerdown` | ink |
|---|---|---|
| base | on `pan-flip`, no decision | none — every later move `d:"no-stroke"` |
| all three layers | on `stage`: `flip-settled-pen>pen-off-ink>draw` | every move |
| settle takeover alone | on `pan-flip`: `flip-settled-pen>pen-off-ink>draw` | every move |
| overlay alone | on `stage`, no decision | none (bare stage routes no pen, and `onDown` refuses while `flipping`) |
| late start alone | on `pan-flip`, no decision | from the first move after the settle (`late-start>draw`); the moves inside the settle are lost |

The overlay layer recovers nothing alone; it is what makes the nib's `pointerdown` reach the
routing as an ordinary page contact, so the other two do not depend on a rescue of the overlay.

**Harness fidelity.** The harness dispatches to whatever element a test names, so where a nib
lands is modelled (`test/helpers-flip-settle.mjs`, `pageHit`) from the shipped stylesheet's
`.pan-flip` rules, the overlay's real display state, and one measured fact: mid snap-back,
`elementFromPoint` under the nib is `.pan-flip` before the fix and `.pan-stage` after. The first
harness model said "the ink"; the Chromium probe corrected it, and the off-ink routing above
exists because of that measurement.

Everything between here and "Open" is the **historical** diagnosis as written on 2026-09-22
(`27b9d96`), kept because the reasoning is still how the fix works. Statements in it that were true
then and are not now are marked *(historical)*.

Affects PANote (`web/note-ui.inline.html`), so it affects **both** apps that mount it: the Bible
app and the Notes (journal) app, in `shared-apps/` and in each user's `workspace/apps/`.

## The two symptoms, as reported from a real iPad

1. Resting the pinky/palm on the page to start writing turns the page.
2. The Pencil sometimes writes no ink. Lifting a finger and re-holding the pencil "resets" it.

They are **one event**, not two bugs. (2) is the tail of (1).

## Root cause, verified by reading the source

PANote already carries three palm guards for the finger flip — see the
`PALM REJECTION（掌拒）` block just after the `PA_POINTER_ROUTING_BEGIN` marker. They are sound
and they are not the problem. The hole is what happens **after** a palm gets through them:

1. The palm lands and slides as the hand settles. If it clears every guard (below), `fingerFlipMove`
   calls `beginFlipDrag`, which sets `flipping = true` **and moves `cur` to the next page**.
2. The nib lands. The capture-phase `pointerdown` listener on `host` calls `penTookOver()`, which
   calls `endFlipDrag(false)` *(historical — it now calls `endFlipDrag(false,true)`, the immediate
   path)*. Correct so far — the flip is being cancelled.
3. But `endFlipDrag` clears `flipping` and restores `cur` **inside `setTimeout(…, FLIP_MS + 40)`**.
   `FLIP_MS` is 280, so the state stays flipped for **320 ms**.
4. `onDown` opens with `if (flipping) return;`. The Pencil's `pointerdown` is dropped outright.

The Pencil is already down, so no second `pointerdown` is ever delivered. It stays dead until the
user lifts and touches again — exactly the reported "lift a finger and re-hold the pencil".

## Why it is intermittent

A palm only arms a flip when ALL of these hold (`fingerFlipStart` / `fingerFlipMove`):

- `penNear()` is false — no nib down, and none lifted within `PEN_GRACE_MS` (700 ms)
- the contact slides more than 20 px
- it starts moving within 350 ms of landing
- the movement is more horizontal than vertical

`penUpAt` starts at 0, so `penNear()` is false only **before the first nib contact of a session**,
or after a pause longer than 700 ms. Once writing is under way each nib lift re-arms a 700 ms
shield. That is why the report is always "when I START writing" and never "while writing".

### To reproduce deliberately *(historical — needs swipe-to-flip turned ON since `881d866`, and the nib now draws anyway)*

Open a note fresh, **before touching the Pencil to the page at all**. Plant the hand so the pinky
lands, and let it settle with a small sideways drift inside the first third of a second. If the
page flips, try to write immediately: the Pencil should be inert for ~320 ms.

## Why the existing test did not catch it *(historical — the stub now defers exactly as the real one does)*

`test/note-palm.test.mjs` is a good harness — it extracts the real routing between the
`PA_POINTER_ROUTING` markers and drives it through a real capture → target → bubble dispatch. But
it stubs the flip animation, and the stub is **synchronous**:

```js
S.endFlipDrag = (commit) => { calls.end.push(!!commit); if (!commit) S.cur = S._from; S.flipping = false; };
```

The shipped `endFlipDrag` takes 320 ms to do the same thing. The window the bug lives in does not
exist in the harness. This is the standing scar about harness fidelity: a mock more forgiving than
the real system hides the bug it was written for.

**Fix the harness first, and watch the new test go red before touching the app.** A stub that
defers the state restore (a controllable clock, not a real timer) is the whole point here.

## The fix *(done — this is what `b174a71` implemented)*

1. Make `penTookOver()` cancel the flip **synchronously**: restore `cur`, `rebuildCommitted()`,
   `redrawPage()`, `renderTextLayer()`, and clear `flipping` at once, then let the snap-back
   transition play out purely as animation.

   The state restore MUST move with the flag. `beginFlipDrag` has already advanced `cur`, and
   today `endFlipDrag(false)` puts it back only in the timeout — so simply clearing `flipping`
   early would let the Pencil ink onto the **wrong page**. That is worse than the bug.

2. Keep the ordinary (finger-released) flip exactly as it is. Only a pen takeover needs the
   immediate path; the animated one is correct when no pen is involved.

3. Do not touch the Pencil DRAWING path. The file carries a standing instruction about that, and
   this change is in the input gate ahead of it (`onDown`'s `flipping` guard), not in the draw code.

4. Mutation-test it: revert the synchronous cancel and the new test must go red. Also assert the
   Pencil inks on the page it was actually on, so a regression that ships ink to the wrong page
   fails rather than passing as "it drew something".

## Explicitly NOT part of this

Contact geometry (`PointerEvent.width` / `height`) as a fourth palm signal. *(Still not adopted. The
Pencil recorder below now captures width/height and touch radii, so the readout this paragraph asks
for exists.)* The reasoning in the
source stands: it has never been measured on the target iPad, and iOS Safari's numbers for touch
are not raw radii, so a threshold nobody has read would start rejecting genuine swipes. If this is
wanted, add a one-tap readout to the app first, take real numbers off the device, and choose the
threshold from data.

## Open: Pencil stops until re-grip (finger draw off) — evidence via "Send Pencil log"

<!-- TODO(R4): this plan is over 300 lines. Split seam: everything from "How to collect" through
"The bar guard" (reading a Pencil log) into its own docs/plans/pencil-log-reading.md. -->

Reported 2026-10 from the iPad, finger drawing OFF (the default): mid-writing the Pencil
periodically stops inking; lifting the tip and landing it again ("re-gripping") resets it. In the
owner's words: "lifting fingers from the pencil seems to reset it so I can continue to write".

What has been ruled out or fixed, each with a test (`test/note-pencil-routing.test.mjs`):

- The palm-flip lockout above — shipped, and impossible with flipping off by default. Its settle
  variant (swipe-to-flip ON) was caught in a log and is closed — see "Closed" above.
- A palm scroll begun before the nib kept scrolling under the pen — fixed (`penTookOver` drops it,
  and the scroll branch re-checks the pen).
- A pen lift that landed off the ink surface (capture lost, or never taken) left `penId` stuck and
  the stroke unsaved — fixed by a document-level backstop.
- This branch's first version ALSO ended the stroke on `lostpointercapture` unless `e.buttons` said
  the nib was down. WebKit builds that event with buttons, pressure and x/y all 0
  (`PointerEvent::createForPointerCapture`), so on the iPad the guard never fired and a capture loss
  mid-word would have stopped the Pencil until the next contact — the symptom itself. Removed:
  `lostpointercapture` is now logged only (`d:"capture-lost-pen-down"`), and the harness builds every
  got/lostpointercapture the WebKit way.
- Hidden mid-stroke, and Select chosen mid-stroke — fixed.
- With finger drawing ON only: a palm's lift ended the Pencil's stroke — fixed by stroke ownership.

None of these is proven to be the owner's symptom. One **defensive** fix was made for it since —
see "Defensive guard: the whole writing area" below; it is not proven either. The
routing gives the Pencil exactly four ways to stop inking while it is down: `flipping` is true, the
tool is not a drawing tool, `drawing` became false, or the moves carry a different `pointerId` —
plus the one the routing cannot see: **iPadOS stops sending the pen's events** (a `pointercancel`
and nothing more until the next contact). The log tells these apart. Since 2026-10-11 a pen still
on the glass whose start was lost (`pen` null, `dr:false`) restarts by itself on its next move —
`d:"late-start"` marks each one, and the entries before it say how the start was lost.

### How to collect

Right after it happens, without writing more: ink popover (the coloured dot) → **Send Pencil log ·
发送笔迹日志**. The pad confirms with the file name; the file is `debug/pencil-log-<time>.json` in
the app's own data namespace — `data/notes/debug/` from the Journal, `data/bible/debug/` from the
Bible app (both wired in the owner's workspace, `workspace/apps/notes` and `workspace/apps/bible`).
The shelf Journal (`shared-apps/notes`, a promoted snapshot with a byte manifest) gets it at the
next promote; where `saveLog` is not wired the menu entry does not appear. The header's `build` says
exactly which code produced it (git HEAD · PANote blob id); the Settings version line shows the same
string.

How far back it reaches: every event for roughly the last **10-25 s of writing** (3000 entries; a
Pencil sends about 120 contact moves a second on a ProMotion iPad and palms add their own — an
estimate, not measured on the device). Older than that, up to 90 s, only the key events survive
(2000 entries): downs, ups, cancels, captures, touches, focus, visibility, and of each run of
contact moves or scrolls only its first entry and every change of target or decision. The header's
`thinned` counts those leading key-only entries.

What it contains: timings, pointer kinds, contact geometry, target class names, routing decisions
and state. **Not the handwriting**: every inking move (a pen contact move, or a finger's with finger
drawing ON) is exported without `x`/`y`. The points where each contact began and ended, and the
positions of contacts that do not ink (a palm), are kept — they are the evidence. Never text,
images, note ids or titles.

### What to look for

Each event is `{t, type, tg, pt, id, b, p, w, h, x, y, …, d, tool, pen, dr, fl, sc, fd, nf, cp}` —
the legend is in the file's `keys`. `d` is the routing decision; the trailing fields are the
routing state the handlers saw. `tg` is the target: `tg:"ink"` is the ink canvas (`.pan-ink`),
`tg:"stage"` the scroll container, `tg:"txt"` the text layer, `tg:"doc"` / `tg:"win"` the document /
window, `tg:"vv"` the visual viewport; anything else is the element's FIRST class name (for example
`tg:"pan-bar"` for the tool bar and for the page-nav bar alike — `x`/`y` tell them apart).

- **A pen `pointercancel`** (`pt:"pen"`, `type:"pointercancel"`) mid-stroke, especially with a
  touch active (`pt:"touch"` down, `tg` other than `tg:"ink"`, or large `w`/`h`) — iPadOS took the
  Pencil away for a gesture (scroll, system edge swipe, text selection). Check the touch's `tg`: a
  contact outside the ink canvas is a prime suspect. In today's layout the page covers the whole
  stage, so the surfaces a palm can reach outside the ink are the title row (`tg:"pan-top"`, or a
  button in it such as `tg:"pan-hmode"` / `tg:"pan-htitle"`) and the page-nav bar at the
  bottom-right (`tg:"pan-bar"`, its buttons `tg:"pan-tbtn"`, `tg:"pan-lbl"`, `tg:"pan-grip"`;
  `overflow-x:auto`). Since the bar guard (below) both refuse native gestures in the drawing
  tools, and a touch landing on them logs `d:"bar-guard"`. A palm touch with one of those `tg`
  values around a pen `pointercancel` was the hypothesis the bar guard answers — see "The bar
  guard" for how a log reads now.
- **`cp:1` on a palm's `touchstart` / `pointerdown`** — the ink carried `.pan-canpan`
  (`touch-action: pan-x pan-y`) when that palm landed. In practice that arms nothing: the ink's own
  `touchstart` `preventDefault` cancels native panning whatever `touch-action` says (measured in
  Chromium with touch emulation, see "Defensive guard" below; not measured on the iPad). It was
  read as: native panning armed, which with finger drawing OFF is the case from
  ~740 ms after every pen lift until the next one (a pause between words) — and, as the log will
  show, through the whole of the stroke that next pen starts, because the routing disarms it on a
  pen LIFT, not on a pen down (observed in the harness, not changed). iPadOS latches
  touch-action at touchstart, so that palm may start a native pan; look next for `resize` / `scroll`
  entries (`vz`, `vy`, `wy`: page zoom / pan) and a pen `pointercancel`.
- **`lostpointercapture`** for the pen with `d:"capture-lost-pen-down"` — capture moved while the
  nib was down (the routing's own lift clears `pen` first, so a normal lift never logs this). On
  Safari this entry always shows `b:0`, `x:0`, `y:0`: WebKit puts no buttons or coordinates on
  capture events, so they say nothing about the nib. The stroke continues; if the pen's later moves
  then show a `tg` other than `tg:"ink"`, they are going somewhere the routing does not listen.
- **A pen `pointermove` with `d:"no-stroke"`** and `b:1` (contact, not hover) — the pen is on the
  glass but `dr:false`: the stroke was ended under it. The entries just before say by what (a
  `d:"pen-gone"` is the document backstop ending it on an up/cancel delivered off the ink).
- **`d:"refused-flipping"`** — a mouse down, or a pen MOVE, while a page turns (`fl:true`; only
  with swipe-to-flip ON). A nib that LANDS in the writing area during a turn no longer gets it: it
  ends the turn at once, **`d:"flip-settled-pen"`**, and draws on the same down — through
  **`d:"pen-off-ink"`** when it hit-tested off the ink (the overlay, or bare stage beside the
  sliding page). The window this entry used to describe is closed (see "Closed" above).
- **`d:"late-start"`** on a pen move (followed by `draw` or `erase`) — a pen on the glass whose
  start was lost started inking there. Not a failure by itself; the entries before it say how the
  start was lost (a `pointerdown` that landed elsewhere, or none at all).
- **`d:"other-pointer"`** — moves from a pen `id` other than `pen`: a second pen contact began
  without an up for the first.
- **Nothing at all** for the pen during the dead time (touch events only, or a `touchcancel` with
  `ch[].tt:"stylus"`) — the browser stopped delivering; the fix is then on the touch-event side,
  not in the routing.
- **`selectionchange`** with `sl:0` (a selection opened) or a `focusin` on the ink area — the
  selection callout or Scribble may have taken the Pencil.
- `visibilitychange` (`vs:"hidden"`) inside the window — the app was backgrounded.
- **Outside the app document** (log v3; the 2-5 s gaps where the recorder saw nothing at all):
  `tg:"shell"` entries are the shell's own report of a touch or focus on ITS elements while the app
  is open: `d:"shell-touchstart"`, `d:"shell-pointerdown"` or `d:"shell-focusin"`, `el` the shell
  element (`#box` = the chat composer under the frame), `lag` the ms it took to arrive.
  `tg:"win"` with `d:"win-blur"` / `d:"win-focus"` is the app's window losing / getting focus.
- **`hf` (focus) alone proves nothing.** PANote default-prevents its touches, so a tap moves no
  focus and the app may never have had it: then EVERY entry is `hf:0` and no `win-blur` can fire
  (measured in Chromium on the full shell, not on the iPad). Read the header's `focus` first:
  `{ever:0}` means focus was never there, so `hf:0` is just the normal state; `{ever:1}` means it
  was, and a `1` then `0` change, or a `win-blur` entry, near the dead time says something outside
  took it. `focus.mount` is `hf` when the pad mounted. A missing `win-blur` means "not observed",
  not "did not happen".

### Defensive guard: the whole writing area (owner-approved, not proven on the device)

The hypothesis it was built for: a palm resting BESIDE the page, on a margin of the stage
(`.pan-stage`, the `overflow:auto` scroller) outside the ink canvas, starts a native iOS gesture
there and iPadOS cancels the Pencil's touch.

**Correction after review: in today's layout that margin does not exist.** `setupCanvases` fits the
page to the stage's full width (`left` is 0) and at least its height, and `.pan-top` covers the
top strip, in `PANote.fullscreen` (the Journal; the Bible app on a phone) and in `PANote.panel` (the
Bible app on every iPad, see "How the hosts mount the pad" below). A probe
with the real engine (`elementFromPoint` every 2 px, mobile emulation) found **0 hits** on
`.pan-stage`, `.pan-pageInner` or a gutter at 820x1180, 1180x820 and 390x844, also after a
sideways scroll on the phone. So the margin hypothesis is ruled out **by layout, not by a device
test**, and the guard acts today only during a page-turn animation — on the bare stage the sliding
page box uncovers (until 2026-10-11 on `.pan-flip` itself, which now takes no input) — and in any
future layout that exposes the stage. `d:"guard-prevent"` will almost never appear in a log, so
**its absence means nothing**. The surfaces a palm CAN reach outside the ink are the title row and
the page-nav bar (see "What to look for"); they are covered by the separate bar guard below, because
those bars hold real buttons that must keep their click.

What changed (`THE WRITING-AREA GUARD` in `web/note-ui.inline.html`, pinned by
`test/note-stage-guard.test.mjs` with a mutation per guard; the tests dispatch onto the stage
directly to pin the wiring, which no real touch reaches today):

- In the drawing tools (pen, marker, highlighter, eraser, select) every touch that STARTS anywhere
  in the stage gets the ink's treatment: `touchstart`/`touchmove` `preventDefault`, and
  `touch-action:none` on the stage through the `.pan-guarded` class (toggled with the tool by
  `syncGuard()`). Controls are exempt by one selector (`GUARD_EXEMPT`) — none live in the stage
  today, so that is defence in depth.
- Two-finger touches are prevented too: nothing relies on a native pinch-zoom (the shell's
  viewport is `maximum-scale=1`, the ink already refused every touch).
- The T tool is untouched: the class is off, so the text keeps its native caret, selection and
  scrolling.
- A finger drag that starts on bare stage scrolls through the ink's own manual path (vertical
  only, refused while the pen owns the surface) and never turns the page.

What it changes for the user: nothing reachable today. **No panning was lost.** The earlier note
here said a phone lost its sideways pan from the margin; that was wrong — at 390 px the 700 px page
starts at x=0, so there was no margin to pan from before this guard either.

**Open bug, pre-existing (not caused by the guard): on a phone in portrait, the right ~310 px of the
page cannot be reached in the drawing tools.** The ink's `touchstart` `preventDefault` (the
NotabilityEditor fix) cancels native panning even while `.pan-canpan` sets `touch-action: pan-x
pan-y`, and the manual scroll path (`fingerFlipMove`) writes `stage.scrollTop` only. Measured at
6ff624b in Chromium with touch emulation, 390x844: a horizontal finger drag on the ink moved
`scrollLeft` 0 px; with both ink touch listeners removed it moved 310 px (the control); with only
the `touchmove` one removed, still 0. Only the T tool pans sideways. Track it as its own task: let
the manual scroll also drive `scrollLeft` when `stage.scrollWidth > clientWidth`, with a
phone-width test.

How a Pencil log reads now: a `touchstart` on the stage or page box carries `d:"guard-prevent"`
(rare, see above; the flip canvas takes no touch since 2026-10-11, so logs from earlier builds are
the only ones that show it with `tg:"pan-flip"`); a finger drag from bare stage logs `d:"margin-armed"` on its
`pointerdown` (`d:"margin-refused"` while the pen owns the surface). A touch on the ink never
carries `guard-prevent`. So:

- the symptom is gone → something else changed (this guard covers almost nothing reachable);
- a pen `pointercancel` with a palm touch around it whose `tg` is the title row or the page-nav bar
  (`tg:"pan-top"`, `tg:"pan-bar"`, `tg:"pan-tbtn"`, …) → read it with "The bar guard" below;
- a pen `pointercancel` with only `tg:"ink"` touches around it → the cause is not a touch outside
  the ink; look for `selectionchange` / `focusin` and for nothing at all being delivered.

### The bar guard: the title row and the bars (2026-10-11, not proven on the device)

Status: on branch `fix/panote-bar-guard`. Pinned by `test/note-bar-guard.test.mjs` (a mutation per
guard). Like the writing-area guard it is a **hypothesis fix**: it removes the last native gesture a
resting palm could start inside PANote, but whether that gesture is what stops the Pencil has not
been seen on the iPad.

**How the hosts mount the pad** (`shared-apps/notes/index.html`, `shared-apps/bible/index.html`
`mountHost`):

- Journal: `PANote.fullscreen`, at every size.
- Bible app: `PANote.fullscreen` on a phone; **`PANote.panel` in the PASplit bottom zone on every
  iPad**. `mountHost(wide)` takes the PASplit rail whenever its gate
  `(min-width:820px) and (min-height:600px)` is open, which 820x1180, 1180x820 and 1024x1366 all
  match. The Bible's reading column (`#verses`) then sits ABOVE the pad, outside PANote.

**Measured first** (Chromium, mobile emulation, pen tool, Draw tab open; `elementFromPoint` every
4 px in fullscreen, every 8 px over the whole viewport in the panel; the hosts' real options —
`onAsk`, `uploadImage`, `imageUrl`, `saveLog` — so the title row carries `.pan-hphoto`). Inside
PANote, in both mounts, besides `.pan-ink` a palm can land on:

| surface | its elements | `touch-action` before | overflow | natively scrollable? |
|---|---|---|---|---|
| `.pan-top` (title row) | `.pan-hist`, `.pan-htitle`, `.pan-hask`, `.pan-hphoto`, `.pan-hmode` ×2, `.pan-hmore`, `.pan-hprint`, `.pan-hx` | `auto` | visible (`.pan-htitle` hidden) | no |
| `.pan-tools.pan-docked` (tool row, docked IN the title row) | `.pan-tool` ×5, `.pan-inkbtn`, `.pan-undo`, `.pan-redo`, `.pan-grip` | `auto` (grip `none`) | `auto` | **phone only: 401 px of buttons in a 21 px strip** that only the grip shows (see below) |
| `.pan-tools` floating (phone, undocked by dragging the grip) | the same | `auto` (grip `none`) | `auto` | **phone only: 413 px in 376 px** |
| `.pan-pages` (page-nav bar, bottom-right) | `.pan-prev`, `.pan-lbl`, `.pan-next`, `.pan-add`, `.pan-delpage`, `.pan-grip` | `auto` (grip `none`) | `auto` | no — it fits at every size measured |

Where a palm lands, by mount (share of the `elementFromPoint` grid):

| mount | size | outside PANote | `.pan-ink` | `.pan-top` | `.pan-bar` |
|---|---|---|---|---|---|
| fullscreen (Journal; Bible on a phone) | 820x1180, 1180x820, 1024x1366, 390x844 | nothing (the overlay covers the screen) | the rest | the top strip | the page-nav bar (+ the floating tool row on a phone) |
| **panel** (Bible on an iPad; pad 0,766 820x414) | 820x1180 | **~61 % reading column** (`touch-action:auto`, `overflow-y:auto`); ~2 % PASplit header `.pas-head` / `.pas-head-t` (`auto`); 1.4 % divider `.pas-bdiv` (`none`) | 30 % | 4.7 % | 0.8 % |
| **panel** (pad 0,542 1180x278) | 1180x820 | ~61 % reading column; ~3 % `.pas-head` / `.pas-head-t`; 1.9 % `.pas-bdiv` | 26 % | 6.8 % | 0.8 % |
| **panel** (pad 0,881 1024x485) | 1024x1366 | ~61 % reading column; ~2 % `.pas-head` / `.pas-head-t`; 1.2 % `.pas-bdiv` | 31 % | 4.1 % | 0.6 % |

`user-select` was already `none` on all the PANote surfaces (inherited from `.pan`), and so was
`-webkit-touch-callout` in WebKit (Chromium does not implement it, so it cannot be measured there).
**So the one native gesture a palm could still start there was the one `touch-action:auto`
allows: a pan or a pinch-zoom.** Nothing else in PANote was reachable — no stage, no gutters, no
popover unless one is open. The guard behaves the same in the panel: a computed-style diff against
the base build changes only `touch-action` under `.pan-top` / `.pan-bar` (and `user-select` on the
hidden, docked `.pan-fmt` `<select>`).

**Not guarded — palm-reachable surfaces outside PANote** (neither this guard nor the writing-area
guard covers them; a fix there is the host's, not PANote's):

- **Bible app on an iPad: the reading column above the pad** — `#verses` (`overflow-y:auto`,
  `touch-action:auto`, natively scrollable) and its `.verse` rows. About 61 % of the screen at
  every iPad size measured. A palm here can start a native vertical scroll.
- **Bible app on an iPad: the PASplit note header** `.pas-head` / `.pas-head-t` (`touch-action:auto`,
  a button, not a scroller). The divider `.pas-bdiv` is already `touch-action:none`.
- The shell's own drawer, in both apps.

The recorder listens on `window` as well, so these touches DO appear in a log, with `tg` the
element's first class or tag: `div` (`#verses` has no class), `verse`, `vnum`, `ven`, `vzh`,
`pas-head`, `pas-head-t`. They never carry `d:"bar-guard"`, in any tool — **that absence does not
mean the T tool was active**; it means the palm was outside PANote.

**Pre-existing, not changed here: on a phone the docked tool row shows only its grip.** With the
title row's buttons (`.pan-hphoto` included) the docked row gets a 21 px strip at x=283, and the
grip (x 283..310) covers all of it: the tools are off-screen to the right and a finger drag there
starts the grip's own drag, never a scroll. Base and this branch measure the same. To reach the
tools the row has to be undocked (drag the grip down); floating, it is 413 px in 376 px.

What changed (`THE BAR GUARD` in the routing block of `web/note-ui.inline.html`):

- In the drawing tools `syncGuard()` puts `.pan-barguard` on the pad, and one stylesheet rule gives
  `.pan-top`, `.pan-bar` and **everything inside them** `touch-action:none`, `user-select:none` and
  `-webkit-touch-callout:none`. The selectors are `GUARDED_BARS`. A class, never an inline style.
- **No `touchstart` `preventDefault` on the bars**: on iOS that suppresses the button's click.
  `touch-action` does not. Measured in Chromium with CDP touch: a tap on `.pan-add`, `.pan-hmore`
  and `.pan-delpage` (with a 3 px wobble) still fires `click`, before and after.
- A bar that overflows (the floating tool row on a phone; the page-nav bar only if it ever does)
  scrolls by a **manual sideways finger drag** that drives its `scrollLeft`: it moves only past
  `BAR_DRAG_SLOP` (8 px), so a tap on a button stays a tap; it is refused while the pen owns the
  surface — `penNear()` when the finger lands, `penId` on every move, the predicates the page
  scroll uses; the grip keeps its own drag (it moves the bar).
- The T tool is untouched: no class, native `touch-action`, native scrolling of the bars.

Chromium probe (scratch, not committed; native panning isolated by stopping the pointer events at
the bar so the manual path cannot run): an overflowing `.pan-pages`, 100 px finger drag —
native pan 98 px before, **0 px after** in the pen tool; **98 px** in the T tool after (native, as
before); 98 px with the manual drag on. The phone's tool row, floating (the docked one shows
only its grip, above): native 37 px before, **0 after**; manual drag 37 px (its end); a tap on
`.pan-inkbtn` still fires `click` and opens the ink popover, before and after. (An earlier probe
without `uploadImage` / `imageUrl` had no `.pan-hphoto`, so its docked row was 59 px wide and
scrolled; that does not describe either host.)

How a Pencil log reads now:

- a `touchstart` on the title row or a bar while a drawing tool is active carries
  **`d:"bar-guard"`**, with `tg` the touched element's first class (`pan-htitle`, `pan-tbtn`,
  `pan-lbl`, `pan-top`, `pan-bar`, …). Its absence on such a touch means the T tool was active
  (`tool:"text"`);
- a finger `pointerdown` on a bar logs `d:"bar-armed"` (a drag may follow, each move
  `d:"bar-drag"`) or `d:"bar-refused-pen"` (the pen was down or had just lifted: that was the palm);
- **symptom gone** → a native gesture started on a bar was the cause, or something else changed;
- **a pen `pointercancel` with `d:"bar-guard"` palm touches around it** → the palm on a bar is NOT
  the cause by way of a native pan (there is none to start any more): look for `selectionchange` /
  `focusin` and for iPadOS simply stopping delivery;
- **a pen `pointercancel` with only `tg:"ink"` touches around it** → as before: not a touch outside
  the ink.

