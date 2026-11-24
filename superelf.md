# superelf.md — what an app IS

The system-wide app-building prompt. One copy, at the repo root, read by every workspace
(`CLAUDE.md` points here). Building or changing an app in `apps/<slug>/` means following
this file.

This is a **CONTRACT, not advice**. `test/app-contract.test.mjs` enumerates every app and
asserts the four clauses below. An app that cannot meet one is listed in that test's
`PENDING` ledger by name and by clause — a visible debt with an owner, not a silent pass.
A NEW app is never added to the ledger: it meets the contract or it does not ship.

## The four clauses

**(a) An (ask) AI feature — mounted from PAChat, never hand-rolled.**
Every app can be asked something about what it shows. Put `<!--PA_CHAT_UI-->` in the HTML
and mount `PAChat`. An app that posts `kind:'chat'` to the broker itself is writing a
second chat client and has to be fixed, not extended. One-shot `kind:'ask'` for a
background errand (no transcript, no model chooser) is not an AI feature and does not
satisfy this clause.

**(b) An app-specific system prompt the user can edit AND reset to default.**
Put `<!--PA_SETTINGS_UI-->` in the HTML and `PASettings.attach({host, appPrompt})` in the
JS. That ⚙ shows the effective prompt, where it came from, and a box to override it;
emptying the box IS the reset. Do not build a second settings panel, and do not rely on
Settings › Advanced — it only lists apps with a declared default in `config.json`
`system_prompts.apps`, which on this node is empty, so without PASettings the app's prompt
cannot be touched at all.

**(c) Reuse first. A second copy of something is the defect, not the work.**
PAChat, PANote, PASplit, PASettings, PAPhoto, PANewDot, PATwoTap, PAStore, `PA.req`, the broker kinds,
`lib/` tools. See "Reusable components" below. If you are about to write a chat log, a markdown
renderer, a model picker, a notepad canvas, a photo picker, a settings dialog, a two-tap
delete button or a load-then-save guard for a data file, stop — it exists.

**(d) A face — declared, not assumed.**
`meta.json` carries `"face": { "label": "<caption>" }` when the home tile should show live
information, or `"face": false` when the app deliberately has none. Absent is not an
answer; the choice is made when the app is built. See "App faces" below.

---

## App faces（应用面孔）— live information on the home tile

The home shelf is rendered by the SHELL, not by the app: the app's iframe is not running
and has an opaque origin, so nothing can be scraped out of it. A face is therefore data
the app **declares and writes**, and the shell reads.

Two halves, each with one writer:

1. **`meta.json` declares it** — `"face": { "label": "open" }`. The label is the static
   caption under the value. The declaration is load-bearing: with no `face` in `meta.json`
   the shell renders no face, whatever is on disk.
2. **`data/<slug>/face.json` carries the value** — `{ "value": "3", "ts": 1757500000000 }`.
   `value` is a short string (the number, the chapter, the next block). `ts` is when it was
   computed; leave it out and the file's mtime is used. Write it through the ordinary
   broker: `{pa:'req', kind:'save-data', what:'data', path:'face.json', data:{...}}` — the path is
   auto-namespaced, so there is no new API and no new permission.

Rules that follow from where it renders:

- **Cheap or nothing.** `/api/apps` reads this file on every home view. It must be a
  value the app already has — never a model call, never a network fetch, never a scan of
  a large file. Files over 1KB are ignored.
- **Whoever can write app data can write a face.** Today the app writes it as it saves.
  A server-side job may write the same file later (see `docs/JOB_ENGINE_PLAN.md`); the
  shell does not care which, because the contract is a file, not a caller.
- **Never look live when stale.** The shell shows the age beside the value once it is
  older than an hour. That is why `ts`/mtime is part of the shape and not optional
  decoration.
- **Degrade silently to today's plain tile.** No declaration, no file, a damaged file, an
  oversized file → the tile renders exactly as it does now. A missing face is the normal
  case for most apps, not an error, so it is not reported (R5): the visible consequence
  IS the plain tile.

`apps/tasks` is the reference: it declares `"face": {"label":"open"}` and writes
`{value: <count of unchecked tasks>}` on load and on every save it sends. It writes nothing when
the list was never read, because then it has no count.

---

## Building web apps (the phone/iPad interface)
A web shell serves apps from `apps/`. Apps run **sandboxed**: opaque origin, no
network, no token — they CANNOT fetch, and cannot reach the shell's token or data
directly. They get data only by asking the shell via postMessage (the "broker").
This containment is deliberate; do not try to work around it.

When the user asks for an app:
1. **Bias to progress; clarify only when a wrong guess is costly.** Restate in
   one line what the app will show/do and where its data comes from, and state
   any assumption. Then just build it — do NOT wait for confirmation on routine
   choices. Ask a question only when getting it wrong would waste real effort or
   be hard to undo; otherwise proceed under a stated assumption and let the user
   correct after seeing it. (Lightweight acceptance, not a formal spec.)
2. Write `apps/<slug>/index.html` (slug = lowercase-with-dashes) — one
   self-contained file: inline CSS/JS, no CDNs, mobile viewport, dark+light via
   `prefers-color-scheme`. Escape any text you inject into innerHTML. Reuse the
   shared components (below) rather than rebuilding chat, notes or markdown.
   **Data goes by tool, not by tokens.** A table, list or imported record set of more than
   about 40 rows is never typed into the HTML: write it ONCE to `data/<slug>/<name>.json` with
   the Write tool (that is the file `save-data`/PAStore namespace to) and have the app load it
   with `PAStore.file('<name>.json', …)`. Measured 2026-11-01: retyping 17 KB of fetched data
   inside the page was 54% of a 232 s build.
3. Add `apps/<slug>/meta.json`: `{ "title": "...", "desc": "one line", "face": … }`
   — `face` per clause (d).
4. Mount PAChat (clause a) and PASettings (clause b). Both are markers plus a few
   lines; neither is optional.
5. Follow "App build rules" below — the data-file rule, no `<form>`, and the mandatory
   self-check before saying done.

**Before writing any UI, read "Reusable components" below.** Chat, notes/handwriting and
markdown rendering already exist as shared components; an app that reimplements one
inherits none of its fixes and has always shipped a bug the shared one does not have.
`apps/tasks/index.html` is the reference for a simple data-only app;
`apps/research/index.html` is the reference for reusing PAChat.
- Modify an app with the Edit tool, not a whole-file Write: an edit costs what it changes,
  a rewrite costs the whole file again (the same measurement above). Delete = remove its directory.

## Editing the shell UI (web/index.html)
You may improve the shell, but a single JS error at load blanks the whole app.
Rules: (1) if you remove or rename an element, remove/guard every JS reference to
it in the same edit; (2) wire optional controls null-safely (`if($('#x')) ...`);
(3) after any shell edit, load the page once and check for console errors before
telling the user it is done.

- **Never use localStorage/sessionStorage in a mini-app** — sandboxed apps have an
  opaque origin and browser storage THROWS a SecurityError (it does not return
  null), which crashes the app. Persist via the broker instead: `save-data`
  (writes a .json file in the user's workspace) and `data` (reads it). This also
  syncs across the user's devices, which localStorage never did.
- **Never call confirm()/alert()/prompt() in a mini-app** — the sandbox has no
  `allow-modals`, so confirm() returns false at once, alert() shows nothing and prompt()
  returns null. A destructive action takes two taps through **PATwoTap** (see "Reusable
  components"): the first arms the button ("Delete? · 删除?"), a second within 3 s acts. A
  message goes in the app's own status line. `test/app-contract.test.mjs` scans for them.

## Reusable components — check these BEFORE writing any UI

superelf ships shared components. Using them is not a style preference: a private copy
drifts from the contract and breaks quietly. Every app that hand-rolled its own chat has
shipped a bug the shared one does not have (Rental Hunt sent `markdown:` to `render-md`,
which reads `text`, so every answer rendered as raw `**bold**` for weeks).

**Decision rule: if a component below covers the need, use it. Do not reimplement it.**

**First-use tips (ADR 0030): every new user-facing feature registers a PATips tip** in its own code,
`if(window.PATips) PATips.register({id, anchor, text})` (text English then 中文, one or two sentences),
and is not done until the tip has been seen once in a browser test. PATips (web/tips.inline.html, carried
by chat-ui) shows one tip at a time, once per account (`appPrefs[slug].tipsSeen`, via PAAppPrefs);
⚙ Settings → "Show tips again · 重新显示提示" brings them back.

### PAChat — any AI conversation
Put `<!--PA_CHAT_UI-->` in the HTML (the server inlines the component there), then:

```js
const chat = PAChat.fullscreen({
  defaultModel: 'claude',            // which lane it opens on; omit for the first Fast lane
  placeholder: 'Ask anything…',
  system: '…',                       // system prompt for every turn
  greeting: '…',
  persist: 'my-app-chats',           // keeps {scopeKey: convoId} in the app's own data
});
chat.open('general');
```

You get, for free and consistent with every other app: markdown rendering, streaming,
the model chooser, **Verify · 校验**, attachments, the conversation drawer with
rename/delete, history that appears in the main list, and failure messages that state a
real reason. Hand-rolling gets you none of it.

`apps/bible/index.html` and `apps/research/index.html` are the reference mounts.
`apps/research` was 301 lines of private chat; on PAChat it is 65.

### PASettings — the app's own ⚙
Put `<!--PA_SETTINGS_UI-->` in the HTML, then
`PASettings.attach({ host: <an element in your header>, appPrompt: MY_SYSTEM_PROMPT })`.
Gives the app-level system prompt (effective text, its provenance, an override box that
empties back to the default) and a JSON editor for the app's own preferences, both stored
on the user's profile through the shell. This is clause (b); there is no second way to do
it. On a page that mounts PANote the dialog also shows ONE tick-box row at the top (PASettingsRows,
web/settings-rows.inline.html, carried by settings-ui): "Open AI notes with the note · 打开笔记时显示
AI 对话" = `appPrefs[slug].openAi`, kept in step with the JSON box and saved with it.

### PANote — handwriting, drawing, or rich text pages
Put `<!--PA_NOTE_UI-->` in the HTML, then `PANote.fullscreen({...})` or `PANote.mount(el,{...})`.
Gives pages, Apple Pencil input with palm rejection, undo, templates, images, autosave with
a real failure surface. Never build a canvas notepad by hand. The host's save maps the broker reply
through `PANote.saveOutcome(m)` and shows a failure as `PANote.notSavedText(r)` — the shell's `text`
whenever the shell wrote one.
`opts.tool` is the tool the pad opens in (Journal: pen on touch, select on desktop; Bible: text).
With `opts.toolByContent` (default true) each opened note picks by its first page: text and no ink →
text, ink → the draw tool, empty → `opts.tool`; `false` keeps `opts.tool` always.
Device prefs the shell stores and pushes to every app (`{pa:'prefs'}` on iframe load):
`fingerDraw`, `printInk`, `noFlip`, `seamless` (withdrawn) — rows in the pad's own settings list.
The same push carries `openAi`, which is NOT a device pref: it is the account's
`appPrefs[slug].openAi` (set in the app's ⚙ Settings, per app, re-pushed after a save). A host reads
it through `PANote.prefs().openAi` (default false: a note that carries an AI conversation opens
alone; ✨ / the ☰ chat row reopen the thread).

### PAInkAnchor — Pencil ink anchored to live text
`<!--PA_INK_ANCHOR_UI-->` after `<!--PA_NOTE_UI-->` (it draws with `PANote.ink`, the pad's own stroke renderer
and Pencil guard — never a second renderer), then `PAInkAnchor.attach({container, ink:PANote.ink})` over a
scrolling list of `.verse` blocks. Pen only; a finger or mouse passes through. Each stroke becomes an anchor
record (verse + character range + quote, px from the word's top-left, scaled by its width) and is re-placed
on every layout change. `onChange(packed)` hands the host the chapter-file shape (`{vN:[group…]}`) to store beside
its other annotations and `load(packed)` takes it back; a scrub-out stroke erases the groups it crosses; a group
whose text is gone shows in a labelled orphan bucket under the list, never dropped. `readout()` is one line for the
host's ⚙ sheet (`PASettings` extra `{label:PAInkAnchor.READOUT_LABEL, readout:true, getValue}` — a line the sheet shows,
not a box it saves): viewport, dpr, the shell's A-/A+ scale, the text column width, the ink and orphan counts — what to
screenshot on each iPad. No toggle: the Pencil inks, a finger scrolls. The Bible carries it, both copies with identical
hooks (docs/plans/annotation-anchoring.md, ADR 0028, `test/ink-anchor.test.mjs`, `test/ink-anchor-host.test.mjs`).
The control also takes `setPen({t,c,w,a})` (t = 'pen' | 'highlighter' | 'erase'; highlighter strokes draw behind pen
ink, the pad's compose order; the eraser tool removes every group a touch or drag passes over), `pen()` and
`onPen(fn)` (called on any Pencil pointerdown over the list).

### PAInkPen — the verse ink's pen sheet
`<!--PA_INK_PEN_UI-->` after `<!--PA_INK_ANCHOR_UI-->`, then `PAInkPen.attach({container, anchor:INK})`. One round
button (`Pen tools · 笔工具`) at the list's bottom-right corner, shown only after a Pencil has touched the list in this
session; it opens a sheet with pen / highlighter / eraser, three sizes (thin / medium / thick along the pad's size
scale) and the pad's swatches. Everything palette-shaped comes from `PANote.palette` (`COLORS`, `TOOLS`, `ico`,
`swatchesHtml`, `SIZE_*`, `HILITE_W`, `HILITE_ALPHA`) — the same table the pad's toolbar is built from. The choice
`{t,size,c}` is the app pref `inkPen`, read through `app-settings` at attach and on every shell `prefs` push, and
written by re-reading then merging (other keys and the prompt override kept) through one chain; a refused write is
shown in the sheet. `test/ink-pen-host.test.mjs`.

### PASplit — a docked side rail beside your content
Put `<!--PA_SPLIT_UI-->` in the HTML. Used by the Bible to keep the passage readable while
an answer streams in beside it. A hand-built two-pane layout gets none of its drag,
collapse or orientation handling.

### PAPhoto — picking and attaching an image
`<!--PA_PHOTO_UI-->`. Already reached through PAChat's ＋ button, so an app that mounts
PAChat has it; mount it directly only for a photo flow outside a chat.

### PANewDot — the blue "this is new" dot
`PANewDot.mark(el, 'feature-key')`. Available wherever PAChat is mounted. Clears on first
tap, through the shell, and stays cleared across reloads.

### PATwoTap — a delete, reset or remove button
Every app page has it already: `web.mjs` puts it ahead of the first script of every served
app page (`sendAppHtml` places the `PA_TWO_TAP_UI` marker), so there is no marker to write
and it works at top level. It replaces `confirm()`, which returns false at once in the
sandbox.

```js
// One button: the first tap asks ("Delete? · 删除?", class `arm`); a second within 3 s acts.
if (!PATwoTap.press(btn)) return;        // {label, ms} to change the words or the window
PATwoTap.disarm(btn);                    // a button reused for another row: forget its ask
// A list that re-renders: one row asks at a time, and the renderer reads the state.
const delArm = PATwoTap.rows();          // rows(ms) for another window
if (!delArm.press(key, render)) return;  // in the click handler
delArm.asking(key) ? PATwoTap.LABEL : '×'  // in the renderer
```

Style `.arm` in your CSS. `apps/family` (one reused button) and `apps/diabetes` (rows) are
the reference mounts; `test/two-tap.test.mjs` runs the component itself.

### PAStore — reading and saving the app's own data file
Every app page has it already, right after PATwoTap (ADR 0010): no marker, usable at top level.
It holds the rule that keeps a failed read from becoming an empty start: only the shell's
`not-found` is a first run; any other failed read, or a file that does not parse or has the wrong
shape, is reported and REFUSES saves, and so does a save made before the read is back. The refusal
is inside `save`, so an app cannot forget it.

```js
const f = PAStore.file('family-data.json', {
  shape: (d) => (Array.isArray(d && d.members) ? '' : 'no members list'),   // '' = right shape
  unreadable: (why) => 'Family file unreadable · 家庭文件无法读取 (' + why + ')',
});                                     // also failed(text) and loading: the app's own words
const r = await f.load();               // {state:'ok',value} | {state:'first'} | {state:'failed',text}
setStatus(await f.save(data));          // '' once saved, otherwise why not
f.loaded; f.error;                      // gate a button or an empty-list prompt on these
```

A file that is not JSON passes `parse` (default `JSON.parse`); the guard is the same. `apps/tasks`
reads and saves its markdown list this way (ADR 0010 "Tasks", ADR 0014).

`apps/family` is the reference mount; `test/store.test.mjs` runs the component itself.

### PA.req — every request to the shell
On every app page, after PALeave: no marker, nothing to mount. `await PA.req(kind, data)` returns
the shell's reply; a third argument `onEvent` takes a streaming kind's events. See "Broker API".
`PA` is a reserved name: never declare your own.

### PALeave — the last save when the user leaves
On every app page, after PAStore (ADR 0018): nothing to write or call. Save last work in a `pagehide`
handler. On a leave the shell keeps the page, hidden, runs that handler, and answers until nothing has
been in flight for 0.5 s (20 s at most), so a save chained on a reply lands. No `visibilitychange` fires.

### PABusy — "any unsaved work?" before the shell updates itself
On every app page, after PA (ADR 0026): nothing to mount. The shell asks `{kind:'pa-busy?'}` before
it reloads itself for a new build and the page answers `{kind:'pa-busy', busy}`. PANote and PAChat
already register theirs (a pending save, a streaming turn). An app with its OWN unsaved state
registers one predicate: `PABusy.watch(() => dirty)`. A watcher that throws, or no answer within
0.5 s, counts as busy: the shell then lights ↺ and shows one line instead of reloading.

### PASnap — the app's own picture for 改这个应用 · Change this app
On every app page, after PABusy (ADR 0040): nothing to mount. The owner's ⋯ → 改这个应用 asks the
page for a picture of itself and attaches it to the edit panel. Keep images and fonts as data: URLs
(they are anyway: connect-src 'none') and the picture shows them; a page with no script gets none
and the panel asks for a photo instead.

### Font size — every app gets it free
The shell's A-/A+ scale reaches EVERY app: `web.mjs` injects a listener into every served app
page (`PA_PREFS_SNIPPET` in `sendAppHtml`). You write no code for it. Two mechanisms, chosen
per app by the server:

- **`zoom`** — the default. Scales text AND layout together, so an app whose CSS is absolute
  px still scales correctly. 257 px font-sizes exist across 13 apps; scaling only their
  font-size would enlarge text inside padding that stayed fixed, which looks worse than not
  scaling at all.
- **`--fs`** — used instead for an app that mounts PANote. Its canvas coordinates come from a
  MEASURED element width, so zoom would re-lay the page out rather than magnify it. Such an
  app should size text as `calc(17px * var(--fs,1))`.

They are mutually exclusive — an app receiving both would scale twice (1.5 renders as 2.25).
Do NOT add your own `fontScale` listener; there is one setter and it is already there.

## App build rules — sent with every agent turn
Each of these broke a generated app (e2e 2026-11-13). The node flags a `<form>` tag.
1. **The app's data file goes through PAStore** (below). A missing file answers
   `{ok:false, code:'not-found'}` — hyphen — and that alone means FIRST RUN: start empty, save.
   Never test `'not_found'`: no app read answers it, so every save is refused.
2. **No `<form>` element.** The sandbox has no `allow-forms`, so a submit is blocked. Use a
   `<button type="button">` click handler and an Enter `keydown` handler on the input.
3. **Self-check before saying done — mandatory.** For each feature asked for, read your code and
   confirm its handler exists, is wired to its control, and saves via PAStore if it must persist.
   Where feasible run a node smoke check (`node --check` on the script, plus the pure logic on
   one real input). Report what you verified per requirement and one thing the user should try.

## Broker API — the ONLY way out of the sandbox
Apps are sandboxed: opaque origin, `connect-src 'none'`, no token. `fetch`, XHR, CDNs and
web fonts are impossible by design. Everything goes through the broker, and the ONE way to call
it is `PA.req`, already on every app page (no marker, usable at top level):

```js
const r = await PA.req('data', {path: 'starred.json'});     // {ok:true, text} | {ok:false, code, error, text}
await PA.req('save-data', {path: 'starred.json', data, what: 'data'});
await PA.req('chat', {message, convoId}, (ev) => show(ev)); // a streaming kind: events, then done
```

Never write your own `postMessage({pa:'req',…})`, id counter or `'message'` listener: twenty-one
apps did, and one read the reply off the event instead of `e.data` and showed a blank page for
ever. `test/broker-helper.test.mjs` fails on any new app that posts to the broker itself.
On the wire, for reading the shell's code: `{pa:'req', id, kind, …}` → `{pa:'res', id, ok, …}`

Kinds: `data` `save-data` (auto-namespaced to your app), `upload`, `attach-url`,
`chat` `chat-cancel` `ask` `convo` `app-convos` `convo-rename` `convo-delete` `set-model`, `render-md`,
`notify` `notify-at` `notify-cancel` `notify-preview`, `speech-start` `speech-stop`,
`notes-list` `note-search` `note-text` `note-page-image` `summary-followup`, `health`, `meals` `meal-photo`, `reminders` `reminder-remove`,
`actions` `action-decide`, `briefing` `briefings`, `pref`, `print`, `open-url`,
`bible` `bible-search`, `websearch`, `app-settings` `set-app-settings`,
`get-new-features` `seen-feature`.

This list is not maintained by hand — `test/broker-kinds.test.mjs` asserts it names every
`m.kind===` branch the shell actually implements, so a new kind cannot ship without it.
`notes-list` → `{ok:true, notes:[{bookIdx, chapter, book, title, verseKey, preview, hasDraws, hasText,
marks, updated, created, pin}]}`: one row per annotated scope of the Bible's chapter files; `hasText`
is whether the scope has a typed note, `marks` is the count of verse marks
(`web/verse-marks.inline.html`) on that scope, and a scope with only marks is listed with its marked
quote as `preview`. The app's delete-from-list keeps the marks unless the row is mark-only
(`!hasDraws && !hasText`) (`test/verse-marks.test.mjs`).
`websearch` searches the live web SERVER-SIDE: `{kind:'websearch', q, max}` →
`{ok:true, results:[{title,url,snippet}]}`. An app has no network of its own, and a family
member's agent cannot shell out, so this is the only way either reaches the web. `ok:false`
means the search failed or found nothing — show that; never render it as an answer.
`open-url` `{url}` opens an http(s)/mailto link in a new tab, for the Journal and the Bible notes
ONLY (config `open_url_apps`); any other app is refused, so never build an app on it.
`note-search` `{q}` searches the typed text, handwriting, photos and `#tags` of THIS app's PANote
notebooks (`data/<slug>/**/*.json`, indexed and transcribed on the node, nothing leaves it) →
`{ok:true, hits:[{path, scope, page, where, snippet, score, boxes}], truncated, terms, pending, ocr, reason?}`: `path` is
the bare app-relative file, `scope` the key the notebook sits under (`''` at the root; the Bible's
`draws` key), `where` is `tag`, `typed`, `ink` or `photo`, `boxes` the page rectangles `[x,y,w,h]`
(in page widths, origin top-left) of the handwriting / photo lines that hold the query, `terms` the
query tokens as matched, `pending` the pages still being
transcribed, `ocr` `ready` | `building` | `failed` (with `reason`) | `unavailable` (no Mac node). Apps do not call it:
`PANote.search(q)` does, and the shared drawer uses it for any row that carries `doc:{path, scope}`;
a hit row's click hands `{page, boxes, terms}` to the row's `onOpen` as a second argument, and the
host passes it to `pad.reveal(at)` after its reload (docs/plans/note-search.md, ADR 0023).
`note-text` `{paths?, scope?, fields?}` reads the same index without a query: one record per PAGE
of THIS app's notebooks → `{ok:true, pages:[{path, scope, page, pending, error?, tags?, src?, labels?,
boxes?, important?}], truncated, pending, ocr, reason?}`. `paths` names the files (none = every file), `scope`
a notebook key (absent = any), `fields` which of `tags` (the default; it answers `typedTags` beside it — the
tags of the typed text alone, what the drawer's strip shows), `src` (`{typed, ink, photo}`
— the transcript), `labels` (picture labels), `boxes` and `important` (the lines the owner MARKED —
highlighter ink over them, a pen circle around them, or a T-mode text highlight — as text, typed runs
first then handwriting top to bottom; lib/note-emphasis.mjs, index record `imp`) to carry; `pending` on a page = its ink or
photo is still being transcribed, `error` = why that page's transcription failed. Nothing is ever
written to a note (ADR 0023). Apps do not call it: PANoteText (the Transcript row in PANote's page
settings) and the drawer's tag chips (`#tag` strip under its search box) do (docs/plans/note-features.md).
The shared drawer（笔记列表）, `PAChat.listDrawer(opts)`, owns its header and its grouping: the header is
＋, `Summarize · 总结` (with `summary` hooks) and ONE ⋯ sheet (Sort / Select / Refresh / Show hidden);
the plain list is grouped `★ Bookmarked · 收藏` (rows with `pin:true`), `Summaries · 总结` (the `#summary`
tag, a row's `summary:true`, or a saved summary's title), then one collapsible group per month with a
jump strip of years and months under the search box; a search stays flat. A row may carry `summary:true`
to land in the Summaries group without a tag. The collapsed state, the hidden strip tags and the sort order
live in THIS app's prefs (`app-settings` / `set-app-settings`: `noteSort`, `noteGroups`, `hiddenTags`) —
the drawer merges into the object the shell answered, so an app that writes its own prefs must do the
same (docs/plans/note-features.md H; web/drawer-groups.inline.html, web/drawer-tags.inline.html).
With `important`, each record also carries `inkImportant` (true when a marked line is handwriting).
`note-page-image` `{path, scope?, page}` renders ONE page's ink of THIS app's notebook to a PNG on the
node (`GET /api/note-page-image`, lib/note-page-image.mjs; same renderer geometry as the OCR bitmap) and
answers `{ok, path, bytes, width, height, cached}` — `path` workspace-relative under `uploads/pages/`,
what a `chat` attachment carries. `{ok:false, code}` (this kind's own codes, not the app data read's `not-found`): `bad_path` (400), `not_found` (404), `no_ink` /
`render_failed` (422). Apps do not call it: a period summary does (PASummaryImages, ADR 0027).
`summary-followup` `{text}` posts a summary's answer text (`POST /api/summary-followup`,
lib/summary-followup.mjs): the node extracts the list under `Open to-dos · 待办`, researches the
questions about the world (lib/research.mjs, both keys needed, at most 5) and asks the fast lane one
line for the personal ones → `{ok, heading, text, items:[{item, kind, ok}], partial, researched, suggested}`.
ONLY the to-do lines reach the search engine. Apps do not call it: PASummaryFollowup does after a
summary is saved (ADR 0027).

Contracts that have bitten before:
- A `'message'` listener receives the EVENT; the reply is `e.data`. `m => m.pa === 'res'` on the
  event is never true, and the app waits for ever (Matrix Conf, 2026-10-28). Use `PA.req`.
- `render-md` takes **`text`**, not `markdown`. Wrong field = empty reply = raw markdown.
- A failure is `{ok:false, code, error, text}` — show `text`; it is already bilingual.
  Never invent your own wording for a failure the shell already rendered.
- Keep a streaming handler alive until `done`:
  `if(m.pa==='res'&&_wait[m.id]){ const keep=m.ev&&!m.done; _wait[m.id](m); if(!keep) delete _wait[m.id]; }`
- `save-data` paths are auto-namespaced; use bare names (`todos.json`, `notes/x.json`), never
  `../`, and no part may start with a dot (`.x.json`, `./x.json` are refused). A `.md` file is
  saved too, with `data` the text itself (ADR 0014): a plain ASCII name, never `CLAUDE.md`,
  `AGENTS.md` or another agent instruction file. An app's agent writes no file at all (ADR 0019),
  so never ask it to: save through `save-data`.
- `save-data` names its payload for the failure sentence: send `what:'data'` unless it is a
  PANote notebook. With no `what` the shell calls it a note ("Note not saved", "Note too
  large"). PAStore sends it.
- `chat-cancel` names the chat to stop as **`chatId`** (that chat's broker id) — `id` is the
  cancel's own. `PAChat.complete(message, {signal})` sends it for you when the signal aborts.
- `PAChat.lane()` → `{id, label}` of the lane the NEXT turn will use (the chooser's pick), for a
  component that must say so before sending. Period summaries（按时期总结）: a drawer host passes
  `summary:{run({scope,label,message}), monthSummary?(period, title), saveNote({id?,title,html,period,scope,convoId,quiet?})}`
  in its listDrawer / chat opts and the multi-select bar gains `Summarize · 总结`. `saveNote` is
  called by the component itself when the summary turn's answer has streamed (auto-save) and on
  the `Save as note` tap. Without `id` it must create a NEW note (every run is kept, owner 2026-11-12;
  a blank page: `template:'plain'`, no stationery design); with `id` (the one its first save answered: the
  re-tap and the follow-up) it updates exactly that note, or answers `{ok:false, gone:true}` when it was
  deleted (said, nothing created). It answers `{ok, id}` with the note's row id — the
  `← Back to summary · 返回总结` pill returns to it through `onLink`. The host's open after a save
  or a link must leave the Ask AI rail as it is (never open the note's own chat from it). The title
  is `PASummaryTitle.runTitleOf(period, run time)` (`This week · 本周 Nov 9–15, 2026 · 11/12 14:52`)
  (web/drawer-summary.inline.html; docs/plans/note-features.md E). No new broker kind: the text is a
  `note-text` ask, the turns are ordinary `chat` turns. The turn numbers the notes `[1]`, `[2]`, …
  with their `Important · 重点` lines; the hook `onLink({id,page})` opens a note a `[n]` link names
  (`?note=<id>&page=<p>`, ADR 0025 — PASummaryRefs, web/summary-refs.inline.html, links the `[n]` in
  the rail and in the saved note as `[n] <title> · <day>` and intercepts the tap). Without it no link
  is written: `[n]` stays plain text in the rail and in the saved note.
  `run` also receives `images` (`[{name,path}]`, the pages with marked handwriting rendered by the
  node) and `model` (the first vision-capable agent lane, else the current one): pass both to
  `chat.send(message, {attachments: images, model})` so the turn SEES the pages (ADR 0027). After the
  auto-save the component asks the node for a follow-up on the summary's open to-dos and calls
  `saveNote` once more, with that run's `id` and `quiet:true`, the block appended under `Follow-up · 跟进`; a status line under the
  answer says researching → added / partial / none / failed.

Use the raw broker for a genuinely custom UI. If you are about to write a chat log, a
markdown renderer, a model picker or a notepad canvas, stop — that component exists.

## Versions and self-update（版本与自动更新）— ADR 0026
- **Version scheme.** `v<package.json version>+<N>`, N = merge commits on main since the newest
  release (`releaseBase()` in `lib/version-auto.mjs`: the newest version-notes entry's `through`,
  else the newest tag). Ship flow bumps it: `node tools/bump-version.mjs` then commit
  `release: vX.Y.Z` (ADR 0038); deploy-vm.sh and pre-push refuse while merges are unreleased. N = 0 shows the plain tag version. The
  Release Notes sheet lists `v5.0.0+N` first, badged `auto · 自动`, with the merge titles as items;
  the curated tag entries follow. Cached by HEAD, so a merge shows without a restart.
- **`GET /api/build`** → `{build, version}` (`no-store`, unauthenticated like the shell page, which
  already carries both strings). `version` is the footer's text: `v5.0.0+N · <sha> · note <blob>`.
- **Self-update.** The shell (`web/update.js`, PAUpdate) asks `/api/build` when the page becomes
  visible and every 15 min while visible. A different version reloads the page at once (the open app
  is reopened after boot) when the open app answers PABusy idle; otherwise ↺ lights and one line
  says `Update ready · 有新版本 — tap to reload`. HTML answers `cache-control: no-cache`, so every
  reload asks the server; JSON stays `no-store`.

## Offline-first（离线优先）— docs/plans/offline-first.md
- **Apps need no change.** Everything offline lives in the shell: the service worker (`web/sw.js`,
  network-first for HTML, never cache-first; `cache:'no-store'` is never cached), the versioned
  bundle `pa-<build>` (shell + the app pages in config `offline.apps` + the Bible corpus under
  `offline.bible_cap_bytes`), the IndexedDB write queue and warm set (`web/offline-client.js`
  PAOffline, broker kinds `data`/`save-data`), the drain with rule A per-page merge
  (`web/offline-sync.js`, `web/offline-merge.js`). Kinds that need the node answer
  `{ok:false, code:'offline', text:'Needs the home node · 需要家中节点'}` — show `text`.
- **One state line** (`#offLine`): `Offline · 离线 — saving on this device · 保存在本设备 · N to sync`,
  `Syncing · 同步中`, `Sync failed · 同步失败 — <sentence> · tap to retry`, `Home node · 家中节点`.
- **Home-node fallback** (`web/offline-origin.js` PAOrigin, lib/local-origin.mjs): config
  `local_origin` (Node settings, no restart) + `public_base_url`. When the public name fails
  `/api/build` and the local name answers the SAME build, the broker's `api()` base (`API_BASE`)
  switches there for the session with the same Bearer; the node answers CORS only for that pairing.
  PAUpdate never follows the switch (a reload must fetch the shell from the public name).

## iOS web app rules (learned the hard way, 2026-08)
- NEVER use apple-mobile-web-app-status-bar-style "black-translucent" — iOS sizes
  the standalone viewport short by the top inset, leaving an unfixable bottom band.
  Use "default" + theme-color metas (dark and light). Changing this requires users
  to delete and re-add the home-screen icon.
- Never hardcode px clearance for floating bars: measure with ResizeObserver into a
  CSS variable; use env(safe-area-inset-*) for device insets.
- Layout mystery on a device? Have the user triple-tap 管家 for the geometry overlay
  and read the numbers before changing any CSS.

## Node operation: Claude sign-in（节点运行：Claude 登录）

The node runs Claude Code headless on the owner's sign-in. When that sign-in expires, every Claude
turn fails with "Failed to authenticate … 401". Three things catch it (docs/adr/0024):

- **Token file** — `config.json` key `claude_token_file` (default `claude-token` in the node root,
  gitignored). Read at every spawn, so renewing it needs no restart. Owner commands, on the node:
  `claude setup-token` (prints a long-lived token), then write it with a hidden read prompt so it
  never lands in the shell history: `read -s TOK && printf '%s\n' "$TOK" > claude-token && unset TOK`,
  then `chmod 600 claude-token`. An absent or empty file means the Keychain login as before.
- **Watchdog** — `claude-auth.json` in the node root (gitignored) records a sign-in failure a chat
  turn or the daily `model-check` job met. The job briefs the owner once per episode (the briefing
  and its email), with the fix: `claude auth login` or renew the token file. It says "works again"
  once when a probe answers.
- **Codex fallback** — while the sign-in is expired, a conversation turn on the Claude lane is
  answered by the GPT (Codex) lane with the same prompt, and the reply starts with
  "Answered by GPT (Codex) because the Claude sign-in on the node expired". That turn's text goes to
  OpenAI instead of Anthropic. A one-shot component request is not redirected; it shows the
  sign-in line. No Codex lane in `chat_models` → the sign-in line.
