# 0042. 一个应用一个对话 · One chat per app: ask and change

Date: 2026-11-24. Status: proposed. Plan: docs/plans/unified-app-chat.md.

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
