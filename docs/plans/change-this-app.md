# 改这个应用 · Change this app — plan

Status: proposed (2026-11-24). ADR: docs/adr/0040-change-this-app.md.
Base: origin/main 5aa65f0. Publish (owner) is ADR 0039 on feat/publish-app.

## Goal
Any user (owner, member, demo guest) can ask the AI to change THEIR OWN copy
of an app, from inside the app, with a screenshot of what they see. Never
other users' apps, never data/, never the server or shell.

## Scope by entry point (owner confirmed 2026-11-24)
| Entry | Owner | Member / demo guest |
|---|---|---|
| Main chat | All of superelf (shell, server, every mini app), as today | All of their OWN apps; never superelf core |
| In-app panel | That app by default; "change superelf: …" routes to the owner's main agent | That one app only |

The in-app panel never narrows what the owner's main chat can do; it is a focused shortcut with a screenshot attached.

## UI (in words)
- Entry is hidden by default (advanced). It sits in the open app's ⋯ menu and
  on long-press of the app title. A small ⋯ is added to the shell bar
  (#frame .bar); own-bar apps (Bible, Journal) get the same item in PAAppBar's
  menu, which posts {pa:'shell',type:'edit-app'} to the shell.
- Item text: "改这个应用 · Change this app". Order in ⋯: 改这个应用, then
  ADR 0039's 发布 · Publish, then existing items. Agree with feat/publish-app.
- One-time tip via PATips, 中文 first: "长按标题可修改此应用 · Long-press the
  title to change this app".
- Panel: a shell-owned sandboxed iframe running the shared PAChat. Side panel
  on iPad/desktop (app shrinks beside it), bottom sheet on phone. Header shows
  the app name. A screenshot thumbnail is already attached; tap x to remove,
  tap it to mark up with the pen, + to add more. After a change the app
  reloads in place; the reply has one "撤销 · Undo" link ("undo that" works too).

## Phases
### Phase 1 — panel + owner full agent + screenshot
- New module web/app-edit-panel.inline.html (dock, open/close, reload app).
  No growth in web/index.html beyond the mount + TODO seam (R4).
- PAChat mounted in a second sandboxed iframe; same broker. Conversations get
  their own convoTag ('app-edit:<slug>') so they never resume a composer one.
- Screenshot: new shared component PA_SNAP inlined into every app (CSP bars
  <script src>). It clones the app DOM to SVG foreignObject, draws to canvas,
  returns PNG to the shell by postMessage. Canvases (ink) are copied as
  images; PANote pages use the existing printPage PNG path (R3). Fonts and
  images must be inlined (connect-src 'none'). If toDataURL throws (WebKit
  taint), fall back: no auto-shot, user adds a photo/screen capture by hand.
  Server-side headless render is NOT used (loses live state + ink, costly).
- Shot saved via the existing `upload` kind into the user's own uploads/;
  sent only to the lane pickChatLane chooses (check the vision reroute).
- Per-app version history: move archive()/stamp() from lib/sharedapps.mjs to
  lib/app-versions.mjs; archive apps/<slug>/ before each change; "undo" =
  rollback (itself reversible). Owner turns use snapshotApps + app-postcheck.
- Owner's panel runs the full agent, scoped by prompt to the app folder.
  "Change superelf itself" also goes to the owner's main agent.

### Phase 2 — scoped editor lane for members and guests
- Demo-style lane (lib/demo-app.mjs makeDemoApp/writeApp): model has NO
  tools; it returns a whole index.html; the server writes only
  apps/<slug>/index.html (+ meta.json) after slugOk, safeJoin,
  noLinkOnTheWay. No agent path jail (ADR 0019: a jail lets the agent plant
  CLAUDE.md/AGENTS.md). Server refuses dot-files, CLAUDE.md, AGENTS.md.
- Ownership check on the server: the slug must be in the caller's own apps/.
  Shelf apps: fork first (/api/apps/fork), edit only the fork.
- Lane: Claude or Ollama no-tools only, never Codex. Every turn charges
  consumeAiCall; demo caps apply; a size cap on the returned file.
- "Change superelf itself" from a non-owner: refused with a plain note; role
  decided on the server (agentConfined), never from the request wording.
- Members keep plain chat (F4-2) elsewhere; this lane is separate.

### Phase 3 — user Publish as PR
- Members/guests: optional GitHub token + fork in their own Settings (per
  user, not ADR 0039's node-wide github_publish_token). Opens a PR from their
  fork. Such PRs NEVER auto-merge; label "needs-owner-review"; the merge path
  of ADR 0039 refuses any PR not opened by the owner token.
- Same fail-closed privacy scan as ADR 0039 before any PR.
- Owner: ADR 0039 path (merge + deploy). ADR 0039's line "a member can edit an
  app they share" must change to "their own copy".

## Review: fast now, thorough tonight (owner decision 2026-11-24)
Changes happen while the user is using the app and wants the fix at once, so:
1. **Inline (seconds, no AI):** mechanical checks only — app-postcheck, the page loads headless with no errors, its data still reads, size/CSP rules. A change that fails these is not applied (the user is never left with a broken app). No second-model review inline.
2. **Nightly review run:** for every app changed that day (per user), a different model from the editor reviews the day's diffs, the user's requests and the before/after screenshots; finds bugs, regressions, holes; fixes them; re-runs the checks. Fixes of bugs/holes are applied as a new version (undo-able); anything that changes what the user asked for is only proposed. Each user gets a short morning note per app: what was reviewed, what was fixed, one-tap undo. A failed or empty review is reported as failed, never as clean (R14).
3. **Manual trigger:** "审核一下 · Review now" in the panel (or ⋯) runs the same review for that app immediately.
4. **Publish:** the full gate still runs before any merge — CI + gpt-review of the PR diff — and, if the app has unreviewed changes, the review runs first.
Cost: nightly review uses the node's review lane within each user's caps; owner can set the schedule or turn it off per node.

## Threat model
- Prompt injection from app content: the app's HTML and the screenshot are
  data. Phase 2 model has no tools, so injected text can at most produce a bad
  index.html for that user's own app; undo restores it. Output still passes
  app-postcheck and the CSP sandbox (opaque origin, connect-src 'none').
- Path escape: server writes fixed names only, after slugOk/safeJoin/link
  checks; no client-supplied paths. Tests try '..', symlinks, other uids.
- Cross-user: slug resolved inside the caller's own workspace only.
- Planted instruction files: none can be written (fixed file names).
- Cost: consumeAiCall per turn, max shots per turn (3), max PNG size (2 MB),
  max output size; the panel cannot loop.
- Privacy: shot only of the user's own app frame, stored in their uploads/,
  sent only to their lane. Phase 3 PRs pass the privacy scan.
- Tokens: member GitHub tokens stored per user, never shown back, never used
  for merge.

## Tests
- Phase 1: unit — app-versions archive/rollback, convoTag isolation, PA_SNAP
  returns PNG / fails closed. e2e (chromium + webkit): long-press title → panel
  docks → shot attached → owner change → app reloads → undo restores; tip
  shows once; own-bar app entry works; phone bottom sheet.
- Phase 2: unit — write refuses other user's slug, '..', symlink, dot-files,
  CLAUDE.md; cap charged; Codex never chosen. e2e — member and demo guest edit
  own app, cannot edit another's, "change superelf" refused.
- Phase 3: unit — member PR never merges; owner-only merge; scan blocks
  private data. e2e with a fake GitHub server.
- Real iPad check of PA_SNAP (taint, fonts, ink) before Phase 1 is called done.

## Needs the owner
1. Agree ⋯ order/wording with ADR 0039 (proposal above).
2. Real iPad test of screenshots.
3. OK for Phase 3 per-user GitHub token storage.
4. Merge order: ADR 0039 first, this rebases on it.
