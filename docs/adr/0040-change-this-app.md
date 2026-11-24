# 0040. 改这个应用 · Change this app: one shared panel, server-written edits

Date: 2026-11-24. Status: proposed. Plan: docs/plans/change-this-app.md.

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
