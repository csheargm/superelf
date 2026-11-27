# Plan: 自我发布 · Self-publish (the owner changes superelf from the main chat)

ADR: docs/adr/0044-self-publish.md. Approved by the owner 2026-11-25.

## Facts checked on the node (2026-11-25)

- The served code is `/data/superelf` (`node web.mjs`, `ROOT = dirname(web.mjs)`). On every start the
  entrypoint deletes `lib web tools workspace.example bible-data ops builtin-apps` there and untars
  `/opt/superelf` over it. So the agent's edits there were live until the next deploy, then gone.
- That folder also holds the node's secrets, so it cannot be removed or fenced as a folder. What is
  fenced is the agent: core changes run in their own jailed lane against a separate checkout.
- The stale web edits in `/data/superelf` are shipped by other workflows; this lane never writes there.

## Flow

1. Owner (composer, not an app) sends "改 superelf：… · change superelf: …".
2. Server: role gate → lock → sync `/data/superelf-src/repo` to origin/main → branch `self/<date>-<id>`.
3. Agent turn with `coreJailArgs`, cwd = checkout. Backstop on tool calls.
4. Server runs the affected tests and the iPhone render. Reply: server template, then the model's summary.
5. Under the reply: 发布 · Publish (phase 2). Preview shows files, diff, scan; security-relevant paths flagged.
6. Tap → PR → required checks → merge → release → self-deploy → "已上线 vX · Live".

## Phases (R2: one concern per session)

- (a) DONE: lib/selfpub/{checkout,lane,verify,run,routes,state}.mjs, coreJailArgs, shared
  `mergeAndRelease` and `openChangePR`, the route in web.mjs, tests on a fake GitHub + bare remote.
- (b) DONE: chat wiring in web.mjs `chatTurn`, the Publish control + one-time tip, typed 发布.
- (c) DONE: iPhone render runner (D3), prompt text, Playwright e2e, real-model run. A real PR is the owner's first tap.

## Tunables (config, read at use time)

`selfpub_root`, `selfpub_max_files` (40), `selfpub_max_diff_kb` (512), `selfpub_test_ms` (5 min),
`selfpub_max_mb` (300), `selfpub_lock_max_ms` (30 min, floor 5 min: a lock that stopped heartbeating this
long is reclaimed; lib/selfpub/lock.mjs). The token stays `github_publish_token`.

## Owner decisions (2026-11-25): see ADR 0044 "Owner decisions". Earlier open items, for the record:

- D1: also deny the owner's unrestricted composer lane writes under `/data/superelf` code (recommended).
- D2: tests run as the node uid and can read the node's config; recommended: a no-network test container.
- D3: the iPhone render needs a headless browser; recommended: in D2's container.
- D4: confirm the token has no `workflows` permission; `.github/` is never published from the node.
- D5: CI-only gate with GPT review nightly (chosen) vs waiting for the owner's Mac review.
- D6: with no renderer, a web change is "not ready" (chosen default).
- D7: the repo is public (the anonymous clone depends on it).
