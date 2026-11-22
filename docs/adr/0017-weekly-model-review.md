# ADR 0017 — A weekly model review (模型评测) tests Ollama models on our uses and keeps the best in the chooser

Status: accepted · 2026-10-17 · amends ADR 0007 decision 4 · decision 8 (the report) amended by ADR 0020

## Context

- PLAN.md lists a standing sample task for the action engine: periodic LLM A/B testing that keeps
  the best models routed.
- ADR 0007's daily `model-check` job lists new cloud catalog models in the owner's briefing, and
  the owner decides by hand. On 2026-10-17 the live node's record held 21 catalog names, and 15 of
  them were not configured. Nothing tested them, so the lines were noise.
- MEASURED 2026-10-17 on Ollama 0.34.3, 4 calls to the local Ollama:
  - `beam:cloud` and `clef:27b-cloud` reach the model without a pull.
  - For a tagged name, both `mistral-large-3:675b-cloud` and `mistral-large-3:675b:cloud` answer.
  - `clef:27b` answers `400 … is a decision model and only supports /v1/systemone`. A catalog name
    is not always a chat model.
- The chooser is `config.json` `chat_models`, read live (ADR 0011). ADR 0007 decision 4 said no job
  edits `config.json`.

## Decision

1. **A built-in job, `model-review`（模型评测）, owner only**, beside `model-check` (lib/model-review.mjs,
   one JOBS entry in web.mjs).
   - The scheduler asks it daily at `model_review.time` (default `03:00`).
   - A review is due when `every_days` (7) whole local days have passed since the last one, or
     when the catalog that `model-check` recorded holds a name the last review did not see.
   - When no review is due, the run returns no briefing. Run now always reviews.
   - With no catalog recorded (`ollama_catalog_url` `""`, or never read yet), nothing can be
     compared, so there is no review. Run now says so.
2. **The tests are data**: `model-review/tests.json`, tracked in the repo. `model_review.tests`
   names another file. The file is read at every run.
   - Groups: Fast (short Chinese and English replies, JSON our apps parse, the no-tools honesty
     reply), Deep (Bible study in Chinese and English, a reasoning sum) and Vision (a meal photo).
   - Every prompt is made up. The meal image is a synthetic drawing (rice, broccoli, carrots, cola).
   - A test can name a production prompt instead of copying it: the fast-lane guard, the language
     rule, an app's configured directive, or the meal prompt. A later edit of that prompt is then
     what gets tested.
   - The format checks are code (lib/model-review-tests.mjs): empty, strict JSON keys,
     `parseMealReply`, and the reply language.
3. **Two rounds.**
   - Round 1: every current Ollama lane and every unconfigured catalog model answer the quick tests
     (3). Time to first text, errors and format are recorded.
   - Round 2: the current lanes, plus the 6 fastest newcomers with no failure in round 1, answer
     the rest.
   - Catalog name to model string: `name:cloud`, or `name:tag-cloud` for a tagged name (measured
     above). lib/model-health.mjs `cloudModel` is the inverse of `catalogName`.
   - The request is exactly what web.mjs `streamOllama` sends: `{ model, messages, stream: true }`.
     "First text" is the first non-empty `message.content`. A thinking model's reasoning is not text.
   - Limits come from config: `concurrency` calls at once, `call_timeout_s` per call, and
     `max_calls` per review. The current lanes are always tested. Newcomers are cut to fit, the
     newest arrivals first in line. A budget too small for the current lanes fails the run.
4. **Claude grades blind**, one call per test (lib/model-review-grade.mjs).
   - Answers are labelled with shuffled letters, never a model name, and cut at the same length.
     Each sits between delimiters that carry a random tag per call, so an answer cannot fake them.
   - The rubric is written: a general one, one per test, and the truth for the image.
   - The reply is parsed strictly: exactly the letters asked, whole numbers 1-5.
   - The lanes and the newcomers are graded in the same call. Every model gets identical messages.
   - A failed, empty, timed-out or wrongly formatted answer is never sent to the grader. It scores
     0 (R14).
   - The grader runs as the one-shot Claude lane (`claude_args`, then `one_shot_args`: thinking
     off, ADR 0008), plus `NO_TOOLS_ARGS` (`--tools= --strict-mcp-config`). Its prompt carries other
     models' text, and nothing it writes except the integers reaches the report.
   - An `@` that could name a file becomes `＠`, since the CLI reads `@path` with no tool.
   - A grading failure fails the run, and nothing is written.
5. **The update rule** (lib/model-review-pick.mjs, pure functions).
   - Quality is the mean score per group, with failures counted as 0. Rank = quality minus speed:
     0.3 points per second to first text for Fast, 0.03 for Deep.
   - Fast and Deep each keep 3 lanes. A newcomer replaces a group's weakest removable lane only
     when all of these hold:
     - its rank beats that lane's by `margin` (0.5);
     - it is at most `max_slowdown` (1.5x) slower to first text;
     - it had no failed Fast or Deep answer.
   - A group with fewer than 3 lanes takes the newcomer as an addition, on the same terms.
   - A model joins one group, and each group changes at most once. Of all such assignments, the
     one with the most changes, then the biggest total lead, wins.
   - Some ids are never removed:
     - what other keys resolve to: `health_llm`, `research.llm`, `assess_models`,
       `vision_default`, `one_shot_model`. A DERIVED default counts: an unset `health_llm` means
       the first Ollama lane;
     - the first lane, which is the default;
     - every lane a job file pins.
   - Claude, Codex and every non-Ollama lane are never touched. No group is ever left empty.
   - A new lane gets a new id, a slug of the catalog name, and its name as the label. It takes the
     removed lane's place in the list. A removed id falls back with a status line (ADR 0007).
6. **Writing** (lib/model-review-apply.mjs).
   - config.json is re-read fresh. If `chat_models` changed while the review ran, nothing is
     applied, and the report says so.
   - The whole candidate goes through the loader's own validator (`validateConfig`) first.
     A refusal is reported, and nothing is written.
   - `model-review.json` (node root, beside `model-health.json`) is written first, with what Undo
     needs. config.json is written second, atomically, with every other key as it was.
   - If the config write fails, the state file is put back.
   - The running node's config watcher reloads the file. No restart is needed.
   - We did not load a candidate through `loadConfig` in a scratch root: its users part does not
     depend on `chat_models`, and `validateConfig` is what refuses.
7. **Safety.**
   - The first review on a node only reports what it would change. That holds whenever there is no
     state file, and when a damaged one was rebuilt (the report says so).
   - A failed run changes nothing.
   - Undo is a second built-in, `model-review-undo`（撤销模型评测）. It has no schedule. The Jobs view
     lists a built-in marked `onDemand` with "on demand · 按需", no next run, and its Run now
     button (lib/jobstatus.mjs). No new screen.
   - Undo restores the `chat_models` from before the last change. If the file had no such key,
     the key is removed again.
   - Undo works only while config.json still holds exactly the list the review wrote. An edit
     made since is the owner's, and Undo refuses rather than overwrite it.
   - The models Undo took back are recorded in `declined` and never proposed again. Deleting
     `model-review.json` clears that list, and makes the next review report-only.
   - One review or Undo runs at a time on a node (lib/model-review.mjs `oneAtATime`). Each reads
     `model-review.json` when it starts and writes it when it ends, so an overlap (Run now pressed
     again after the UI gave up, or Undo during a review) wrote back a stale record and lost the
     undo or `declined` list. A manual run that finds one going fails with "already running" and
     changes nothing; a scheduled turn returns no briefing, since the run in progress reports. The
     guard is in-process: the node is one process.
8. **The report** is the job's briefing, emailed like every briefing (lib/notify.mjs): plain text,
   中文 and English, no emojis. It holds:
   - the result, and what changed and why;
   - the chooser list;
   - a score table: model, lane, Fast / Deep / Vision quality, seconds to first text, fails;
   - each newcomer not picked, and why;
   - the groups that cannot change;
   - the models declined by Undo;
   - the cost: Ollama calls, Claude calls, minutes;
   - how to Undo.
   Text from a model or a server is flattened and capped.
9. **ADR 0007 decision 4 is amended.**
   - The daily `model-check` still reads and records the catalog. It no longer briefs "New on
     Ollama cloud, not in the chooser", on a scheduled run or on Run now. It still briefs a lane
     gone, back, or not checkable.
   - `model-review` is now the one job that edits `config.json`, and only its `chat_models`, with
     the first-review report, the guards above, and Undo.

10. **Amendment 2026-11-02: the agent lanes are benchmarked too** (lib/model-review-agent.mjs).
    - `model_review.agent_lanes` (default true) measures every `chat_models` lane with provider
      `claude` or `codex` on the Fast and Deep tests, graded blind in the same batches as the
      Ollama answers. The Vision test is skipped (the runners take no image): the table shows
      "—" and says "not measured · 未测".
    - Compared only: an agent lane is never swapped, never a group's bar, never a newcomer. The
      report's table and speed chart carry a row per agent lane (Use = "Agent") and the line
      "Agent lanes are measured for comparison and never swapped · 代理通道仅作对比，不更换".
    - Measured as the chat runs them: Claude through `runClaude` with `claude_args` and the owner's
      workspace, the system pieces as `--append-system-prompt`; GPT through `runCodex`, the system
      pieces first in its prompt (Codex has no system flag). Both go through web.mjs's agent queue.
    - **Codex caveat.** Codex returns only its final message, so its first-word time IS its whole
      answer; the number is reported with "whole answer · 整段回答, Codex does not stream" beside
      it, not as a first-word time it is not (R14).
    - Agent calls are not Ollama calls: they do not count against `max_calls` and the cost line
      counts them apart ("N agent calls · N 次代理调用"). A non-ok result, an empty answer or a
      timeout (`call_timeout_s`) is a failed answer with its reason, scored 0.
    - Tests: test/model-review-agent.test.mjs; test/model-review-flow.test.mjs drives a fake
      claude and a fake codex CLI through the real runners.

11. **Amendment 2026-11-02: a skill-writing test** (`deep-skill-write`, check `skill`).
    - Why: the Hermes box's own check "a multi-step task, then a correction, must leave a new or
      patched skill behind" failed twice after the box's brain followed the review's Deep winner
      (mimo-v2.6-pro) and had passed on the previous brain. The review's tests did not cover the
      behaviour the box relies on most, so the winner on paper was weaker in the box.
    - The test mirrors that check as a one-shot: the task and the correction the box sends, then
      "write the SKILL.md you would save". `check: skill` is deterministic (lib/model-review-tests.mjs
      skillFail): front matter with a `name` slug and a `description`, at least 3 steps, and every
      word in `must` (the correction's rules: count, sort, author, read) present — a skill that drops
      the rule it was asked to keep fails before grading, scored 0 (R14). Claude then grades the
      rest: generic, not tied to the one site; the correction as standing rules.
    - It is a Deep test, so it weighs on the Deep lanes' quality and on the agent lanes' Deep column.

## Options not taken

- **A proposal in the approval queue for each change** (lib/actions.mjs). Approvals show only
  inside apps (the longevity app). Proposals expire in 7 days. An executor gets only the user and
  the action. The owner chose apply-after-the-first-report, with Undo as the way back.
- **A new screen or route for Undo.** The UI is feature-frozen, and web.mjs gets only JOBS
  entries. Run now already exists, with its confirm dialog.
- **Showing model names to the grader, or grading with an Ollama model.** Both bias the scores
  toward a model or a family.
- **Grading round 1.** It would roughly triple the Claude calls. Round 1 only filters on format,
  errors and speed.
- **Sending `think: false`.** The apps do not send it, so the measurement would not be of the apps.

## Consequences

- **Cost, estimated, not yet measured:**
  - 6 lanes and 15 newcomers: (6+15) x 3 + (6+6) x 6 = 135 Ollama calls;
  - one Claude call per test, 9 now;
  - "minutes" in the report gives the real figure after the first live run.
- **The jobs tick is serial.** While a review runs, the other jobs and the reminders wait for the
  tick (web.mjs `tickRunning`).
  - 03:00 keeps it away from the reminders.
  - A Mac asleep at 03:00 catches up when it wakes, which can delay that morning's reminders by
    the review's length. Logged in docs/TODO.md.
- **Run now gives up in the UI after 5 minutes** (web/settings.js), but the run goes on, and the
  briefing arrives in the feed and by email.
- **A lane with one transient failure scores 0 on that test.** The margin absorbs most of it. The
  worst case is one swap the owner can Undo.
- **Vision scores are reported only.** `vision_default` names a referenced lane, so the vision
  lane stays the owner's choice.
- **Grader limits.** An answer can still try to sway its own score; the rubric scores that 1.
  An operator `claude_args` that passes `--mcp-config` would give the grader those MCP servers
  back, since `--strict-mcp-config` drops only the others. Logged in docs/TODO.md.
- **Merge notes.**
  - The `NO_TOOLS_ARGS` hunk in lib/one-shot.mjs is byte-identical to the unmerged branch
    `fix/digest-deny-tools`, so the two merge cleanly.
  - The local `@` neutralisation goes once `fix/prompt-at-path` merges: runClaude then does it
    for every prompt (TODO in lib/model-review-grade.mjs).
- **Warnings on every review.** `validateConfig` prints its usual warnings, such as a missing
  project dir, once per candidate.
- **Tests:**
  - test/model-review.test.mjs: settings, test data, checks, timed calls over HTTP, blind grading;
  - test/model-review-pick.test.mjs: the rule, sizing, due, the report;
  - test/model-review-flow.test.mjs: the real scheduler, job store, loader, watcher and runner,
    with an Ollama stub and a fake claude CLI, from the first report to Undo and the failures;
  - test/model-review-route.test.mjs: the real server, the Jobs rows, Run now, a grading failure;
  - updated: test/model-health.test.mjs, test/model-retired.test.mjs, test/config.test.mjs,
    test/jobstatus.test.mjs.
