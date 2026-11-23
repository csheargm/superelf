# ADR 0018 — Leaving an app keeps its last save (离开应用不丢最后一次保存)

Status: accepted · 2026-10-17

## Context

- An app saves its last work in its `pagehide` handler. PANote does this
  (`web/note-ui.inline.html` `onPageHide` → `flushDurable`), and so does the Notes app (`flushAll`:
  the entry, then the index once the entry's reply is back). Strokes wait on a 700 ms debounce, so
  a stroke made just before ← Home exists only in the page.
- `goHome()` set `$('#fr').src='about:blank'` at once. The page's `pagehide` ran during that
  navigation, so its save was posted by a page the shell no longer served. Measured 2026-10-13 in a
  throwaway root, with Notes, a stroke less than 700 ms before ← Home:
  - **Chrome 155:** the message arrived with `e.source === null`. The broker's check
    `e.source !== $('#fr').contentWindow` dropped it. The stroke was lost (3 of 3 runs).
  - **WebKit (WKWebView, AppleWebKit/605.1.15):** the check passed, but the slug, read from the
    frame's `src` when the message arrived, was `''`. Before 2bbb18f the broker then sent a bare
    path, and the stroke was written at the workspace root (`workspace/entry-<id>.json`), apart
    from the note. Since 2bbb18f (ADR 0016) the broker refuses it, so the stroke is lost there too.
- The comments in PANote and in Notes said "the shell outlives this iframe, so that write still
  completes". The shell outlived the iframe, but it no longer served the page.
- Requests that name the app, other than `data` and `save-data`, still used an empty slug: `chat`
  and `ask` ran a confined agent for no app, tagged `(app)`; `app-convos` asked for app `''`.
- Every reply went to `$('#fr').contentWindow`, i.e. to whatever page the frame held when the reply
  came back. A reply that outlived a navigation reached the next page, whose ids start again from 1.
- A pagehide save cannot be awaited, and a page cannot be moved to another iframe: moving an iframe
  in the DOM reloads it.

## Decision

1. **A leaving app's page is held, not blanked.** `appFrameLeave()` (`web/app-frame.js`, a shell
   part inlined like `settings.js`) is the one way out of an app. `goHome` calls it, and `openApp`
   calls it before it loads the next app. If `#fr` holds an app, then:
   - its iframe loses the `fr` id and is hidden, but stays where it is;
   - a clone without the app's URL (`about:blank`) takes the `fr` id, with the old frame's `onload`
     and `onfocus` handlers (`APP_FRAME_HANDLERS`; the focus handler became a property for this);
   - the held page is told `{pa:'leaving'}`.
   A page that has posted nothing, not even PALeave's `{pa:'here'}` (decision 2), is removed at
   once, which cancels its load as `about:blank` did, and it is never held: on a page PALeave runs
   on, none of the page's own code has run before that hello.
2. **PALeave runs the page's own pagehide handlers then.** `web/leave.inline.html` is on every app
   page, after PATwoTap and PAStore, placed by `sendAppHtml` as ADR 0005 and ADR 0010 place those.
   It says `{pa:'here'}` as it runs, ahead of the page's own scripts, so the shell knows the page
   runs. On the shell's `{pa:'leaving'}` it dispatches a `pagehide` (`persisted: false`) on the
   page's window, once, and then posts `{pa:'left'}`. A page posts in order, so every save the handlers
   sent synchronously arrives before that answer. No app changes: Notes and PANote already save
   on `pagehide`.
3. **The broker serves each page as itself.** `appFrameOf(e.source)` names the page: the one in
   `#fr`, or a held one. Any other window, `null` included, is not served.
   - The slug is the page's own: `frameSlug()` for `#fr`, and for a held page the slug it had when
     it was held.
   - `reply()` and the chat stream's `send()` post to `e.source`, the page that asked.
   - Each request counts as in flight from its arrival until the handler is done
     (`appFrameBusy`, in a `finally`).
4. **The hold ends when the page is quiet, with a cap.** The held iframe is removed:
   - once it has answered `left` (or `APP_LEAVE_ACK_MS`, 2 s, has passed) and has had nothing in
     flight for `APP_LEAVE_QUIET_MS` (500 ms). A save that waits for one reply before sending the
     next, as Notes does, therefore still gets in;
   - in any case after `APP_LEAVE_MAX_MS` (20 s, PANote's own `SAVE_TIMEOUT_MS`).
   A removed iframe is unknown to the broker, so anything its page posts while it unloads (the
   real `pagehide`, which finds nothing left to write) is dropped in both engines. It can never be
   filed under the app `#fr` holds by then.
5. **No slug, no service, for every kind.** The broker refuses any request from a page with no slug
   before any branch runs: `{ok:false, code:'bad-request', error: NO_APP_TEXT}`, which the shell
   renders as `请求被拒绝 · Rejected — no app in view · 未打开应用。`. The `!appSlug` checks in the
   `data` and `save-data` branches are gone, since the gate covers them. `NO_APP_TEXT` is the one
   copy of the sentence that `setAppModel` and `saveAppSettings` already used.
6. The server's routes are unchanged (web.mjs only places PALeave on each page). It already requires `data/<slug>/` for app data (`lib/appdata.mjs`
   `appDataFile`, 532f59c), and a slug-less `chat`/`ask` already runs confined (ADR 0002).

The timings are shell constants, as `BAR_IDLE_MS` and `MODELS_WAIT_MS` are. They are not
config.json keys (ADR 0011): they are not tuned per node, and the shell is reloaded, not restarted.

## Options not taken

- **Accept the late message for a grace window, under the slug recorded at leave.** Chrome
  delivers it with `e.source` null, so it could not be told apart from any other window's message,
  and there is no window left to answer. The message itself is posted from a page that is being
  torn down, which neither engine promises to finish.
- **Keep the page in `#fr` and delay the `about:blank` until an ack.** Then the next app has to
  wait for the old one. Worse, in WebKit the old page's late messages carry the same window as the
  next page in that iframe. If the next app loaded before they arrived, they would be filed under
  the NEW app's slug, into its folder.
- **Synthesize `visibilitychange` instead.** `document.visibilityState` cannot be set, so the
  handlers that check it (Notes, PANote) would do nothing.
- **A new event (`pa-leaving`) that each app listens for.** Every app with a leave save would need
  an edit, the owner's live copies under `workspace/` included, and an app that forgot it would
  lose its save as before. Notes and PANote already save on `pagehide`.
- **A server-side change.** The server already holds the namespace (decision 6). The loss is in
  the browser, before anything reaches it.

## Consequences

- `test/leave.test.mjs` pins PALeave:
  - alone, in a vm: it says `here` as it runs; the handlers run, then the answer, which comes
    after their saves; a handler that throws does not stop the others; only the shell's
    `leaving` counts, once;
  - on every committed app page once, after PAStore, as a real web.mjs serves it.
- `test/app-leave.test.mjs` pins the shell:
  - the real `openApp` and `goHome` on the shell's own markup (`test/helpers-shell-dom.mjs`
    `runShellNav`): Notes is held hidden and in place, told it is leaving, Bible loads into the
    fresh frame, Notes is removed once quiet, and Home leaves Bible the same way;
  - the broker and the app-frame block, extracted as served (`test/helpers-shell-broker.mjs`),
    against a real web.mjs:
    - a save posted after leaving, by a page that had said only `here`, lands in `data/notes/`,
      and the next app's save, with the same id, lands in `data/bible/`; each reply reaches only
      the page that asked;
    - CONTROL (R14): in the old order, the same save is refused (WebKit's message) or dropped
      (Chrome's `null` source), and nothing is written;
    - the hold's rules, on a fake clock: no removal before the answer, or while a request is in
      flight; removal at the quiet, at the ack timeout plus the quiet, and at the cap; a removed
      page's late messages (its old window, and `null`) are dropped and write nothing;
    - a chat stream that started before the leave keeps going to the held page; the next app,
      whose PAChat also counts from `pac1`, gets none of it; and the broker block never names
      `#fr`, so no reply can be sent there by name;
    - a page that has posted nothing, not even `here`, is removed at once; the cap equals PANote's own
      `SAVE_TIMEOUT_MS`; the fresh frame is blank before it is inserted;
    - with no slug, every kind the broker implements is refused in the shell's words, and nothing
      reaches the server (CONTROL: with a slug, the same request goes out, namespaced);
    - `openApp` and `goHome` leave through `appFrameLeave`, and the only assignments to a frame's
      `src` are `openApp`'s and the fresh frame's `about:blank`.
  - Sixteen mutants each turn tests red: goHome blanking again; replies, or the chat stream, to
    `#fr`; no gate; no in-flight count; held pages not served; a quiet that ignores in-flight
    requests; the slug re-read from `#fr`; the fresh frame keeping the app's URL, or blanked only
    after it is inserted; a loading page held; no cap; handlers not carried; PALeave answering
    first, saying no `here`, or missing from the page.
- The real-browser proof is under "Measured" below.
- Tests that cut the shell by text follow the new shape: the broker loader also runs
  `NO_APP_TEXT` and the app-frame block, keeps every `message` listener, and models frames that can
  be cloned, held and removed; `app-bar-peek` finds a handler set as a property;
  `shell-inert` runs the real leave (`runShellNav`); `models-refresh` stubs `appFrameLeave`, since
  it reads only the prefs each opened app is sent, on one `#fr`.
- `test/helpers-app.mjs` `servedScriptOf` runs PALeave too, as the browser does. The relays in
  `helpers-app.mjs` (`runApp`) and `helpers-sandbox-app.mjs` (`boot`) answer only `pa:'req'`, as
  the broker does; only `boot` runs PALeave.

### Deploying: merge and restart in one step

- `web.mjs` takes the shell parts (`lib/shellhtml.mjs` `SHELL_PARTS`) and the app-page components
  (`PA_COMPONENTS`) into memory at boot, but reads `web/index.html` on every request.
- A node still running the old `web.mjs` after the merge serves the new `index.html` without
  `app-frame.js`. The broker then throws on every app request, and ← Home throws, for everyone.
- So the node is restarted together with the merge. A shell already open keeps its old script until
  reloaded; it ignores PALeave's `here` and never says `leaving`, which is the old behaviour.

### Measured (2026-10-17, throwaway roots, the owner's Notes app)

The harness draws two strokes natively, after a native tap on Draw: CDP mouse events in headless
Chrome 155.0.8059.80, NSEvent into a WKWebView (AppleWebKit/605.1.15). Stroke A is drawn 3 s
before B, so the debounce saves it; that shows the save path works at all. ← Home is clicked
30, 300 or 2500 ms after B is released, by running `#back`'s click in the shell. 4 s later the
harness reads `data/notes/`, then reopens Notes and reads the pad's pixels. Control = `main`
(361b270); fix = this branch. The AI command is `/usr/bin/false`.

| Engine | ← Home after B | `main`: B in the file | this fix: B in the file |
|---|---|---|---|
| Chrome | 30 ms | 0 of 3 (message dropped, `e.source` null) | 3 of 3 |
| Chrome | 300 ms | 0 of 3 | 3 of 3 |
| Chrome | 2500 ms (control) | 1 of 1 | 1 of 1 |
| WebKit | 30 ms | 0 of 3 (refused, no slug) | 5 of 5 |
| WebKit | 300 ms | 0 of 3 | 6 of 6 |
| WebKit | 2500 ms (control) | 1 of 1 | 1 of 1 |

- With the fix, the entry with B reached the server 4-11 ms after the click, and the index 27-67
  ms after it, from the held page. Both went to `data/notes/`. The reopened pad showed B.
- After R13 round 1 (a page that never posted is removed at once), again on both engines: 30 ms
  ×2 and 300 ms ×1 each, 6 of 6; the entry 9-12 ms after the click, the index 30-48 ms.
  After round 2 (PALeave's `here`), the same 6 runs: 6 of 6; the entry 7-16 ms, the index 37-55
  ms; no error in either engine's frames.
- No file was written outside `data/notes/` in any run, on either branch.
- After the click there were 2 iframes in `#frame` (held + fresh); 4 s later there was 1.
- Two WebKit runs on the fix had a harness input fault, both counted above for B only. In one,
  A's mouse-up did not reach the pad, so A and B were one stroke; it was saved 5 ms after the
  click, and the pad showed both. In the other, A never inked (0 of 11 points); B was saved 7 ms
  after the click.
- Evidence: the session scratchpad's `e2e/results/` (`result-{chrome,webkit}-{control,fixed}.json`,
  `result-webkit-fixed-rerun.json`), with the proxy log of every request that reached the server.

### Known gaps

- **Reopening the same app during the hold.** The new page reads its files while the held page may
  still be writing. If the read wins, the new page shows the note without the last stroke, and its
  next save can write over it. The race is the held page's save round trips against the new
  page's load and first read; how often the read wins is not measured.
- **A page that is still saving at the cap** (20 s) is removed, and that save is lost, as every
  save was before. PANote gives up on a reply after the same 20 s and says so.
- **Closing the shell itself** (the tab, or iOS ending the web app) is not a leave: there is no
  shell left to hold anything.
- **Audio or timers in a held page** keep running until it is removed, normally 0.5 s after its
  last request.
- **A held page is served every kind**, including ones that show shell UI after the user has left:
  `print`, the `action-decide` and `reminder-remove` confirms, a notification permission prompt,
  `speech-start`. Today only Notes and PANote do anything on `pagehide`, and they only save.
- **A page PALeave does not run on** loses its leave save as before, and is removed at once if it
  never posted. `sendAppHtml` places the three components before the first `<script` or `</head>`
  it finds, so one of those inside a comment ahead of the first real script puts them in the
  comment; a page with neither, using only inline handlers (`onpagehide=`), gets none. No committed
  app has either shape (`test/leave.test.mjs` checks every committed page).
- **No suite test runs the real Notes save through PALeave and the hold.** The tests post that
  save by hand; the real one is measured by the browser harness above, which is not in the repo.
- **The owner's live copy of Notes** (`workspace/apps/notes/index.html`) still says "Nothing can
  await during teardown". That is no longer true on a leave. It is live data, so it was not edited.
