# ADR 0010 — The guarded first read (PAStore) is on every app page, with no marker

Status: accepted · 2026-10-12

## Context

- An app's state starts empty or default until its data file is read. Seven apps treated any
  failed or unparseable read as "nothing saved yet", so their next save wrote that empty state
  over the user's file. dd2dac9 and b0c82aa fixed this with one rule:
  - The shell's code `not-found` means a first run.
  - Any other failed read, or a file of the wrong shape, is shown and blocks saves.
  - Saves are also blocked while the read is in flight.
- That rule was then hand-written seven times: family, productivity-hub (live and shelf),
  daily-digest, brainstorm, calendar and rental-hunt. Each copy carried the same
  `TODO(R3)` line. Each copy is a place where the next app can get the rule slightly wrong.
- Shared code reaches a sandboxed app only by serve-time inlining (ADR 0005). PATwoTap set the
  pattern for a component that every app page carries.

## Decision

1. The one copy is `web/store.inline.html`. It defines `PAStore.file(path, opts)`, which returns
   `{load, save, loaded, error}`:
   - `load()` answers `{state:'ok', value}`, `{state:'first'}` or `{state:'failed', text}`. Only
     `not-found` gives `first`.
   - `save(data)` answers `''` once saved. Otherwise it answers why not: the refusal
     (`<reason> — not saved · 未保存`), or the failed save's `text`.
   - The guard is inside `save()`. Until a read has succeeded, nothing is sent, so an app cannot
     forget the check.
   - `opts.shape(d)` returns `''` when the file has the right shape, or a reason when it does not.
2. The words and the display stay with each app:
   - `unreadable(why)`, `failed(text)` and `loading` carry the app's own sentences.
   - Each app puts what `load` and `save` return in its own status line, notice bar or editor.
3. PAStore talks to the broker itself, as PAChat and PASettings do. Its ids are strings (`'pas1'`…).
   An app's ids are numbers, so neither side's listener can resolve the other's request.
4. It is a `PA_COMPONENTS` entry (marker `<!--PA_STORE_UI-->`). `sendAppHtml` places that marker
   on every app page, right after PATwoTap, before the page's first script. No app writes it.

## Options not taken

- **A marker in each app.** Rejected for the same reasons as in ADR 0005.
- **Take the app's own broker function as an option.** The seven apps had five different clients
  (`paData`, `brok`, `pa`, `paLoad`, `paLoadData`), and Daily Digest's `pa` throws on failure
  instead of answering. The component would depend on each one's reply shape.
- **Keep the app's state inside the store.** Each app assigns its own state differently
  (`members = …`, `Object.assign(state, …)`, `r.value.posts`), so this would mean rewriting each
  app, not moving its guard.
- **Move Allergy, Diabetes and the PANote apps too.** Allergy does not block saves on purpose:
  each check replaces `pollen.json` whole. Diabetes and PANote have their own load contracts,
  with more states, pinned by their own tests.

## Consequences

- A test that runs an app's script must run PATwoTap and then PAStore first, as the browser does.
  `test/helpers-app.mjs` `servedScriptOf` does that.
- The sandbox harness (`test/helpers-sandbox-app.mjs` `boot`) now delivers each reply to every
  `message` listener, as a browser does. It used to keep only the last listener, which would have
  left PAStore's listener without replies.
- `test/store.test.mjs` runs the component on its own. It also checks every committed page as a
  real web.mjs serves it, and that each app rejects a wrong-shaped file in its own words.
- `test/two-tap.test.mjs` changed in two ways. Its served check runs all of a page's scripts in
  order, because PAStore now sits between PATwoTap and the page's own script. Its sweep of
  committed pages moved to `test/helpers-every-page.mjs`, which both tests use.
- `test/app-read-guard*.test.mjs` (53 flows) are unchanged, and they pass. (Superseded: see the
  follow-up below.)
- With the real shell, behaviour is unchanged. The differences below appear only when a reply
  has no `text`. The real shell always adds `text` (`relayFail` in web/index.html). The test relay
  sends only `error`. (Superseded: see the follow-up.)
  - Follow-up, 2026-10-12 (found by the R13 review of this change): the test relay
    (`test/helpers-app.mjs` makeRelay) now runs the shell's whole broker
    (`test/helpers-shell-broker.mjs`) for data, save-data and notes-list (bible and bible-search
    reach the test server's 404), so every app-level flow gets `text` as a user does. The
    failed-read flows (Tasks included) and the failed-save flows now assert the shell's sentence
    (`… Content not loaded · 未加载`, `… Note not saved · 未保存`).
    The no-`text` cases below are reached only by `test/store.test.mjs`'s own broker.
  1. A save failure without `text` now reads `Save failed · 保存失败: <error>` in every app. These
     are Daily Digest's words, the only app that had any for this case. The other six showed the
     bare error.
  2. A read failure with neither `text` nor `error` is now `Not loaded · 未加载`, and saves are
     refused with it:
     - Family, Productivity Hub, Brainstorm, Calendar and Rental Hunt set their error to
       `undefined`, which set `loaded` to true and let saves through.
     - Daily Digest showed `主题未能读取 · Topics not loaded: err`. It now ends `: Not loaded · 未加载`.
  3. A save failure with neither `text` nor `error` is now `Save failed · 保存失败: <code>`:
     - Calendar said "Saved.".
     - Family, Productivity Hub, Brainstorm and Rental Hunt showed an empty status line. (Hub's
       import already said "Import not saved", and still does.)
     - Daily Digest showed `Save failed · 保存失败: err`.
- Visible behaviour that stays the same:
  - Productivity Hub shows "saving" only for a save PAStore will send, and it builds its payload
    only then. This matches the old order. To know this, the hub reads `hubFile.loaded` itself; if
    PAStore ever gains another reason to refuse, the hub must learn it too.
  - Daily Digest's editor save now copies the editor's fields before PAStore refuses the save.
    The user cannot see this: the editor opens only after the topics have loaded, and they are
    never unloaded.
- Calendar no longer have their own broker client, because nothing else in them used one.
- Every app shrank. Lines: family 630→619, productivity-hub 1300→1286, daily-digest 287→286,
  brainstorm 383→372, calendar 295→273, rental-hunt 856→833.

## Tasks — `parse` and `write` (amendment, 2026-10-12)

Superseded in part by ADR 0014: Tasks now saves `tasks.md` through `save-data`, which writes an app's
own `.md`. It no longer asks its agent, and PAStore's `write` option is removed. The read guard below
is unchanged.

### Context

- Tasks read `tasks.md` itself. On any failed read, including a first run's `not-found`, it showed
  "Could not load tasks." and left its list empty. The add bar is outside the list, so it still
  worked: one added task was then saved as the whole file, over the user's list. A task added
  while the read was in flight did the same.
- Two things kept Tasks off PAStore:
  - `tasks.md` is markdown. `load()` ran `JSON.parse`, so every real list would read as unreadable.
  - The list is not saved through `save-data`. `save-data` writes only `.json` paths
    (`lib/appdata.mjs` `appDataFile`, and the relay checks the same). Tasks asks its agent to write the file, through
    kind `ask`. ADR 0002 allows this: the agent is confined to `data/tasks/`.

### Decision

1. `PAStore.file` takes two more options. Their defaults keep every other app as it was.
   - `parse(text)` turns the read's text into the value that `shape` checks. Default `JSON.parse`.
   - `write(data)` returns the broker request that saves. Default `{kind:'save-data', path, data}`.
2. The guard does not change, and it stays inside `save()`. Whichever request `write` returns is
   sent only after a good read or a first run.
3. Tasks uses `parse: (text) => text`, `shape`: the value must be a string, and a `write` that
   returns its `ask` with `what: 'data'`, so a failure the shell words reads "Data … not saved",
   not "Message … not sent". Its read failure goes in the list area. A refusal or a failed save
   goes in its status line, and a failure stays there: only "Saved ✓" clears after 2 s, and the
   next save cancels that clear.
4. The add box and button start disabled and come on only after a good read or a first run.
5. The face (`face.json`) is written on load only after a good read or a first run. On a save it
   is written only when PAStore will send that save. A list that was never read has no count.
   - It is still written before the save's reply, as before. The agent can take minutes, and
     leaving the app blanks its frame, so a face written on the reply would often never be written.
     After a failed save the tile can count a task that is not in the file. The next load corrects it.
   - To know whether the save will be sent, Tasks reads `tasksFile.loaded` itself, as Productivity
     Hub does. If PAStore ever gains another reason to refuse, Tasks must learn it too.

### Options not taken

- **Gate `save()` in the app on `loaded`, and keep its own `ask`.** The refusal's words would then
  live in a second place (R3), and the check would sit outside `save()`. That is what this ADR set
  out to stop.
- **Move the list to `save-data`.** It would have to become JSON, and it would no longer be the
  markdown file the assistant and the user edit.

### Consequences

- Gaps this fix leaves as they were:
  - An `ask` that answers `ok` counts as saved. An agent that answers `ok` without writing the
    file is not detected.
  - Every save writes the list as this page holds it. An edit made to `tasks.md` since the page
    read it, by the assistant or by hand, is overwritten.
  - (Fixed since: see "Follow-up: a change made while a save is out" below.) A change made while a
    save was in flight was dropped by the `saving` check in `save()`.
- Tasks no longer has its own `data` and `ask` clients. `paSaveData` stays, for the face only.
- `test/app-read-guard-tasks.test.mjs` runs seven flows (nine since the follow-up below) on both the
  owner's copy and the template.
  Reads and the face go through the shell's relay as pinned in `test/helpers-app.mjs` (it has no
  `relayFail`, so no `what` wording) to a real server. The `ask` goes to an agent played by the
  test, which stands in for both the relay and `/api/ask`:
  - a failed read;
  - a reply with no text;
  - a save while the read is in flight;
  - a first run;
  - a good read;
  - a failed save;
  - a failed save after a success.
- `test/store.test.mjs` runs `parse` and `write` on the component alone.

### Follow-up: a change made while a save is out (2026-10-12)

- The bug. A save is an `ask` to the agent and takes seconds, sometimes minutes. `save()` began with
  `if(saving){ setStatus('Saving…'); return; }`. A toggle, edit, delete or add made in that time
  showed on screen but was never sent. The first save's reply then said "Saved ✓", and a reload lost
  the change. Found by reading the code while fixing the read guard above.
- The fix. One save is out at a time, as before. A change made meanwhile sets `again`. When the save
  out comes back, `save()` runs once more and sends the list as it is then. Any number of changes
  made meanwhile cost one more save.
  - "Saved ✓" or a failure is shown only for the save sent last. That save carries the whole list,
    so the change of a first save that failed is written by the save after it.
  - The face is still written only for a save PAStore will send: the second save writes it when it
    is sent, with the count then.
- Gaps this fix leaves:
  - A change made while a save is out is sent only when that save is back. If the app is left first
    (leaving blanks its frame), the change is lost, and no face is written for it. The screen said
    "Saving…", not "Saved ✓".
  - A save whose reply is lost in transit (code `network`) may still be running on the server:
    `/api/ask` does not stop the agent when the client goes. The save after it is then sent at once.
    Agents run up to `max_concurrent` at a time (web.mjs `MAX_CONCURRENT`: 3 if unset, 5 in
    `config.example.json`, 1–20 in admin config), a limit shared with chat and jobs. With 2 or more
    free, the two saves can run side by side, and the older one can finish last and leave the older
    list in the file, under "Saved ✓". With 1, the second save waits for the first. Any later save
    had the same race before.
  - The two gaps listed above: an `ok` with no write is not detected, and an edit made to `tasks.md`
    elsewhere since the page read it is overwritten.
- Two more flows in `test/app-read-guard-tasks.test.mjs`, on both copies:
  - a tick and a delete made while a save is held, each through the handler the rendered row carries
    for that task: exactly two asks; the first reply does not say
    "Saved ✓"; `tasks.md` ends with all three changes; three face writes (load and two saves);
  - a save that fails while a tick is made: the save after it writes both the added task and the tick.
- Narrowed by ADR 0014. A save is now one `save-data` round trip, not a model run. The first gap
  above (a change lost when the app is left while a save is out) shrinks to that round trip, and ADR
  0018 (a left page is held while its requests finish) closes it for a save answered within its
  20 s cap: 32 of 32 real Chrome and WebKit
  runs kept the change (2026-10-23, ADR 0014 Consequences). "An
  `ok` with no write" no longer applies: the reply is the server's write. The lost-reply race is far
  narrower: the server writes within the request, before it replies, instead of an agent that keeps
  running for minutes after the client has gone.
