# ADR 0026 — Clients update themselves; the version counts merges

Date: 2026-11-11 · Status: accepted (branch auto-update)

## Context

The shell runs on iPads as a home-screen standalone page that stays alive for days. After a merge
the node served new code, but every open page kept running the old one until someone remembered to
tap ↺ on the home page — the owner asked how clients "make sure they are always running the latest
code". Meanwhile the Release Notes sheet still said `v5.0.0 · current` (tagged 2026-10-12) after
some thirty merges, because the version only moves when someone bumps and tags, and nobody does
that per merge: the sheet was wrong for a month.

## Decision

1. **The version names itself: `v<package>+<N>`.** N = first-parent merge commits on HEAD since
   the newest tag (`lib/version-auto.mjs`). ONE function computes it; the shell footer
   (`appVersion`) and the sheet's automatic entry (`lib/vernotes.mjs`) both read it. The entry's
   items are the merge titles (the `Merge: ` head and the `(branch …)` tail stripped), newest
   first, dated from the newest merge, badged `auto · 自动`. Cached by HEAD — the TTL'd HEAD that
   `lib/buildid.mjs` already reads — so a merge shows on the next page load with no restart.
   Why not tags: a tag is a human act, and the scar is exactly that it does not happen. The tag
   stays the curated milestone; `+N` is the truth between milestones. `version-notes.json` is
   untouched.
2. **The shell polls `/api/build`** (`web/update.js`, PAUpdate) on `visibilitychange → visible`
   and every 15 min while visible, and compares `version` with the footer it loaded with — the
   footer is the ONE place the server writes that string. A mismatch reloads the page at once
   when safe, remembering the open app in sessionStorage (next to ↺'s own `pa_refreshing`) and
   reopening it after boot. When not safe, ↺ lights and one line outside the inert header says
   `Update ready · 有新版本 — tap to reload`; the tap reloads the same way.
3. **Safe = the open app says so.** The shell posts `{kind:'pa-busy?'}` to the open iframe;
   `web/busy.inline.html` (PABusy, on every app page after PA) answers `{kind:'pa-busy', busy}`
   from registered watchers. PANote registers its save guard's `unsaved` (dirty, in flight or
   failed), PAChat a streaming turn — one line each. No answer within 500 ms, a watcher that
   throws, or a window that cannot be posted to all count as busy (fail closed, R14). No open app
   means nothing to lose.
4. **HTML is `cache-control: no-cache`**, JSON stays `no-store`. `sendHtml()` is the existing
   source of the header — every `text/html` answer already goes through it with its ETag, and
   `send()` does not repeat it (R3). A reload that a browser answers from its heuristic cache would
   "update" to the same old page; `no-cache` makes every load revalidate against that ETag.
5. **No service worker.** A service worker is a second deployment surface with its own cache,
   its own update dance (install → waiting → skipWaiting → clients.claim) and a reputation for
   serving stale shells for exactly the users this is meant to help; it also cannot know whether
   a sandboxed app has unsaved strokes. A 15-minute poll from the page that is already running,
   plus a server that never lets HTML be cached, does the whole job with ~80 lines and no new
   lifecycle.

## Consequences

- `GET /api/build` is unauthenticated, like `/` which already embeds the same two strings; it
  carries nothing else.
- An app that holds its own unsaved state and does not use PANote/PAChat should call
  `PABusy.watch(() => dirty)`; until it does, the shell may reload it between its saves. Apps
  save through the broker on every change today, so the window is a debounce, not a session.
- The automatic entry's items are merge titles, so a merge commit's subject is now user-facing
  text; the merge script already writes them bilingually.
- Left out (docs/TODO.md): a reload while the chat rail's OWN stream (the shell's main chat, not
  an app) is running is not guarded — the shell's own rail is not an iframe and the owner's
  question was about apps; the poll does not back off when the node is down.
