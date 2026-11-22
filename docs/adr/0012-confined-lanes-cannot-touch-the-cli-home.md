# ADR 0012 — Confined lanes cannot read or write the CLI's home with file tools (受限通道不能读写 ~/.claude)

Status: accepted · 2026-10-12. This is ADR 0002's decision 9, written up on its own because ADR 0002 is
at its size budget.

## Context

- ADR 0002 amendment 2 stopped every superelf run from LOADING the CLI's auto-memory store,
  `~/.claude/projects/<git root>/memory/`. Every workspace of the checkout shares that store, and
  so do the owner's own interactive Claude Code sessions in the repo.
- The CLI still let confined lanes write and read it, because it allows its own store. This was
  measured for an app lane's write and a member lane's read.
- So an app could still plant text that the owner's interactive sessions load. Those sessions
  usually run with full permissions.
- An app could also read the owner's memory and the session transcripts under `~/.claude/projects/`
  (probe report F5, `docs/plans/ai-lane-isolation-probes.md` on branch `docs/ai-lane-table-plan`).

## Decision

- `Edit(~/.claude/**)` and `Read(~/.claude/**)` join `Bash` in every confined lane's one
  `--disallowedTools` (`lib/agent-origin.mjs` `CONFINED_DENY_ARGS`). That covers a member's own
  chat and every app turn.
- An explicit deny beats the CLI's own allow for its store.
- The owner's composer keeps the unrestricted lane and is unchanged.

## Measurement

Claude Code 2.1.161, a throwaway git repo with the live layout (`<repo>/.git`, owner cwd
`<repo>/workspace`, member cwd `<repo>/workspace-kid`). The lanes were built by `laneArgs` and the env
by `claudeChildEnv()`.

| Lane | Action | Without the deny (control) | With the deny |
|---|---|---|---|
| App turn | Write into the store | **written** | denied ("denied by your permission settings") |
| Member's own chat | Read the store | **read** | denied |
| App turn | Read, Grep, Glob of the store; a Write to `~/.CLAUDE/…` (macOS is case-insensitive) | — | all denied |
| Member's own chat | Write into the store | — | denied |
| App turn / member's own chat | Write its own `data/<slug>/` / its own workspace | — | **still written** |
| App turn | The denies in a SECOND `--disallowedTools` flag | — | denied: repeated flags add up |
| App turn | Read back an oversized Grep result the CLI saved under `~/.claude/projects/…/tool-results/` | **read** | denied: only the preview is seen |
| App turn | Read a `/tmp/claude-<uid>/<key>/<sid>/tasks/*.output` symlink into `~/.claude/projects/…/subagents/` | **read** | denied: the target is checked |
| App turn | A prompt naming `@<a file in the store>`, which the CLI inlines itself with no tool call | **inlined** | not inlined; an `@` workspace file still is |

## Verified

- `test/agent-claude-home.test.mjs` runs the real web.mjs on the fake CLI. The fake honours exactly
  these two rules; its `~/.claude` is a directory in the test root.
- The store is seeded. Each path asks to write it and to read it:
  - a member's own chat, its chat-to-job resolver, and `/api/jobs/resolve`;
  - an app's chat turn and `/api/ask`, in the owner's session and in a member's;
  - the Verify panel, an app's and a member's.
- Control: the owner's composer has no deny, and it writes and reads the store through the same
  fake.
- Without the fix, 6 of its 7 tests fail: every confined lane reads the seed and writes its plant.
- `assertAppLane` (`test/helpers-agent-lane.mjs`) now requires the full deny list, so every
  existing app-lane test checks it too.

## Not closed

Only Write, Read, Grep, Glob and the CLI's `@` inlining were measured. Per the CLI docs, Edit and
NotebookEdit share the Edit rule. The denies do not reach MCP tools, and the Skill tool loads skill files itself.

- **The CLI still loads files from `~/.claude` itself.** With the deny, an app lane still recited
  a rule title from the owner's `~/.claude/CLAUDE.md`. It loads user settings and skills the same
  way. ADR 0009 proposes `--setting-sources` without `user`, and `--strict-mcp-config`, for
  confined runs.
- **The CLI's temp dir is still readable.** That is `/tmp/claude-<uid>/<cwd key>/`.
  - An app lane read a plain file planted there. The same file under `$TMPDIR` was refused.
  - The owner's composer and app turns share the key.
  - The live workspace's dir held only two symlinks to subagent transcripts. A Read through them is
    now denied (above); before this fix, an owner's app turn could read them.
- **`CLAUDE_CONFIG_DIR`, inferred, not measured.** `claudeChildEnv()` passes it through, so an
  operator setting it would presumably move the CLI's home past this deny. The live server sets
  none.
- **The bypass flag in `member_args`.** FIXED SINCE (ADR 0002 decision 4): `laneArgs` strips it
  from `member_args` too, and the denies now come before any operator arg, so none can swallow
  them. Measured since: these denies hold under the bypass (`lib/agent-origin.mjs`).
- **Windows** was not measured: there, `~` must expand to `%USERPROFILE%` in a rule.
- **What is already in the store stays.** The owner's own interactive sessions still load it until
  the owner reviews it.

## Consequences

- A confined lane's file tools cannot read or write under `~/.claude`.
  - That includes the reference files of the owner's user skills.
  - An oversized tool result the CLI saved there is seen only as its preview (measured).
  - No superelf feature reads there.
