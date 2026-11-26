# ADR 0038 — The version is bumped by a tool at ship time

Date: 2026-11-23 · Status: accepted (branch feat/auto-version) · Amends ADR 0026

## Context

package.json said 5.0.0 from 2026-10-12 while every change since shipped; the Release Notes sheet
(版本记录 · Release Notes) kept `v5.0.0 · current` above a hand-written list. ADR 0026's `+N`
suffix said "something changed" but the number itself never moved, because a bump (version.sh) was
a human act. The owner asked that "the version number should increase accordingly".

## Decision

1. **`tools/bump-version.mjs`** (rules in `lib/version-bump.mjs`) reads the first-parent merges on
   main since the newest release and writes package.json + a `version-notes.json` entry per merge
   day: feat branch → minor, any other → patch, `type!:` / `BREAKING CHANGE` → major; minor capped
   at 99 exactly like version.sh (a test runs both). Items are the merge titles (already plain
   text, many bilingual), no AI call; a day of internal-only merges (ci/test/docs) reads
   `内部改进 · Internal upkeep`. Each entry records `through` = the last merge it covers.
2. **The release base is ONE answer (R3):** `releaseBase()` in `lib/version-auto.mjs` = the newest
   entry's `through`, else the newest tag. The footer's `+N`, the sheet's auto entry and the bump
   tool all count from it, so after a bump the footer reads the plain new version.
3. **Idempotent:** no merge after `through` → nothing changes. The bump itself is a direct commit
   `release: vX.Y.Z` on main, which is not a merge, so it never counts as new work.
4. **Wiring — a refusing check, not a CI commit.** `bump-version.mjs --check` exits 1 with the one
   fix command when merges are unreleased. It runs in `tools/pre-push.sh` when pushing from main and
   in the overlay's `ops/private/deploy-vm.sh` before any deploy. Chosen over a CI job that commits
   the bump because (a) deploy-vm.sh requires main == origin/main, so a CI commit makes every local
   main stale and the next deploy refuse for an unrelated reason; (b) a CI job that fails or is
   skipped (forks, disabled Actions, rate limits) fails *silently* — the version just stops
   moving, the exact scar. A check on the path that ships cannot be skipped without noticing:
   the deploy stops and prints the command.

Ship flow: merge → `node tools/bump-version.mjs` → `git commit -am "release: vX.Y.Z"` → push → deploy.

## Consequences

- The first run (catch-up) wrote one entry per merge day since the public history began.
- Tags stay optional milestones; `version.sh` still works for a hand-picked bump.
- Items are English where the merge title is English; a bilingual title stays bilingual. Writing
  merge titles as `中文 · English` makes the notes bilingual at no cost.
- A shallow clone without the `through` commit counts nothing (+0) — same degradation as ADR 0026.

## Addendum 2026-11-25: release time（发布时间）

Many releases ship per day, so the footer's date alone did not say which one was running.
`tools/bump-version.mjs` now records each new entry's `time` (UTC ISO, the one source).
`lib/version-time.mjs` hands it to the Settings footer (`data-vtime`), and `web/version-time.js`
shows it in the viewer's zone as `MM-DD HH:mm` (with the year when it is not the current year),
with a tooltip giving the full date-time and zone. The release-notes sheet shows it the same way.
The time is drawn with CSS `::after`, so the footer text that PAUpdate compares with `/api/build`
does not depend on the viewer's zone. Releases from before `time` existed show their date only.
