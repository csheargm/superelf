# ADR 0039 — 发布应用 · Publish an app from the node to the public repo

Date: 2026-11-23 · Status: accepted (branch feat/publish-app) · Builds on ADR 0038

## Context

Today an app the owner builds on the private node reaches the public repo only by hand: copy the
files into a clone, run the privacy scan, commit, bump, push, deploy. The owner approved a one-tap
Publish action that does the same path with the same guards.

## Decision

1. **Trigger — owner only.** "发布 · Publish" is an item in the app's ⋯ menu (the shared menu
   component, not a new button), with a one-time 中文-first tip. The server checks the owner
   session on the endpoint itself (`POST /api/apps/<slug>/publish`); members never see the item and
   get 403 if they call it.
2. **What leaves the node — app CODE only.** The server collects `workspace/apps/<slug>/` files
   except `data/` and anything the reserved-path rule in `tools/privacy-scan.mjs` names (allow-list
   by kind: html/js/css/json-meta/svg/png; no symlinks; size cap). If the app is a starter, the
   starter copy goes with it, and `tools/gen-builtin-app-versions.mjs` regenerates its entry.
3. **Privacy gate — fail CLOSED.** The same scanner as pre-push (`tools/privacy-scan.mjs`, export
   a `scanText(files, terms)` function; one scanner, R3) runs over the collected files with the
   generic patterns plus the owner terms from `privacy-terms.txt` and
   `workspace/identity-denylist.txt`. On the publishing node, BOTH term files must exist and be
   non-empty, else Publish refuses ("隐私词表缺失 · Privacy terms missing"); CI's "no terms, generic
   only" mode never applies here. An identity/PII heuristic (emails, phones, street addresses,
   person-name-shaped strings next to the owner's terms) runs too. Any hit stops the publish and
   returns file:line plus the line text to the OWNER's browser only (this is the owner's own code
   on screen, unlike hook output), so the owner fixes it on the spot and taps Publish again.
4. **Token.** A fine-grained PAT, repo = csheargm/superelf only, permissions contents:write +
   pull-requests:write. New `adminconfig` field `github_publish_token`, `kind: 'secret'`,
   `advanced: true` — stored like the other node secrets: write-only, never serialized to the
   browser, never logged (logger redacts by field kind). Until set, Publish shows
   "需要 GitHub 令牌 · GitHub token needed" with three how-to steps and a link to Node settings.
5. **PR via GitHub REST.** Branch `publish/<slug>-<yyyymmdd>` off the current main sha (git data
   API: blobs → tree → commit → ref), PR title `发布 <name> · Publish <name>`, body lists the files
   and the scan result. One publish per slug in flight (lock).
6. **Merge + release (keeps ADR 0038's guarantee).** The node polls the PR's check runs (no
   inbound webhook, no new port). All green → merge with a merge commit (first-parent merge, so
   `bump-version.mjs` counts it). Then the node, in a throwaway clone of the public repo, runs
   `node tools/bump-version.mjs`, commits `release: vX.Y.Z` and pushes it with the same token. If
   main moved, it re-fetches and re-runs (max 3). GitHub auto-merge is NOT used: it would merge
   with nothing to cut the release, leaving an unreleased merge on main. This is a bump commit
   by a tool, not by CI: failures are visible in the owner's notice, not silent (the 0038 scar).
   The `--check` in deploy-vm.sh stays; an unreleased merge still cannot deploy.
7. **VM self-deploy.** A systemd timer in superelf-mine `ops/private/` (every 10 min) runs
   `update-if-released.sh`: flock; fetch origin/main; proceed only if the tip is a `release:`
   commit, `bump-version.mjs --check` passes, and the tip's CI conclusion is success (public API,
   no token needed); then run the existing deploy-vm.sh path; verify REVISION == sha, containers
   healthy, try.superelf.app 200; log to journald. Any doubt = no deploy. Outbound only.
8. **Notice.** The owner gets an in-app notice: "已发布 vX.Y.Z · Published" with the PR link, or the
   step that failed and why (scan hit, token missing/expired, CI red, merge conflict, release push
   refused). A red CI leaves the PR open for the owner; nothing is force-merged.

## Threat model

- **Who can trigger:** only the owner session. A member can edit an app they share, but cannot
  publish it; the owner sees the diff in the PR before it is merged by CI-green.
- **Supply chain:** a member's malicious edit reaches public only if the owner taps Publish. The
  PR body shows changed files; CI (tests + privacy scan) must pass. Residual risk: the owner
  publishes without reading — mitigated by showing the diff summary in the confirm sheet.
- **What leaves:** app code files only, after a fail-closed scan; never data/, notes, config,
  tokens. Paths are resolved and must stay inside the app dir (no `..`, no symlinks).
- **Token scope:** one repo, contents + PRs; leak = can push to this public repo (it could
  already be pushed by the owner). Owner rotates it in GitHub; expiry surfaces as a notice.
- **PR failure:** branch and PR stay open; nothing merged, nothing released, nothing deployed.
- **Deploy:** the VM pulls only a released, green tip; no new inbound ports.

## Consequences

- The bump moves from "human after merge" to "node after merge" for published apps; hand ships
  keep the ADR 0038 flow. Local main goes stale after a publish — deploy-vm.sh's refusal then
  means "pull first", which is correct.
- New code: lib/publish/*.mjs (collect, scan, github, release), one adminconfig field, one menu
  item + tip, one notice type; overlay: one script + timer.

## Addendum (2026-11-24): publish hardening
- Term files default to `/data/.publish-terms/` when that folder exists (`publish_terms_root` still
  overrides); a missing or empty term file still refuses.
- The server refuses a forked app (`meta.forkedFrom`) for preview and publish (`FORKED_APP`).
- Preview answers a sha256 of the collected snapshot; Publish collects again and refuses unless the
  hash matches (`SNAPSHOT_CHANGED`), so the owner publishes exactly the bytes they confirmed.
- PII rules are tested with lastIndex reset, so a /g rule can never skip a match.

## Addendum (2026-11-24): Publish says what it does
- The ⋯ item reads "发布到公开仓库 · Publish to the public repo" with a second line from
  `GET /api/apps/<slug>/publish` → `repo: { inRepo, upToDate, changedFiles }` (lib/publish/status.mjs):
  not in the repo → "Share as a public app"; same bytes as the repo copy → greyed "Already up to date";
  else "N changes not yet published". The repo copy is `<code root>/workspace.example/apps/<slug>/`
  collected exactly as Publish collects (meta sanitized); local only, no GitHub call, cached 10 s.
  After a publish it reads "changed" until the release is deployed to this node.
- The confirm sheet's first line explains the whole path: privacy scan, PR on GitHub, CI, merge,
  part of superelf for everyone, on the demo after the next deploy.
