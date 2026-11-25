# ADR 0044 — 自我发布 · Self-publish: the owner changes superelf from the main chat

Status: accepted, phases 1–3 built (2026-11-25). Plan: docs/plans/self-publish.md.

## Context

The owner's main-chat agent "fixed" superelf by editing `/data/superelf/web/*`. That folder is the
running server, but the container entrypoint untars `/opt/superelf` over it on every start, so every
deploy wiped the edits, and the agent said "fixed" without checking anything. There was no git, no
test run, no review and no way to ship the change.

## Decision

1. **A real checkout, not the served files.** Core changes happen in a git clone of the public repo at
   `<selfpub_root>/repo` (default `/data/superelf-src/repo`), outside the served folder, one branch per
   request (`self/<yyyymmdd>-<id>`). Anonymous https clone; the token is never in `.git/config`. Every
   git call disables hooks (`core.hooksPath=/dev/null`) and runs with a scrubbed env. One change in
   flight per node (lockfile). `lib/selfpub/checkout.mjs`.
2. **A jailed lane.** `coreJailArgs` (lib/agent-origin.mjs): no bypass, `default` mode, file tools only
   (no Bash, no Web, no MCP, no settings files), Edit allowed only under the checkout, never its `.git`,
   `.github`, dot-names or agent instruction files. After the turn the server checks every file tool call
   (even denied ones); a path outside the checkout undoes the whole turn (`JAIL_BREACH`).
   `lib/selfpub/lane.mjs`.
3. **The server verifies, the model never claims.** The server runs the affected tests (`node --test`,
   scrubbed env, temp HOME, timeout; zero tests = failure, R14) and the iPhone render. The reply's first
   lines are a server template: "可以发布 · Ready to publish" or "未通过检查 · Checks failed". It never
   says done or fixed. `lib/selfpub/verify.mjs`.
4. **Nothing leaves before the tap.** `POST /api/selfpub/<id>/preview` sends nothing. `POST …/publish`
   with the preview's hash runs the same deny list, caps and strict privacy scan (files, diff, title,
   branch), then opens the PR through the git data API (token in a header only). Any refused path
   (`.github/`, `ops/private`, `.env*`, `config.json`, `*token*`, `*auth*.json`, symlinks, binaries)
   refuses the whole change.
5. **Same merge and release as app Publish (ADR 0039).** `mergeAndRelease` is now shared: checks →
   merge → `cutRelease`. The node does not use GitHub auto-merge (ADR 0038/0039 still hold). After the
   release the existing self-deploy timer deploys it; state is kept in `<selfpub_root>/state.json` so the
   restarted node can say "已上线 vX · Live", or "已合并，等待部署 · Merged, waiting for deploy" after 30 min.
6. **Owner only, decided on the server.** The lane and the routes refuse members, guests, app-originated
   turns and the demo (403). A change belongs to the user who made it (404 for anyone else).
7. **GPT review rides the nightly run.** The repo has no review hook a node can run (the gpt-review skill
   is the owner's local Codex CLI). Core PRs gate on the required CI checks only; the PR body and the
   reply say so.

## Owner decisions (2026-11-25)

1. **Code is tested by GitHub CI only.** The node never runs code the agent wrote. A change that is only
   .css/.md gets the repo's own (trusted, unchanged) tests run on the node; any other change says
   "CI 会测试 · CI will test this" and is offered for Publish; Publish merges only on green CI
   (`mergeAndRelease`). The earlier `selfpub_test_sandbox` option is gone.
2. **A small headless browser on the private image only** (`ops/demo/Dockerfile` `RENDER_BROWSER`:
   playwright-core + Chromium headless shell; the demo has none). `lib/selfpub/render.mjs` renders Home at
   iPhone width (390×844) from origin/main (before) and the checkout (after). The page is assembled by the
   node's own `lib/shellhtml.mjs`; every request is answered from memory (a fixed fake owner for /api/*),
   anything else is aborted, and the browser has a dead proxy and a resolver that maps every name to
   nothing. A change that makes Home wider than the phone fails the check. The page's own JS runs only
   inside Chromium (no sandbox in a cap-less container: a Chromium bug is the remaining risk).
3. **Served code is read-only to the main-chat agent.** Its args deny Edit on every served code path and
   on the checkout (`ownerCodeDenies`); the private entrypoint `chmod -R a-w`s the code folders after
   each untar (and makes them writable again before the next one). Same uid, so this stops edits by
   mistake and every shell write, not a deliberate `chmod` (a kernel boundary would need root-owned
   files, which `cap_drop: ALL` rules out). Node data and config stay writable; the server still starts
   and updates (the entrypoint runs before it).
4. **GPT review at Publish = CI + the nightly GPT review** (§7 above).

## Phase 2–3 (built)

- Ways in (`lib/selfpub/chat.mjs`), owner composer only: a typed "改 superelf：…" / "change superelf: …";
  the main agent's one-line hand-over `PA_CHANGE_SUPERELF: <request>` (`MAIN_CHAT_RULE` in its prompt);
  a typed 发布 / publish opens the conversation's ready change's preview (never sends by itself).
  Anyone else typing the prefix gets one plain line and no model runs.
- A follow-up request in the same conversation builds on its open change (a local snapshot commit puts
  the earlier edits back if the follow-up fails); the earlier one is marked superseded.
- Under the reply: 发布 · Publish (web/selfpub.js, reusing PAPublish's sheet, R3) with a first-use tip
  (中文 first). The preview shows the checks, the before/after shots, the files (security-relevant ones
  flagged), the diff, and 丢弃 · Discard. Progress is said on the line: PR opened — CI running → merging →
  released vX — waiting for deploy → 已上线 vX · Live.

## Consequences

- No test sandbox is needed; a code change is only as tested as CI is.
- The render is of Home only, with a fake empty owner; a change that only shows inside an app or with
  real data is not seen by it (the reply says what was rendered).
- The private image grows by the browser: measured 343 MB → 1 GB with its system libraries (2026-11-25, arm64); the build guard checks
  disk before each build.

## GPT review round 1 (2026-11-25) — adopted
- Tests ran agent-edited code as the node uid → sandbox gate above.
- Backstop checked path spelling → resolves symlinks; reads (Read/Glob/Grep) are checked too.
- Git trusted outside config → all `GIT_*` dropped, no global/system config, hooks off (checkout and release).
- Token echoed in a GitHub error → scrubbed raw and Base64 forms; fetch and release git have timeouts.
- New files showed only as a name → preview diff includes their content; a diff too long to show is refused.
- package.json / lockfile / .npmrc could fake CI → never published; deleting a test is refused.
- Shortcut API key could publish → refused on these routes (session only).
- Tree could change after verify → verify stores a tree hash; Publish refuses a mismatch. The PR's parent is
  the change's base commit, so an upstream edit to the same lines conflicts instead of being undone.
- Stale discard wiped a newer change → discard takes the lock and only touches its own branch.
- All-skipped or non-zero-exit test runs counted as a pass → failure. Dead-process lock reclaimed; a turn
  that throws leaves no dirty branch; merged-but-unreleased is `merged`, never `ready` again.
- Deferred to docs/TODO.md: resume a partial publish, live-status latch, deploy-timer revision checks.
- Agent instruction files (CLAUDE.md, AGENTS.md) can never be changed from this lane.
- Open owner decisions D1, D2, D4, D5, D7: see the plan §9.

## GPT review round 2 (2026-11-25) — adopted
- Without a sandbox only tests tracked at origin/main and unchanged are run, and any ignored file blocks the run.
- Backstop rejects a symlink whose real target is a dot-path; git env filter is case-insensitive (Windows).
- Token scrubbed before an error page is cut; truncated TAP (no `# fail`) is not a pass.
- `--literal-pathspecs` (a file named `:x`), `diff --text` (a .gitattributes 'binary' cannot hide content),
  executable bit kept in the PR, tree hash taken before the checks and compared after.
- Discard re-reads state under the lock; a dirty self/* branch no saved change owns (crash) is discarded.
- Rejected/deferred: stale-lock race and the no-PIN API-key case (docs/TODO.md).
- Round 3: the tree hash includes the executable bit; discard also removes ignored files (`clean -x`).
