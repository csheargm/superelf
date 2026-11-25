# 0042. 一个应用一个对话 · One chat per app: ask and change

Date: 2026-11-24. Status: accepted (Phases A + B shipped 2026-11-24). Plan: docs/plans/unified-app-chat.md.

## Context
Each app has two chats: its own Ask AI (confined, writes nothing, ADR 0040 follow-up) and the
Change-this-app panel (ADR 0040, owner only, can write). Users must pick the right one, and the honest
chat has to hand off with an offer button. Owner asked for one chat that does both.

## Decision
1. The shell-owned panel (web/app-edit-panel.html) is the one app chat; Ask AI and ⋯ → 改这个应用 open it
   (the latter in change mode). Content apps keep their in-page scoped rails.
2. A change is two steps: the AI states what it will do; the user taps 「改 · Apply」. The server mints a
   single-use confirm id; no write without it.
3. "Done" only after the server-confirmed write AND the in-place reload; then Undo (lib/app-versions.mjs).
4. Roles decided server-side: owner = full agent scoped to the app; members/demo guests = no-tools
   editor lane writing only their own apps/<slug>/index.html (+meta.json), fork-first for shelf apps,
   consumeAiCall + caps + size cap, never Codex, refuses dot-files/CLAUDE.md/AGENTS.md and "change superelf".
5. Inline mechanical checks gate every change; nightly review / Review now stay future.

## Consequences
- One conversation and one entry per app; the offer hop goes away.
- One extra tap per change (safety; protects against misread questions).
- Non-owner edits are whole-file rewrites (slow, size-limited).
- Supersedes ADR 0040's "two chats" split; keeps all of its safety rules.

## Addendum (2026-11-24, v5.17.x): the app chat changes only the app; member usage metered
Owner decisions on the two review leftovers.
1. **The owner's 改 · Apply is jailed to apps/<slug>/.** The confirmed turn runs the full agent with
   lib/agent-origin.mjs `appJailArgs`: no skip-permissions, `default` mode, Bash and MCP off, the only
   allow rule `Edit(<real app dir>/**)`, and CLAUDE.md / CLAUDE.local.md / AGENTS.md / AGENTS.override.md
   / GEMINI.md and every dot-name denied even inside the app (ADR 0019: a planted instruction file steers
   the next agent). Measured on CLI 2.1.327: inside → written, outside and protected names → denied.
   The server backstop (lib/app-edit-jail.mjs) watches every file tool call; one naming a path outside
   the app or a protected name, or a new protected file in the app folder, rolls back the WHOLE turn
   (the app from its undo copy, outside files the turn created moved into .app-versions/<slug>/.outside-<time>/) and the reply says so. Known
   limit: an existing outside file changed anyway cannot be restored; it is named. "change superelf: …"
   still goes to the owner's main agent, unjailed.
2. **Members not opted in to Claude are metered.** Each of their app-chat turns on Claude (no tools)
   charges a per-member daily counter (lib/member-quota.mjs, the demo's quota store, `member-quota.json`
   beside config.json; cap `member_limits.ai_calls_per_user_per_day`, default 30, read at use time).
   Past the cap the turn makes no model call and answers with a bilingual limit line. Ollama turns and
   typed "undo" are not charged.
