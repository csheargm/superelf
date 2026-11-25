# 一个应用一个对话 · Unified app chat — plan

Status: Phases A + B built 2026-11-24 (lib/app-edit-confirm.mjs, lib/app-edit-lane.mjs). As built:
- The confirm id travels as the Apply turn's own message (「改 · Apply (<id>)」), so no new body field; the
  server parses, consumes (single use, user + app + plan bound, 10 min) and only then may the turn write.
- An unconfirmed turn that writes anyway is rolled back (finishAppEdit `unconfirmed`), said in the reply.
- Members: the no-tools lane is Claude (--tools=), or an Ollama model only when the user picked one.
- Not built (docs/TODO.md): generic apps' in-page Ask AI → panel (the shell hook {pa:'shell',type:'app-chat'}
  exists; apps must call it), shelf fork-first in the panel, the demo panel (demo guests keep the app maker's
  change path with its caps), one convo tag shared with the in-page chat. ADR: docs/adr/0042-unified-app-chat.md.
Builds on ADR 0040 (Change this app), lib/app-history.mjs (app change history) and
lib/app-chat-honesty.mjs (honest app chat). Owner request: ONE chat per app that both answers
questions and changes the app.

## Today (read from origin/main, v5.12.2)
- Two chats per app. (a) The app's own 问 AI · Ask AI: PAChat inside the app page
  (web/chat-ui.inline.html `fullscreen`), request carries the app-origin header, confined, writes
  nothing; lib/app-chat-honesty.mjs adds the no-change rule, the regex backstop and a
  `{type:'app-change'}` offer button that opens (b). (b) 改这个应用 · Change this app: a second PAChat in
  a shell-owned sandboxed iframe (web/app-edit-panel.html via web/app-edit.js), `edit:<slug>`, no
  app-origin header, owner only (lib/app-edit.mjs appEditOf), full agent, snapshot → checks →
  rollback/undo (lib/app-versions.mjs), history facts (lib/app-history.mjs).
- Result: two conversations, two greetings, an offer hop between them, and the user must know which
  one can write.

## Decision in one line
The shell's panel (b) becomes THE app chat. The app's Ask AI entry opens that panel instead of an
in-page chat; ⋯ → 改这个应用 opens the same panel in change mode. The in-page chat (a) stays only
for apps whose Ask AI is part of the app's own content (Bible explain, Journal summaries, notes) —
those keep their scoped rails; their "change the app" offer opens the same panel.

## Behaviour
1. Question → answer. No snapshot, no write, no confirm. Read-only facts (app-history) on the system line.
2. Change request → the AI states in one or two lines what it will do (plan, files = apps/<slug>/ only)
   and the reply ends with a `{type:'app-change-confirm', id}` line. PAChat shows ONE button
   「改 · Apply」 under it (a second tap on anything else = not confirmed). No write happens before the tap.
3. Tap → server turn with `edit:<slug>` + `confirm:<id>` (id bound server-side to the stated plan,
   the user and the slug, single use, 10 min TTL). Screenshot (PA_SNAP, web/snap.inline.html) is taken
   at confirm time and attached (fails closed to manual ＋).
4. Server: beginAppEdit (snapshot) → turn → finishAppEdit (inline checks). Passed → `{type:'app-edit',
   applied:true, version}`; failed → rolled back, reply says why.
5. Shell reloads the app in place and waits for the frame load; only then the panel shows
   「已完成 · Done」 and 「撤销 · Undo」. No load within LOAD_MS → "已改但未能重新加载 · Changed, reload failed"
   with Undo still shown. "Done" is never printed by the model's text alone: editUnchangedNote and the
   honesty regex stay as the backstop.
6. Classify question vs change: the model decides (it already does in the edit lane) but the SERVER
   owns the gate — no write without a valid confirm id. Typed 撤销/undo stays a no-model server action.
   One constant set for the wording (R3): extend lib/app-chat-honesty.mjs (CHANGE_APP_LABEL, confirm label).

## Roles (decided server-side only, never from wording)
| Role | Questions | Changes |
|---|---|---|
| Owner | full agent scoped to the app (as Phase 1) | full agent, scoped by system line to apps/<slug>/; "change superelf: …" → main agent (SUPERELF_RE) |
| Member, demo guest | confined no-write lane (today's app chat) | Phase 2 scoped editor lane (below) |

Phase 2 scoped editor lane (new lib/app-edit-lane.mjs, reusing lib/demo-app.mjs writeApp/contract, R3):
- No-tools model returns a whole index.html (+ optional meta.json). Claude or Ollama only; never Codex.
- Server writes ONLY apps/<slug>/index.html (+meta.json) in the caller's OWN workspace, after
  slugOk, safeJoin, noLinkOnTheWay; refuses dot-files, CLAUDE.md, AGENTS.md, any other name.
- Shelf (shared) app → fork first (/api/apps/fork), then edit the fork; the panel says so once.
- consumeAiCall per turn, demo caps, output size cap (EDIT_PAGE_MAX_BYTES or lower for demo).
- "Change superelf itself" from a non-owner → refused with a plain note.
- Same snapshot/checks/undo path as the owner (lib/app-versions.mjs, editChecks).

## Mechanical gate (inline, seconds, no AI)
editChecks as today (index.html present/non-empty/size, app-postcheck, inline scripts compile,
meta/data JSON parse). Headless load stays approximated (node has no browser; docs/TODO.md).
Nightly review and 审核一下 · Review now stay future (not cheap: needs a second model lane + schedule).

## UI (minimalist)
- One entry per app: the existing Ask AI control. No new permanent button.
- ⋯ → 改这个应用 = same panel, placeholder "说说想怎么改 · Say what to change".
- Header: app name, 撤销 · Undo (after an applied change), ✕.
- One conversation per app (convoTag 'app:<slug>' for both modes; the old 'app-edit:<slug>' threads
  are listed in the same history so nothing is lost).
- First-use tip (PATips/markNew, once, 中文 first) under the input:
  "这里可以提问，也可以直接让它改这个应用 · Ask here, or ask it to change this app".

## Security
- Confirm id is server-minted and single-use; a forged `app-change-confirm` line from app content
  cannot write (the panel's capture listener already drops non-parent messages).
- The panel is shell-served; app pages still cannot open an edit turn (appOriginated refuses).
- Prompt injection from app HTML/screenshot: owner lane = same exposure as Phase 1; non-owner lane
  has no tools, fixed file names, own workspace, undo.

## Files (R4 budget)
- web/app-edit.js (145) + web/app-edit-panel.html (76): grow; mode switch + confirm button + done/undo.
- lib/app-edit.mjs (207): confirm-id store goes in a new small lib/app-edit-confirm.mjs.
- lib/app-chat-honesty.mjs: confirm label constant; offer becomes "open panel".
- web/chat-ui.inline.html (1574, over budget): only a hook so an app's Ask AI can ask the shell to
  open the panel ({pa:'shell',type:'app-chat'}); TODO naming the split seam. No new responsibility.
- web.mjs (2991, over budget): route wiring only + TODO.

## Phases
A. Owner: Ask AI → panel, confirm step, Done-after-reload, one convo. (ship)
B. Members/demo guests: scoped editor lane, fork-first, caps. (ship)
C. Future: Review now, nightly review, version list with restore-to (docs/TODO.md).

## Tests (R6)
- Unit: confirm id single-use / wrong user / wrong slug / expired; no write without confirm; lane never
  picks Codex; writer refuses '..', symlink, dot-file, CLAUDE.md, AGENTS.md, other user's slug; caps charged.
- e2e (chromium + webkit, throwaway node): owner asks a question → answer, app untouched; asks a change →
  plan + Apply → app reloads → Done + Undo → Undo restores; Done not shown if reload fails; ⋯ entry opens
  the same convo; tip shows once; member edits own copy, shelf app forks first, "change superelf" refused;
  demo guest cap hit. Raise CI skip ceilings exactly by new skipped browser tests.

## Needs the owner (docs/TODO.md)
1. Keep in-page Ask AI for content apps (Bible/Journal/notes) — proposed yes.
2. Confirm tap for the owner too (proposed yes; owner can say "just do it" later).
3. Real iPad check of PA_SNAP at confirm time.
