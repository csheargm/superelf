# ADR 0014 — An app saves its own markdown through save-data, not through its agent

Status: accepted · 2026-10-21 (written 2026-10-13, rebuilt on ADR 0016's path rule, rebased on ADR 0018)

## Context

- Tasks saved `tasks.md` by asking its agent to write it (kind `ask`, ADR 0010 "Tasks"). The reason:
  `save-data` wrote only `.json` paths (`lib/appdata.mjs` `appDataFile`, and the shell checked the same).
- So every save was a model run. With Haiku it took 9.3–9.8 s (measured 2026-10-12), and it can take
  up to the 5 min limit.
- A change made while a save was out was sent only when that save came back (ADR 0010 "Tasks",
  follow-up). Leaving the app blanked its frame (before ADR 0018), so a change made in that time was lost.
  Measured 2026-10-13 in a throwaway root, real Chrome and WebKit, real Haiku agent: on `main`,
  adding a task, ticking another and pressing ← Home within ~300 ms lost the tick in every run.
- Sending the change when the app is left could not fix this then: a message the left app posted from
  `pagehide` reached the shell after its frame was `about:blank` (Chrome dropped it; WebKit relayed it
  with no slug). The first save itself always finished: the shell makes the request. ADR 0018
  (2026-10-17) since holds a left page, hidden; once it has answered `left` (or 2 s have passed), it
  is removed after 500 ms with nothing in flight, at most 20 s. So the reply to a save that is out now
  reaches the page, which sends the follow-up (measured 2026-10-23, see Consequences). An agent save
  can outlast that 20 s cap.
- The agent also wrote a string the app already had. An `ok` from an agent that wrote nothing could
  not be detected, and every tick cost a model run.

## Decision

1. `save-data` may write a `.md` file inside an app's own `data/<slug>/`.
   - The file is stored exactly as sent: not JSON-encoded, not trimmed.
   - `data` must be a string. The empty string is allowed: an emptied list is a real user action, and
     the backup covers a mistaken one. Anything else is `400 bad_data`.
   - The size cap, the atomic write and the rolling `.bak` are the same as for JSON. `restore-data`
     restores a markdown backup; only a JSON backup must parse.
2. Where it may go is ADR 0016's one path rule, `lib/appdata.mjs` `appDataFile`, which now also takes
   a `.md` path. On top of everything that rule refuses for JSON (judged decoded: `..` and dot
   segments, backslashes, absolute paths, links, anything outside `data/<slug>/`), a `.md` path must:
   - be namespaced (the two test stand-in servers' `namespace: false` takes no markdown);
   - end in a plain ASCII name: letters, digits, `_`, `-`, and `.` but not first. So no `~` (a Windows
     short name such as `CLAUDE~1.MD` can name `CLAUDE.local.md`), no `:` (a Windows stream), no space;
   - not be a Windows device name before its first dot (`con.md`);
   - not be an instruction file of the CLIs superelf runs (Claude Code, Codex) or of Gemini:
     `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`, in any case.
     Claude Code loads a `CLAUDE.md` from any folder its agent reads in, so `save-data` must not plant
     one. (An app's own agent could until ADR 0019: see Consequences.) Names a CLI takes from its own config
     (Codex `project_doc_fallback_filenames`) are not covered.
   - The shell's own pre-check (`web/index.html`, the `save-data` branch) takes `.json` or `.md`; the
     server's rule decides the rest.
3. Tasks saves through PAStore's default request (`save-data`, `what: 'data'`). PAStore's `write`
   option existed only for Tasks' `ask` (ADR 0010 "Tasks", decision 1), so it is removed.

## Options not taken

- **The server runs one app's asks in order, and Tasks sends every change at once.** The agent would
  keep writing the markdown. Each change would cost one model run (about 10 s), with no coalescing.
- **The shell keeps a left app's frame running until its saves settle.** ADR 0018 later did this for
  every app (`web/app-frame.js`). It does not make an agent save fast, cheap or checkable, and an agent
  save can outlast its 20 s cap, so this ADR is still needed for Tasks.
- **Send the change when the app is left.** Before ADR 0018 it did not reach the server (see Context);
  Tasks has no `pagehide` handler, and with ADR 0018 the held page sends its follow-up anyway.
- **Any text extension, or text anywhere.** A text file at the workspace root, or one named
  `CLAUDE.md`, is an instruction the owner's agent loads.

## Consequences

- A Tasks save is one `save-data` round trip, not a model run. The list leaves the page in the tap
  that changed it, and the shell, which outlives the frame, relays it.
- Measured 2026-10-17 on this change (throwaway root, own `web.mjs`, real Chrome 155 and WebKit, no
  agent): add, tick and ← Home kept both changes in every run, leaving 1–143 ms after the tick; an add
  then ← Home 1–45 ms later landed every time; no `/api/ask` was sent. Paths such as `CLAUDE.md`,
  `%43LAUDE.md`, `CLAUDE~1.md` and `x/%2E%2E/CLAUDE.md`, posted from the Tasks frame, were refused,
  and nothing but the control file was written.
- A change made while a save is out is sent when that save is back (`save()` sends one at a time; two
  out at once could land out of order). Measured 2026-10-17, BEFORE ADR 0018: leaving in that window
  lost it (4 of 4 on localhost; 2 of 2 with replies held 300 ms). Measured 2026-10-23 on main
  7700960, with ADR 0018 (throwaway root, own `web.mjs`, no agent): 32 of 32 runs kept both changes:
  20 in Chrome 155 (8 of them with real keyboard and mouse input) and 12 in WebKit (WKWebView, macOS
  26.6.2). 8 more real-input runs were thrown away because the add never registered (the harness did
  not focus the box: no save was out at the tick), a harness fault, not a loss. A tick 2–20 ms after the add then ← Home at once (16 runs), and a tick
  150–250 ms after the add with each reply held 300 ms then ← Home 50–100 ms later (16 runs). The
  held page answered `left`, received the add's reply and sent the follow-up itself (in 2 of the 16
  slow runs the reply came before ← Home and the page sent it while still shown); it was removed
  500 ms after its last reply. Pinned in the suite by `test/app-leave-tasks.test.mjs` (the
  shell's own broker and app-frame code, a real `web.mjs`, Tasks' requests in its order), with a
  control in the order before ADR 0018 that loses the tick.
- The ADR 0010 "Tasks" gap "an `ok` with no write is not detected" is closed: the reply is the
  server's write.
- Not changed by this ADR:
  - An edit made to `tasks.md` elsewhere since the page read it is overwritten (ADR 0010 "Tasks").
  - An app's agent may still write any name under `data/<slug>/`, `CLAUDE.md` included
    (`lib/agent-origin.mjs` `appWriteRule`, ADR 0002). No app asks its agent to write any more.
    CLOSED SINCE by ADR 0019: an app's agent writes nothing.
- Tests:
  - `test/workspace-write-paths.test.mjs`: `appDataFile` takes `data/<slug>/…/x.md`, and refuses a
    `.md` at the root, outside `data/`, unnamespaced, under a dot directory, encoded (`%43LAUDE.md`),
    as a short name, a stream, a device or a non-plain name, and every instruction file in any case.
  - `test/appdata.test.mjs`: a markdown file stored as sent, backed up and restored; a payload that is
    not text refused.
  - `test/save-data-routes.test.mjs`, against the real `web.mjs`: saved and read back; refused at the
    root, as `CLAUDE.md`, and under `.claude/`, with those files untouched; a non-string refused.
  - `test/app-read-guard-tasks.test.mjs`: every flow saves through `save-data` to the harness's real
    writer and records any `ask` (there is none). A new flow checks the change is sent before the
    tap returns and lands with the app left alone.
  - `test/store.test.mjs`: a markdown file is saved as its text, through `save-data`, behind the guard.
  - `test/app-leave-tasks.test.mjs`: a change made while a save is out survives ← Home through ADR
    0018's held page (the shell's own broker and app-frame code, a real `web.mjs`), with a control in
    the order before ADR 0018 that loses the tick.
