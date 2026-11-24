# 0040. 改这个应用 · Change this app: one shared panel, server-written edits

Date: 2026-11-24. Status: accepted; Phase 1 built (owner panel). Plan: docs/plans/change-this-app.md.

## Context
Owner decisions (2026-11-24): every user can change their own copy of an app
from inside it, as an advanced ⋯ / long-press entry, through one shared
PAChat panel, with an auto screenshot. Non-owners must never touch other
apps, data/ or the server. ADR 0019 showed an agent path jail still lets the
agent plant CLAUDE.md/AGENTS.md that later runs obey.

## Decision
1. Entry: ⋯ menu + long-press on the app title; never a permanent button.
2. Panel: the shared PAChat in a shell-owned sandboxed iframe, docked beside
   the app (side panel / bottom sheet). Own convoTag per app.
3. Screenshot: the app captures itself in its iframe with a shared inlined
   PA_SNAP component (DOM → SVG foreignObject → canvas; ink canvases copied;
   PANote via printPage). The shell cannot read the opaque-origin iframe.
   Fails closed to manual attach. No server-side render.
4. Non-owner edits use the demo-style no-tools lane: the model returns one
   file, the server writes fixed names in the caller's own apps/<slug>/.
   No agent jail. Claude/Ollama only, never Codex. consumeAiCall per turn.
5. Owner uses the full agent. "Change superelf itself" is owner-only, decided
   by server role.
6. Per-app version history in lib/app-versions.mjs (moved from sharedapps,
   R3); undo = rollback.
7. Member PRs (own token/fork) never auto-merge; only the owner path of
   ADR 0039 merges.

## Consequences
- Safe by construction for non-owners: no tools, fixed paths, own workspace.
- Non-owner edits are whole-file rewrites: slower and limited by output size.
- Screenshot fidelity on iPad Safari is unproven; needs a real device check.
- ADR 0039 wording "member can edit an app they share" must become "their own
  copy"; the shared ⋯ menu order must be agreed.

## Phase 1 as built (2026-11-24)
- Owner only. The panel is web/app-edit-panel.html (served at /api/app-edit/panel, owner only), loaded
  by web/app-edit.js into its own sandboxed iframe. The broker knows it by its window (fr.edit) and
  gives it the chat kinds only. Its chat goes to /api/chat with `edit:<slug>` and no app-origin header;
  lib/app-edit.mjs appEditOf refuses it for a member, for a request carrying the header or an app slug,
  and for a slug that is not a real, unlinked own app. Tag 'app-edit:<slug>' (lib/agent-origin.mjs).
- Entry: the open app's new ⋯ (#fmore, owner + own app only): 改这个应用 first, then 发布 · Publish;
  the drawer row ⋯ in the same order; long-press on the shell title; long-press on PAAppBar's ← Home
  for own-bar apps. One-time tip: a line under the item until tapped (the Publish item's pattern).
- PA_SNAP is web/snap.inline.html, on every app page. Canvases are copied as images (ink shows), so
  PANote's printPage path was not needed. A blank picture counts as a failure (R14).
- Undo history: <workspace>/.app-versions/<slug>/, last 20, lib/app-versions.mjs. A typed "undo"/撤销
  is done by the server with no model.
- Inline checks (lib/app-edit.mjs editChecks): index.html present, non-empty, under 5 MB, no <form>
  (app-postcheck), every classic inline script compiles, meta.json parses, data/<slug>/*.json parse.
  Only problems the change introduced block it; a blocked change is rolled back at once.
  "Loads headless" is approximated by the script compile: the node has no browser (docs/TODO.md).
- Not built here: Phase 2 (members/guests), Phase 3 (member PRs), the nightly review and Review now.

## Addendum 2026-11-24 — "what changed?" · 这个应用改了什么

Owner screenshots: the panel said it had no change history (it has 20 saved versions), and an app's
own chat invented a per-app "What's new" list. Both now get read-only FACTS on their system line,
built by `lib/app-history.mjs` and marked as data, not instructions:

- **Change this app**: the saved versions (time, size, and the request that caused each change, now
  stored in `<versions>/<slug>/.requests.json`), a bounded diff of the newest three changes, and the
  release-notes and git lines that name the app. Owner-only, as before; read from the turn's own workspace.
- **An app's own chat**: title, version, page date and the same release-notes lines, plus
  `APP_CHAT_EVIDENCE_RULE` (one constant): never name UI it has no evidence for; point to the release
  notes (version line on home) or ⋯ → 改这个应用.

Skipped: a "历史 · History" list with Undo-to-this in the panel header. Undo today walks back one
edit and keeps what it replaced; restoring an arbitrary version needs its own route and an undo
story for the versions it skips, which is not cheap. The agent can already read and compare any
saved copy. Noted in docs/TODO.md.

## Follow-up (2026-11-24): an app's chat never claims a change

Owner report: a demo guest asked Calendar Planner's own chat for day/week/month/year views, said
"yes", and was told "Done — … now has a … view switcher". No app chat can write (an app's agent is
confined and writes nothing; fast lanes and the demo have no tools). `lib/app-chat-honesty.mjs` holds
the fix in one place: `APP_CHAT_NO_CHANGE_RULE` + the real way per person (owner: 改这个应用 under the
reply; member: owner-only for now; demo: ask the main chat, which can build apps), sent outside the
override chain; a `{type:'app-change'}` offer that PAChat shows as a button opening this panel
prefilled (owner only, on a real tap); and a known-limits regex backstop that appends
（此对话不能修改应用 · This chat can't change the app） to a reply that still claims a change. In this
panel, a reply claiming a change on a turn the server saw change nothing gets "The app was not changed".
The fast-lane guard no longer tells app chats to "switch the model selector to Claude": that lane is
confined too.
