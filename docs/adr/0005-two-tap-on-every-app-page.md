# ADR 0005 — The two-tap button (PATwoTap) is on every app page, with no marker

Status: accepted · 2026-10-12

## Context

- Apps run under CSP `sandbox allow-scripts` without `allow-modals`. `confirm()` returns false at
  once, so a destructive action asks in place: the first tap arms the button, a second tap acts.
- That two-tap logic existed as five hand-written copies: badminton (since deleted), diabetes
  (live + template), family, productivity-hub (live + shelf) and the stationery picker. Each was
  marked R3 debt.
- Apps are single `index.html` files. The sandbox CSP has no `'self'` in `script-src`, so an app
  cannot load a shared script file. Shared code reaches an app in only two ways:
  1. A component marker (`<!--PA_CHAT_UI-->` and others). `sendAppHtml` inlines the component's
     file wherever its marker appears. The app must write the marker.
  2. `PA_PREFS_SNIPPET`, which `sendAppHtml` adds to EVERY app page, before `</body>`.
- Family, productivity-hub and diabetes mounted no component. The stationery picker is itself a
  component, inlined into the notes app.

## Decision

1. The one copy is `web/two-tap.inline.html`. It defines `PATwoTap`:
   - `press(btn, {label, ms})` for one button;
   - `disarm(btn)` for a button reused across rows;
   - `rows(ms)` for a list that re-renders, where the renderer reads `asking(key)`.
2. It is an ordinary `PA_COMPONENTS` entry (marker `<!--PA_TWO_TAP_UI-->`), so the page cache key
   (`appStamp`) covers it with no new code.
3. No app writes that marker. `sendAppHtml` inserts it on every app page, before the first
   `<script` or `</head>`, whichever comes first. The component therefore runs before the app's
   own script, and an app may use it at top level (diabetes builds its `rows()` arm there).
4. A page with neither `</head>` nor `<script` gets nothing; it has no script to use it. The
   marker never goes before the doctype, which would put the page in quirks mode.

## Options not taken

- **A marker in each app.** This needs one edit per app and per future app, and two markers on
  one page would inline two copies. The file is about 3 KB, small enough for every page to carry.
- **Inside `PA_PREFS_SNIPPET`.** That snippet is a string inside web.mjs, which a test cannot run
  on its own. It is also placed before `</body>`, after the app's script, so a top-level use
  would fail.

## Consequences

- A test that RUNS an app's script must run PATwoTap first, as the browser does.
  `test/helpers-app.mjs` exports `servedScriptOf(html)` for that. `scriptOf(html)` stays the
  app's own code, for scans.
- `test/two-tap.test.mjs` runs the component, and it checks every committed app page served by
  a real web.mjs. `test/sandbox-modal-flows.test.mjs` runs each app's flow through it.
- Behaviour is unchanged except in the stationery picker. Before, a FAILED template delete left
  its ✕ armed with no expiry, so the next tap deleted at once. Now the ✕ disarms when it acts,
  as the other copies did, so a retry asks again.
