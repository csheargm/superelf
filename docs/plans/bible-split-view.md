# Bible split view — chat + note beside the text

Status: PLAN, nothing implemented. 2026-09-10.

## What you asked for

Click a verse, have the AI pane open on the right and explain it — historical context,
who/what/why, what it means, concise and plain. A small note area at the bottom right for
reflections. Draggable, collapsible, recallable, like the Claude Desktop split. Chats and
notes still listed in the left drawer.

## What already exists (so this is mostly arranging, as you said)

Verified in the source, not assumed:

| Piece | Where | State |
|---|---|---|
| Chat engine mountable into **any** element | `PAChat.mount(host,opts)` `web/chat-ui.inline.html:865` | ready |
| Note engine mountable into **any** element | `PANote.mount(host,opts)` `web/note-ui.inline.html:2353` | ready |
| `fullscreen()` is a ~20-line wrapper over `mount()` | `chat-ui:891`, `note-ui:2406` | the seam to copy |
| A dock that **pushes** app content aside | `--pac-dock`, `html.pac-docked>body>*{left:…}` `chat-ui:344-357` | left side only |
| Media gate: split only ≥640px, overlay below | `@media(min-width:640px)` `chat-ui:349` | precedent to reuse |
| Verse → thread identity + AI context | `scopeKey/scopeRef/scopeCtx` `bible/index.html:591-626` | ready |
| Verse ↔ conversation binding, notes into the drawer | `getConvoId/setConvoId/listAugment` `bible/index.html:923-935` | ready, unchanged |
| Note re-measures on **element** resize, not window | ResizeObserver on the stage `note-ui:2267` | the drag-resize scar is already fixed |

So: no new chat, no new note, no new drawer. One new host, two new factories, one prompt.

## The one real obstacle

`--pac-dock` pushes only `position:fixed` children, via `left:`. The Bible reading view is
**normal flow** (`body{display:flex;flex-direction:column}`, `bible/index.html:13`), which
ignores `left:` — that is exactly why the existing left drawer *overlaps* the reading text
instead of pushing it.

Overlapping is tolerable on the left. On the right it is not: the whole point is reading the
verse while the AI explains it. So the right pane needs `body{padding-right:var(--pa-split)}`
for normal-flow apps **and** `right:var(--pa-split)` for fixed children (`.pac-fs`, and the
Bible's `#fab` action bar at `:41`, which is `left:10px;right:10px` and would slide under the
pane).

Note: the same fix would stop the left drawer overlapping the text. That is a **separate
session** (R8) — recorded, not bundled here.

## Design

### 1. `PASplit` — one shared right-rail host (new)

A third inlined component beside PAChat/PANote, marker `<!--PA_SPLIT_UI-->`, so every app gets
the same split instead of each one re-implementing it.

```
PASplit.open({ slots:[{key,mount(el),min},…] })  // rail with N stacked slots
PASplit.close() / .collapse() / .expand() / .isOpen()
PASplit.width(px)                                 // persisted per app+device
```

- Rail is `position:fixed; right:0; top:0; bottom:0`, width `--pa-split` (default 380px).
- **Vertical divider** on its left edge drags the width; **horizontal divider** between slots
  drags the chat/note ratio. Both clamp to each slot's `min` and to 30-70% of the viewport.
- **Collapsed** leaves a thin edge rail with the slot icons — that is your "recall to open".
- Width and ratio persisted **through the broker** (`save-data`, the path PANote/PAChat already
  use), as a **ratio, not a pixel width**.
  CORRECTED: the first draft said `localStorage`, "like `_SEEN`/`appOrder`". That was wrong.
  `_SEEN`/`appOrder` live in the **shell**, which is not sandboxed. An app runs at an **opaque
  origin** (`sandbox="allow-scripts"`, no `allow-same-origin`, `web/index.html:234`) where
  localStorage, sessionStorage, IndexedDB and cookies all throw SecurityError — recorded and
  verified 2026-09-02 at `note-ui.inline.html:2284-2290`. A ratio also re-clamps for free on
  rotation, which a px width does not.
- **Gate is `min-width:820px AND min-height:600px`, NOT the dock's 640px.**
  CORRECTED: the first draft reused the dock's `@media(min-width:640px)`. That breaks the
  guarantee you asked for — iPhone **landscape** is 852px wide, so the rail would have rendered
  on the phone. The rail gate must be its own constant: 820/600 admits desktop and iPad
  landscape (1024x768), and excludes iPhone portrait (375), iPhone landscape (852x393, height
  fails) and iPad portrait (768, width fails — a 380px rail there leaves 388px of text).
- **iPhone keeps today's behaviour, unchanged.** Below the gate the rail never renders and
  `Ask AI` / `Note` open exactly the `fullscreen()` surfaces they open now — same code path,
  not a re-implementation, so there is nothing new to regress on the phone. This reuses the
  existing `@media(min-width:640px)` gate rather than inventing a second breakpoint, and it is
  why the split can be built without touching the phone at all.
- z-index below `--pa-notice-z:2000`, which `test/app-load.test.mjs` already enforces.

### 2. `PAChat.panel(opts)` and `PANote.panel(opts)` (new, ~20 lines each)

Exact siblings of `fullscreen()`: same `mount()` call, same opts contract, different host.
The opts split **by kind**, which the first draft got wrong by promising the whole block passes
through "unchanged":
- **Data hooks — shared, one named const (R3):** `system`, `greeting`, `contextPrefix`,
  `getLabel`, `enhance`, `getConvoId`, `setConvoId`, `listAugment`. These are what keep chats and
  notes appearing in the left drawer, and they genuinely do not change.
- **Surface hooks — written per factory:** `onShow`, `onClose`, `onNewNote`. Passing these
  through would carry two teardown bugs into the rail: `onShow` (`:920`) hides the draw pad every
  time the chat is revealed, which in a split view is exactly wrong, and `onClose` (`:917`) knows
  only two surfaces.

### 3. Verse → explanation

`Ask AI` on the verse bar opens the rail and, **for a fresh thread only**, auto-sends one
structured turn:

> 释经 Explain — {ref}: 1) 历史背景 historical setting, 2) 人物 who is speaking and to whom,
> 3) 关键词 key terms, 4) 这段在说什么 what it means in plain language, 5) 为什么重要 why it
> matters. 简明扼要，每点一两句。

Re-opening a verse that already has a conversation **never re-sends** — it restores the thread.
That is the difference between a useful pane and one that burns a model call every tap.

The prompt is a named constant in the app, editable later through the app-prompt mechanism.

### 4. Note slot

**Exactly ONE PANote instance may exist.** CORRECTED and load-bearing: `_drawScope` is a single
app-level `let` (`bible/index.html:805`) read by the save closure *when it runs* (`:1029`, which
already carries a SCAR comment about this ordering), and a save writes the **whole chapter
object** (`:1040`). Two pads therefore cannot show different notes AND their independent
debounces would lose each other's handwriting — the same lost-update class as the 2026-09-02
and 2026-09-04 data-loss scars. So the rail does not mount a second pad: it **re-hosts the
existing one**, preserving its notebook, guard state and scope.

Keyed to `currentNoteId()` — the same note the drawer lists and the full pad opens. One note
engine (R3), not a second reflection widget.
Its stage ResizeObserver (`note-ui:2267`) handles the *drag*, but **not** collapse→expand: the
observer returns early on the zero reading (`:2272`) **before** updating `lastW/lastH`, so
expanding back to the same width scores as "no real change" and re-measures nothing — leaving a
stale canvas backing store, i.e. the 2026-09-02 Pencil ink-drift scar. Since you chose the note
slot **collapsed by default**, this is the normal path, not an edge case. PASplit must call
`resize()` (PANote) / `remeasure()` (PAChat) **unconditionally on every expand and at drag-end**,
never relying on the observer.

## Files

| File | Change |
|---|---|
| `web/split-ui.inline.html` | **new** — PASplit, ~250 lines incl. CSS |
| `web.mjs` | inline `<!--PA_SPLIT_UI-->` beside the two existing markers (`:471-476`) |
| `web/chat-ui.inline.html` | `panel()` factory |
| `web/note-ui.inline.html` | `panel()` factory |
| `workspace/apps/bible/index.html` + `workspace.example/apps/bible/index.html` | marker; route `Ask AI`/`Note` to the rail ≥640px; explain prompt |
| `test/split-view.test.mjs` | **new** |

## Verification

1. **Push, not overlap** — with the rail open, the reading column's right edge and `#fab` both
   stop at the rail. Mutation: drop the `padding-right` rule and assert the test fails.
2. **Drag re-measures the canvas** — resize the rail, then draw: ink lands under the nib. This
   is the 2026-09-02 drift scar; assert the observer fires, do not trust `window.resize`.
3. **No duplicate model call** — open a verse, let it explain, close, reopen: exactly one
   outbound turn. Asserted at the HTTP layer, not by reading the UI. Three ways this lies and all
   three get asserted: an unreadable chapter (`ANN_BLOCKED`) must produce **zero** turns rather
   than counting as "fresh" (R14); the auto-send must not arm until the boot `load()` resolves;
   and a second Ask AI while the first turn streams hits `chat-ui:640 if(sending) return;`, which
   silently discards it — leaving an empty pane with no error (R5). That path must report.
4. **Drawer unchanged** — a chat and a note created in the rail appear in the left drawer with
   the right titles and the right active row (this is the bug you reported three times).
5. **iPhone is untouched** — the strongest check, and the first draft specified it in a way this
   repo **cannot** run: there is no jsdom, no browser and no viewport emulation in the suite, and
   `app-load.test.mjs:515` flattens `@media` wrappers away entirely. Replaced with three things
   that are actually provable here:
   (a) a **media-aware** parser asserting every new split declaration sits *inside* the gate and
       that no split rule exists outside it;
   (b) a DOM-free **gate predicate** exported from the app, driven at 375x812, 852x393 (iPhone
       landscape — the case that broke the original 640px gate), 768x1024 and 1366x768,
       asserting which factory each reaches;
   (c) a byte-level diff of the phone code path against the pre-change build.
   Plus an explicit **R14 control**: assert the wide branch is actually taken at wide width, or
   a guard like `if(window.PASplit)` would make the whole rail unreachable in the only harness
   that runs the app, and every rail test would pass vacuously.
6. **Persistence** — width and ratio survive a reload; a corrupt stored value falls back to the
   default rather than a 0-width rail.
7. **Layering** — rail below `--pa-notice-z`; the existing ladder test still passes.
8. Full suite green (1071 baseline).

## Scope line: desktop and iPad only

Your call, and it is the right one — a 380px rail beside readable text needs ~1000px. The
split is **desktop + iPad landscape**. iPhone stays exactly as it is today.

Consequence worth stating: `PASplit` must be additive. It may not change any existing
`fullscreen()` behaviour, only add a second host next to it — otherwise "iPhone unchanged"
stops being true the first time the shared engine shifts underneath it.

## Implementation order — suite stays green at every step

1. **Harness stubs only** (`test/helpers-app.mjs`): `PASplit` stub, `panel()` on the PAChat and
   PANote stubs, `documentElement`, `innerWidth`, `matchMedia`, and a `viewportWidth` runApp
   option. Nothing consumes them yet. *Without this, an unguarded reference fails ~15 tests and
   a guarded one makes the rail branch unreachable — a vacuous pass across the whole feature.*
2. **`web/split-ui.inline.html` + the `web.mjs` marker**, appended **last** in `PA_COMPONENTS`
   (the loop re-tests already-inlined HTML, so last is the only safe position), and register the
   new file in the tests that enumerate components. No app carries the marker yet, so nothing is
   served differently. Land the R14 control test here **first**.
3. **`PAChat.panel()` + `PANote.panel()`**, placed **after** the `listDrawer` block — not between
   `fullscreen:` and it, because `chat-pill-reserve.test.mjs:249-256` slices exactly that window
   and evaluates it with `new Function`. Still unconsumed.
4. **`PAC_DOCK_EXCL`** gains the rail class (or the left dock shoves the right rail sideways),
   plus the z-ladder entries. Still no rail on screen.
5. **Bible wiring**, behind the gate, **chat slot first, note slot last** — the note slot is the
   data-loss one.
6. **Explain prompt + `convoIdFor` hoist + the end-to-end served-page test.**
7. **Port to `workspace.example/apps/bible`** — marker + PASplit + `PAChat.panel` **only**: that
   template has no `PA_NOTE_UI` and no PANote (its Draw pane is a raster `#dcanvas`), so wiring
   `PANote.panel` there would reference an undefined global.

## Size and order

`PASplit` + the two factories is the bulk (~1 session). Bible wiring + prompt is small.
Do PASplit first with the Bible as its only consumer; other apps adopt it later for free.

## Open decisions

1. **Note slot default** — open with the chat, or collapsed until you tap Note? (I lean
   collapsed: the explanation is what you asked for on tap; a reflection box competing for
   height before you have anything to reflect on is noise.)
2. **Left drawer overlap** — fix it the same way in a follow-up session, or leave as is?
