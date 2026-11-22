# ADR 0019 — An app's agent writes nothing (应用的智能体不写任何文件)

Status: accepted · 2026-10-19. This amends ADR 0002's decision 4, written up on its own because
ADR 0002 is at its size budget.

## Context

- Since ADR 0002 (2026-10-11), an app's confined agent lane carried
  `--allowedTools 'Edit(./data/<slug>/**)'` (`lib/agent-origin.mjs` `appWriteRule`). Tasks was the
  only app that used it: it asked its agent to write `data/tasks/tasks.md`.
- ADR 0014 moved Tasks to `save-data`. From then on the rule was unused (R1).
- `save-data` holds every name to `lib/appdata.mjs` `appDataFile`. It refuses `CLAUDE.md`,
  `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`, dot directories and odd names.
  The agent's rule allowed every name under `data/<slug>/`. So an app could still plant an
  instruction file, by asking its agent. An R13 review of ADR 0014 noted this.
- Claude Code loads a `CLAUDE.md` from a folder when its agent reads a file there (measured below,
  on a `default`-mode run). Any later run asked about the app's data would load it. That includes
  the owner's composer and the owner's own Claude Code sessions. That they load it too is inferred:
  this loading is not a permission, so the mode should not matter.

## Measurement

Claude Code 2.1.161. A throwaway git root with the live layout (`<root>/.git`, cwd
`<root>/workspace`), and a launchd-like env. The lane was built by `laneArgs` and spawned by
`runClaude` (with `claudeChildEnv`), both from the checkout under test. Model `haiku`. Never the live
node. The before runs were on 2026-10-17, the after runs on 2026-10-19.

| Run | Result |
|---|---|
| Before (main `361b270`): the app lane with the rule, asked to Write six files under `data/probe/` | `notes.md`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `sub/CLAUDE.md` **written**; `.claude/settings.json` denied (the CLI's own guard) |
| A later run, no app, asked only to Read `data/probe/list.txt`, beside a planted `data/probe/CLAUDE.md` that says to end every reply with a token | **obeyed it, 2 of 2** |
| Control: the same run, the `CLAUDE.md` removed | did not, 0 of 1 |
| After (this change): the same six Writes | all six **denied** (six tool calls made), nothing on disk |
| After: Read `uploads/reading.txt`, the way Diabetes, Longevity and Notes ask | **read** |

## The search (2026-10-18, read-only)

Every app was searched: `workspace/apps`, `workspace.example/apps`, `shared-apps` and every member
workspace's `apps/`. Every `ask`/`chat` call site, PAChat
`system` prompt and PASettings `appPrompt` was read, not just grepped. Also checked: `config.json`
`system_prompts` (absent), every `profile.json` `systemPrompts` (empty or absent), and the saved
per-app prompt files (`data/bible/explain-prompt.json`, `data/notes/ocr-prompt.json`,
`data/notes/context-prefix.json`).

- Only Tasks asks its agent to write:
  - `workspace/apps/tasks` and `workspace.example/apps/tasks`. These copies used `ask` until ADR 0014
    (merged 2026-10-21) moved them to `save-data`; this change merged after it.
  - Older private copies in member workspaces, not in git. Most ask for a bare `tasks.md`, at the
    workspace root, which the rule already denied. One asks for `data/tasks/tasks.md` and stops
    saving. None has data under `data/tasks/`.
- Reads stay. Diabetes, Longevity, Notes and PAChat's attachment line ask the agent to Read an upload.

## Decision

- An app lane gets no allow rule. Its argv is the denies (Bash, `~/.claude`), then
  `--permission-mode default`, then the operator's args minus `--permission-mode` and
  `--allowedTools` in every spelling (`laneArgs`). `default` refuses every edit that no rule allows.
- An ask carries no slug any more, from the shell or into `/api/ask`. It existed to pick the one
  directory the agent could write, and an ask has no conversation to tag.
- `appWriteRule` is removed. `APP_DATA_DIR` lived beside it only for that rule. It moves to
  `lib/appdata.mjs`, which holds the app-data path rule.
- Not taken: narrowing the rule with denies (the instruction files and dot directories). No app needs
  the write. A deny-list must also know every name a CLI will ever load, and Codex takes extra names
  from its own config (ADR 0014).

## Verified

- `test/app-agent-bypass.test.mjs`, which runs the real `web.mjs` on the fake CLI:
  - An app's chat turn and an `ask` each ask to write `data/evil/own.md`, `CLAUDE.md`, `AGENTS.md`,
    `sub/CLAUDE.md`, `.claude/settings.json` and `data/tasks/tasks.md`. The fake records every write
    it is asked for and its verdict: each was asked for and refused, and none is on disk.
  - R14 control: over the same route, the owner's composer writes each of them. The same fake, run
    with the old app lane (the rule), writes each one under `data/evil/`.
- `assertAppLane` (`test/helpers-agent-lane.mjs`) refuses any `--allowedTools` / `--allowed-tools`
  on an app lane. So every app-lane test checks it: in `test/app-agent-confinement.test.mjs`,
  `test/app-agent-bypass.test.mjs` and `test/agent-member-args-bypass.test.mjs`.
- `test/agent-confinement.test.mjs`: `laneArgs` gives a real slug (`notes`, `tasks`) exactly what an
  unstated origin gets.
- With the old `laneArgs`, 11 of these tests fail. A twelfth, the `agentArgs` census, also fails on
  main already (`docs/TODO.md`).
- The fake still honours an `--allowedTools 'Edit(./<dir>/**)'` rule, and `assertAppLane` refuses the
  flag in any spelling, so a rule that came back through `laneArgs` fails the tests.

## Consequences

- An app's agent can read and answer. It cannot save anything. An app saves through `save-data`.
- Closed: an app can no longer plant `data/<slug>/CLAUDE.md` (or `AGENTS.md`, …) through its own
  agent. `save-data` already refused it.
- The running node keeps the old lane until it restarts: the lane argv is built by code loaded at
  boot.

## Not closed

- An app's agent can still read the whole workspace (ADR 0002, known gaps).
- A settings source that grants an `Edit`/`Write` allow would still apply (ADR 0002). That
  includes an operator's own `--settings` carrying `permissions.allow` in `claude_args`, `fast_args`
  or `member_args`: `laneArgs` strips permission flags, not settings. It is not reachable by an app
  (admins cannot edit those keys, ADR 0016), the live config's args carry none, and it predates this
  change. The fake does not model it; `assertAppLane` refuses an edit allow in the applied
  `--settings`. A blanket `Edit`/`Write` deny on the app lane would close it; that needs a
  measurement first (`docs/TODO.md`). ADR 0016 lists the other operator flags that still reach a
  confined lane.
- Member workspaces' copies of old apps are not in git, so this change does not update them
  (`docs/TODO.md`).
