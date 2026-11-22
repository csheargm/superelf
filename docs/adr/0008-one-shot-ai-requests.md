# ADR 0008 — One-shot AI requests (一次性请求): Claude and thinking off by config, no app contract, cancellable end to end

Status: accepted · 2026-10-12 · amended 2026-10-13 (a oneShot turn starts fresh, decision 9)

## Context

- The Journal's "Design with AI · AI设计" asks for ONE answer: an SVG. It goes through
  `PAChat.complete` → the shell's chat relay → `/api/chat` → `claude -p --model sonnet` (ADR 0003,
  item 5).
- MEASURED 2026-10-12 with the real CLI. With the user's adaptive thinking on, Sonnet drafted the
  whole SVG inside its thinking, hit the 32,000-token output cap with no text, retried, and never
  answered: 4 of 4 runs failed after more than 10 minutes, even at `--effort low`. With thinking
  off, a complete SVG came back in 110-190 s (real end-to-end runs: 113-188 s).
- `PAChat.complete` sends the model the Journal's Ask-AI chooser is set to. When that is an Ollama
  model, a design went to a fast lane with no tools and none of the fixes below.
- Nothing could stop a run. The studio gave up after 5 minutes with a race that cancelled nothing,
  the shell never closed its fetch, and the server never killed the claude child. Retries piled up
  three claude processes that held every enqueue slot.
- The agent lane's system prompt carries the app contract (about 3.7k characters, from
  superelf.md). It tells the agent how to BUILD an app, which a component's one answer never does.
- The background asks (`/api/ask`, the job resolver) run on `fast_args` (Haiku). MEASURED
  2026-10-12: Haiku thinks by default, 8.4 s / 625 output tokens with thinking on against
  6.0 s / 251 with it off.
- MEASURED 2026-10-12 (Claude Code 2.1.161, by two sessions independently, each order repeated):
  the claude CLI honours the FIRST `--settings` on its argv and ignores every later one entirely,
  even keys the first does not name. `--settings {"alwaysThinkingEnabled":false} --settings
  {"theme":"dark"}` runs with thinking off; the reverse order runs with it on. Two never merge.
  The first version of this ADR said the LAST one wins. That was assumed, not measured, and wrong.

## Decision

1. **`oneShot: true` marks one answer for a component, not a conversation turn.**
   `PAChat.complete` always sends it. The composer never does. The shell forwards only the literal
   `true`, and the server honours only the literal `true`.
2. **Claude, by config.** A oneShot turn is answered by `cfg.one_shot_model`, a `chat_models` id
   (default `"claude"`), whatever model the request names. `""` means "use the request's model".
   An unknown id gets one warning at load, and the request's model is used. web.mjs `chat()` reads
   it per request and hands that model to `PA_CHAT_LANE` (`pickChatLane`), which is unchanged.
3. **Thinking off, by config.** On the Claude lane, a oneShot turn appends `cfg.one_shot_args`
   to the lane's argv. The default is `['--settings', '{"alwaysThinkingEnabled":false}']`. It is
   read from the live config on every turn (ADR 0011), so an operator can change it, or set `[]`,
   without a restart. It goes in before `agentArgs`, so a confined lane carries it too. Model,
   `--effort` and confinement are unchanged.
4. **The background asks: thinking off too.** The default `fast_args` is
   `['--model', 'haiku', '--dangerously-skip-permissions', '--settings', '{"alwaysThinkingEnabled":false}']`.
   An operator's own `fast_args` is used as written: it REPLACES the default, so to turn thinking
   off it must include the `--settings` pair itself.
   **The daily digest (amended 2026-10-12).** tools/fetch-daily-digest.mjs (cron, 06:00) takes its
   model and thinking-off from `fast_args` too, and nothing else. Its prompt carries web search
   text, so no permission-widening flag may reach it. It still runs in the CLI's default
   permission mode, so the machine's own allow rules in ~/.claude/settings.json apply to it, as
   before. Denying it every tool is a separate follow-up.
   - It loads config.json read-only, when it summarizes (`loadConfig(root, { readOnly: true })`,
     ADR 0011): nothing is written to config.json and nothing is provisioned.
   - lib/one-shot.mjs `digestArgs` is an ALLOW-list. It keeps every `--model` whose value is one
     word that is not a flag (in order; with none, the CLI's default model answers), and adds
     `NO_THINKING_ARGS` when the FIRST `--settings` in `fast_args` (the one the CLI applies) is
     inline JSON with `"alwaysThinkingEnabled": false`. It never copies the operator's JSON, which
     can also carry permissions, hooks and env. A settings file path is not read, so thinking stays
     on there.
   - Not a deny-list. lib/agent-origin.mjs's permission flags plus `--dangerously-skip-permissions`
     would still let `--allow-dangerously-skip-permissions`, `--add-dir`, `--mcp-config` and that
     JSON through.
   - It runs through lib/runner.mjs `runClaude`, so it gets the Windows shell fallback below. Its
     command is still `claude` (not `claude_cmd`, so that fallback's advice to set `claude_cmd`
     does not apply to it), its cwd the owner's workspace, its timeout 90 s. What changes with
     runClaude: output is `stream-json` (`--verbose --include-partial-messages`), success is the
     result line's, a `[timing]` line may be logged, and a timeout is reported as the digest's own
     90 s (runClaude's `timedOut`). runClaude also decoded stdout per pipe read, so a Chinese
     character split between two reads came back as U+FFFD. It now decodes the stream as UTF-8,
     for every run.
   - When config.json cannot be used (missing, not JSON, refused by the validator, a `fast_args`
     that is not a list of strings), it says why on stderr and runs as before: `--model
     claude-haiku-4-5-20251001`, thinking on. A config.json that cannot be loaded never costs the
     day's digest. One that loads but names a model the CLI refuses gets the titles fallback, as
     any failed summary does.
   - It has no isMain guard. One that compares `process.argv[1]` with the module's path is false
     when the tool is started through a symlinked path (`/tmp` is `/private/tmp` on macOS), and
     then the run silently does nothing.
5. **An operator's `--settings` always wins over a default's.** On a oneShot turn the argv is
   `claude_args`, then `one_shot_args`, then (on a confined lane, which every app turn is)
   `member_args`. A fast-lane ask is `fast_args`, then `member_args`.
   - A default's `--settings` (from `one_shot_args` or `fast_args`) is DROPPED when an operator's
     is in the same argv (`--settings x` or `--settings=x`): `claude_args`' on a oneShot turn,
     `member_args`' on a confined turn. The default's other flags still ride (lib/one-shot.mjs
     `yieldSettings` and `oneShotBaseArgs`; web.mjs `fastBaseArgs` for the fast lane, and
     `memberArgsOf`, which hands both the `member_args` a confined turn appends).
   - `claude_args` comes first, so it would win by position anyway. The drop keeps exactly one
     `--settings` in argv, so the outcome does not rest on the CLI's ordering rule.
   - `member_args` comes after the default, so by position the default would win and the
     operator's member settings would be ignored without a word. Those settings can be hardening
     for members and apps, so losing them to a default is a security-relevant layering bug. The
     drop makes `member_args` win on every confined turn.
   - Either way that turn runs with the operator's thinking setting. lib/config.mjs warns at load,
     says so, and names the fix: add `"alwaysThinkingEnabled": false` to the operator's own
     settings file (it then applies to every turn that uses that file). It does not merge files.
   - `claude_args` and `member_args` are both the operator's, so neither is dropped. When both pass
     `--settings`, a confined chat, oneShot or Verify turn carries both, `claude_args`' first, and
     the CLI applies `claude_args`'. The loader warns that `member_args`' is ignored on those turns.
     A confined fast-lane ask carries no `claude_args`, so it applies `member_args`'.
   - The loader's warnings state one outcome each and never contradict: a oneShot turn with
     `claude_args`' runs on `claude_args`' (never `member_args`', confined or not); `member_args`'
     is named as applied only where it is the first `--settings` — every confined turn when
     `claude_args` carries none, otherwise only the confined fast-lane asks
     (lib/one-shot.mjs `settingsClashWarnings`).
6. **No app contract.** A oneShot turn's system prompt drops the app contract. The language rule
   and the confined-lane note still ride.
7. **Cancel works end to end: studio → PAChat → shell → server.**
   - The studio aborts its signal on Cancel, on reset, on a newer run and on its 5-minute timeout.
   - `PAChat.complete` then sends ONE `chat-cancel {chatId}` naming that chat request, and answers
     its caller at once.
   - The shell aborts that relay's fetch, which closes the request socket.
   - The server sees the close and kills the claude child. A turn still queued never spawns, and a
     cancelled turn never gets the fresh retry after "No conversation found": since decision 9 a
     oneShot turn never resumes, so that retry runs only for conversation turns, which are never
     cancelled. It stores `Cancelled · 已取消`, never the killed child's raw stream-json, and
     audits `chat-cancelled`.
8. **The interactive composer is excluded from all of this.** Its `pollForResult` relies on the
   server FINISHING a turn whose stream dropped (a phone that slept, a tab switched away). Killing
   that turn on close would lose answers people are waiting for. Its model is the one picked.
9. **One self-contained answer: no `--resume`, no history block (续接会话) (amended 2026-10-13).**
   On the Claude lane a oneShot turn spawns the CLI without `--resume` and sends exactly its
   message, never the `[Resuming conversation …]` block. It is still stored in the conversation
   the caller named. Its run's session id never becomes the conversation's `sessionId`. The
   composer is excluded from this too (item 8): it resumes and carries the history block, as
   before. Why, and what a later conversation turn there does: "Amendment — a oneShot turn starts
   fresh" below.

## Options not taken

- **Thinking off for every turn.** That changes every conversation, and the failure was measured
  only on one-shot answers and the background asks.
- **`--effort low`.** Measured: it still failed 4 of 4.
- **A hard-coded constant in web.mjs.** That is how this shipped first. Changing it needed a code
  edit and a restart, which kills every turn in flight (ADR 0011).
- **Merging the operator's settings file with ours.** Which keys may combine is the operator's
  call, not the loader's. The CLI does not merge them either.
- **Relying on argv position.** Position decides only by the CLI's ordering rule, which this ADR
  first got backwards. With exactly one `--settings` in argv, the order no longer matters.
- **A settings file in the repo instead of the inline JSON** (for the Windows shell fallback
  below). Node joins a shell's argv unquoted, so a checkout under a path with a space would split
  the path. The path must also be absolute (claude runs in the user's workspace), so
  config.example.json could no longer ship the same default.
- **Changing `pickChatLane`.** test/chat-image-lane.test.mjs runs that block verbatim. Handing it a
  different model keeps the lane rules in one place.
- **A new endpoint.** ADR 0003 keeps the AI channel on the existing `chat` broker kind, and so
  does this.

## Consequences

- **The dropped contract, kill-on-close and the fresh start apply only on the Claude lane.** With
  the default `one_shot_model` every design lands there. If an operator points `one_shot_model` at another
  lane, or sets `""` and the Journal's model is not Claude, a design gets none of items 3, 6, 7
  and 9: an Ollama lane still sends the last 20 messages, and Codex still resumes its session.
- A live `config.json` that sets its own `fast_args` keeps it: the new default applies only where
  the key is absent. To get thinking off there, that `fast_args` must include the `--settings`
  pair. The loader does not warn about it: an operator may keep thinking on deliberately.
- **Windows shell fallback.** When `claude_cmd` resolves to no .exe and no readable .cmd shim,
  lib/runner.mjs runs it through cmd.exe, which cannot carry the JSON value. There it drops exactly
  the default pair and warns once, so those runs keep thinking on instead of being refused. Any
  other argument cmd.exe cannot carry, an operator's own `--settings` JSON included, still refuses
  the run.
- The figures were measured on one machine, on one day, with one model each.
- Tests: `test/chat-one-shot.test.mjs` (server: argv, contract, kill, queue, a conversation
  turn's retry), `test/chat-one-shot-fresh.test.mjs` (item 9: no resume, no history block, no
  growth, every turn stored),
  `test/chat-cancel.test.mjs` (PAChat and shell), `test/stationery-flow.test.mjs` (studio and
  picker), `test/stationery-design-e2e.test.mjs` (all of them together),
  `test/one-shot-lanes.test.mjs` (one_shot_model and fast_args on a real server; the member_args
  `--settings` yield at all three fastBaseArgs call sites: /api/ask, the chat() job resolver and
  /api/jobs/resolve),
  `test/config-one-shot-args.test.mjs` (the values, the `--settings` rule and its warnings),
  `test/config-live-reload.test.mjs` (live edits, the real argv order, what the CLI applies) and
  `test/runner-shell-fallback.test.mjs` (the Windows shell fallback) and
  `test/digest-fast-args.test.mjs` (the digest: argv, every permission form stripped, read-only
  load, config-failure fallback, a symlinked start, its pair under the shell fallback). The fake
  CLI the server tests use records the FIRST `--settings` as the one applied, as the real CLI does.

## Amendment — a oneShot turn starts fresh (一次性请求不续接会话), 2026-10-13

### Context

- MEASURED 2026-10-13 on the live node, from the Claude CLI transcript of one Journal stationery
  conversation. The studio's design and every tweak reuse ONE convoId (the picker keeps it with
  the draft, and the conversation shows in the Journal's chat list). On the Claude lane chat() then:
  1. resumed the CLI session (`--resume convo.sessionId`), which already held every earlier turn,
     each full SVG included;
  2. always prepended the history block (the last 10 messages, `buildHistoryPrompt`). Its comment
     said the block is "redundant but harmless" when resume works. With each message a 20-40 KB
     SVG it is not harmless;
  3. sent the tweak prompt, which carries the current SVG again.
- Context per turn: 25k → 27k → 55k → 82k → 145k → 313k tokens. Past about 200k the CLI needs
  its 1M-context mode. On a subscription that mode needs usage credits, so every later tweak
  failed with "API Error: Usage credits required for 1M context".
- The run was the Claude CLI on the subscription, as every chat turn is. superelf never calls the
  API itself. "API Error" is the CLI's prefix for an error the model service returns.
- The studio's prompts are self-contained (web/stationery-studio.inline.html): `designPrompt`
  carries the request, `tweakPrompt` the current SVG, `recreatePrompt` the attachment. The earlier
  turns add nothing the answer needs.

### Decision

1. On the Claude lane a oneShot turn (`oneShot === true`):
   - spawns the CLI WITHOUT `--resume`;
   - sends exactly its message (plus the attachment note, `attachmentPrompt`), never the
     history block;
   - is still stored in the conversation it named, both halves, so the chat list and the draft
     keep working;
   - does NOT record its run's session id as the conversation's `sessionId`.
2. **Why the session id is not recorded.** A oneShot run's session holds one answer. Recording it
   would make the next conversation turn resume a session that knows only that answer, and the
   session the conversation had would be lost. Not recording it:
   - a conversation with a session: the next conversation turn resumes that session, and its
     history block carries the oneShot turns the session never saw;
   - a conversation of oneShot turns only (the studio's) created after this fix has no session,
     so a conversation turn typed there later starts fresh with the history block, as any turn
     without a session does. Studio conversations from BEFORE this fix still hold the session
     their oneShot turns recorded; oneShot turns no longer resume it, but a normal chat message
     typed into one of those conversations would resume that long session.
3. **The composer and every conversation turn are unchanged.** A non-oneShot turn resumes,
   carries the history block and records its session, exactly as before.
4. **The retry guard that could no longer fire is removed.** The fresh retry after "No
   conversation found" carried `!cancelled()`. Only a oneShot turn can be cancelled, and a oneShot
   turn now never resumes, so that guard was always true where it was checked. Decision 7's "no
   retry after a cancel" now holds by construction.

### Options not taken

- **Keep resume, drop only the history block.** The resumed session still grows by a full SVG
  prompt and answer every turn, and crosses 200k after enough tweaks.
- **Keep the history block, drop only resume.** The block replays up to ten 20-40 KB SVGs every
  turn.
- **Record the oneShot run's session (overwrite).** See decision 2.
- **A new conversation per request, in the studio.** The draft and the chat list rely on one
  convoId, and the server rule covers every future `PAChat.complete` caller.
- **Shrink the history block for every turn.** That changes the composer, which this fix must not.

### Consequences

- A conversation turn typed after oneShot turns in the same conversation still carries the
  history block, now holding those SVGs (up to 10 messages). That is the composer's rule,
  unchanged here; past about 200k tokens such a turn would need the 1M mode too.
- Each oneShot run leaves its own CLI session on disk instead of extending one.
- The token figures were read from one conversation's transcript, on one day.
- Tests, `test/chat-one-shot-fresh.test.mjs` (real web.mjs, fake claude):
  - a oneShot turn in a conversation with turns and a session: no `--resume`, the prompt equals
    the message, and the conversation keeps its own session;
  - six oneShot turns in one conversation (about 31 KB each): every prompt the same size, no
    `--resume`, all twelve messages stored, no session recorded;
  - CONTROL: a conversation turn after them resumes the conversation's own session, starts with
    the history block (which carries the oneShot turns) and records its session.
  - In `test/chat-one-shot.test.mjs` the cancel-during-resume test (unreachable now) is replaced by
    a conversation turn's retry: seed, resume, then a fresh retry with the history block.
- Mutation evidence (each reverted after). oneShot resumes again: test 1 fails. The history block
  on a oneShot turn: tests 1 and 2 fail (prompt sizes 31k, 63k, 94k, 126k, 157k, 188k characters
  over six turns). oneShot records its session: all three fail. No turn resumes, or no turn gets
  the block: the CONTROL and the retry test fail. The oneShot answer not stored: test 2 and the
  cancel tests fail. The retry removed: the retry test fails. The unfixed web.mjs fails all three.
