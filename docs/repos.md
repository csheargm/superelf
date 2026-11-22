# Repositories · 仓库

| Repo | Visibility | Holds |
|---|---|---|
| `csheargm/superelf` (this one) | public | **All code**: server, apps, tests, docs, demo ops. The only place code is written. |
| `csheargm/superelf-mine` | private | A small **overlay**: the owner's personal apps and private-node ops, laid onto a checkout of this repo. No code that any other instance needs. |

**Data and secrets are never in git, in either repo**: `config.json`, `workspace/` contents
(except the committed apps), tokens, `.env` files and backups stay on each machine (`.gitignore`).

## Overlay · 私有叠加层

`superelf-mine/overlay.sh <superelf-checkout>` copies its files onto a checkout (rsync, no
`--delete`). After it, `git status` stays clean: the overlay's files are ignored, never untracked
or modified. Ignoring is by generic patterns in this repo's `.gitignore` ("Private overlay" block:
`ops/private/`, `docs/private-*.md`, `test/private-*.test.mjs`, `privacy-terms.txt`), and each
overlay app under `workspace/apps/` carries its own `.gitignore` of `*`, so no personal app name
appears here. A new overlay path must fit one of those, or bring its own nested `.gitignore`.

## How each instance deploys · 各实例的部署

- **Public demo** (try.superelf.app): `git archive` of this repo's `main`, untarred on the demo VM,
  then `ops/demo/rebuild-demo.sh` (docs/demo-node.md). **No overlay.**
- **Owner's Mac node**: a checkout of this repo + the overlay; launchd runs `web.mjs`.
  Update: `git pull`, run `overlay.sh` again if the overlay changed, restart the service.
- **Future private VM node**: a checkout of this repo + the overlay (its ops live in the overlay).

## Privacy guard · 隐私防护

- `tools/privacy-scan.mjs` scans every tracked file for real email addresses, Tailscale
  hostnames, public IPv4 literals and key-shaped strings, plus the owner's own terms (names,
  school, city, hostnames). The terms are **not** in this repo: they are read from the git-ignored
  `privacy-terms.txt` (from the overlay) and `workspace/identity-denylist.txt` when present, so CI
  and strangers' clones run the generic rules only. Output gives file:line and rule, never the text.
- `test/public-privacy.test.mjs` runs it in `npm test` (and so in CI).
- Pre-push hook: `cp tools/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push`.
  It scans every outgoing commit not yet on the destination remote (added lines, file paths,
  author/committer names and emails, message, ref name), then the tree, and fails on a tracked
  overlay path whatever its contents. With no private terms loaded it fails (set
  `PRIVACY_SCAN_NO_TERMS=1` only in a clone that has no overlay).
  A term line `re:<regex>` is a case-insensitive pattern (e.g. a postcode range).
  Known limits: a regex scan, not proof; binary files are not read.
