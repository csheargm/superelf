# ADR 0046 — 夜间代码审查 · Nightly review: GPT reviews the day's commits

Status: accepted, stage 1 built (2026-11-26). Stage 2 (auto-fix for other repos) is in docs/TODO.md.

## Context

Every change should get a second-opinion review (GPT), but running it by hand on each merge was slow, and
changes made from the node itself (ADR 0044) had nobody to review them. The private node already has the
Codex CLI signed in to the owner's ChatGPT subscription and the Claude CLI.

## Decision

1. **A built-in owner-only job** `nightly-review` (lib/nightly-review/), type digest, the same pattern as
   the model review (ADR 0017): its settings are read at every tick. Off unless set: `nightly_review` in
   config.json, or, when that key is absent, the `SUPERELF_NIGHTLY_REVIEW` env var (JSON) from a private
   node's compose file. Settings: `enabled`, `time`, `dir`, `codex_cmd`, `deadline_min`, `call_min`,
   `chunk_kb`, `max_verify`, `window_h`, `repos: [{ name, url, branch, fix: "selfpub"|"none" }]`.
2. **Read-only clones.** Each repo is an anonymous https clone under `<dir>/repos/<name>` through the core
   lane's ONE git helper (hooks off, scrubbed env, timeout). No token is ever given, and the push URL is
   set to an unreachable address. The reviewed superelf code is a fresh fetch of `origin/main`, never the
   core lane's working branch.
3. **Range.** `<dir>/state.json` keeps each repo's last reviewed commit. Range = that commit..the branch
   tip; the first run (or rewritten history) = the commits of the last `window_h` hours. No new commits =
   the project is one "No new commits" line; with nothing else to say, no briefing at all.
4. **Review.** Codex (`runCodex`: `--sandbox read-only`, timeout), cwd = the clone at the tip, one call per
   diff chunk (split on file boundaries; a file over the cap is cut and the email says so). The reply must
   be a JSON array; `[]` is the only "no findings". After each call the clone must still be clean.
5. **Verify.** Each finding (up to `max_verify`) goes to Claude with the read-only file tools only, no MCP,
   and `--setting-sources=` so the reviewed repo's `.claude/settings.json` (and its hooks) never load.
   The first line must be CONFIRMED or REJECTED; anything else is "unverified" and listed as such.
6. **Fix (superelf only).** `fix: "selfpub"`: the confirmed findings become ONE core-lane change (ADR 0044)
   run as the owner's composer turn: jail, server checks and privacy scan unchanged. It is saved as an
   owner chat "夜间审查修复 <date> · Nightly review fixes" whose reply carries 发布 · Publish. Nothing is
   published until the owner taps it (the ADR 0044 rule). A change already in flight = "not started".
   Later nights report its state once more until it is final ("Live vX", discarded).
7. **Failure is loud (R14).** A codex error, timeout, empty or unparsable reply, a dirty clone or the
   run deadline = "REVIEW FAILED: <why>" for that project, its range NOT marked reviewed (tried again
   the next night), and an audit line. One overall deadline caps the run.
8. **One email.** The job's briefing goes through the normal path (lib/notify.mjs, the owner's
   briefingEmail, plain text). Its subject is the job's own (`subject` in the job result):
   "Nightly review <date>: <n> confirmed[, <k> failed]". A sent briefing email is audited
   (`briefing-email-sent`, never the content).

## Consequences

- A `fix: "none"` repo gets findings only. Auto-fix for it needs its own deploy key and a
  redeploy step: stage 2, in docs/TODO.md.
- A private repo cannot be cloned anonymously; the fallback (a host timer that drops a `git bundle` into
  the node's data folder) is in docs/TODO.md, not built.
- The scheduler tick waits for the job (as for the model review): reminders due during the run wait too.
- Codex reads AGENTS.md in the reviewed repo as instructions (prompt injection can only steer its words:
  the sandbox is read-only, and Codex runs a project's hooks only after a saved trust, which is never given).
