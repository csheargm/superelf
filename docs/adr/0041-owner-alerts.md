# ADR 0041 — Owner alerts: ☰ attention dot, Needs attention card, fixed host actions

Date: 2026-11-24 · Status: accepted

## Context
Node health problems (disk over 80%, `claude --version` failing) reached the owner only as a row in
Settings → Activity log, mixed with routine rows. The owner asked for a visible cue for rare critical
problems and buttons that fix them, not just a warning. The private node runs in a container that
cannot run docker on the host, so it cannot prune or rebuild itself.

## Decision
- **Sources, reused:** the host health check (private overlay `superelf-health.sh`) now writes
  `node-health.json` in the node folder on every run; a passing run clears the alert. Plus the owner's
  own jobs whose latest outcome is `job-retries-exhausted` (cleared by the next good run).
- **UI (owner only):** an amber dot on ☰, pulsing softly (steady under reduced motion), while any
  alert is open and not snoozed. The drawer shows one card: what is wrong, what it means, 1–2 fix
  buttons, 再检查 · Check again, 今天不再提示 · Not today (server-side, capped at 24 h).
- **Host action channel:** the node writes an EMPTY file with a fixed name
  (`cleanup-disk`, `rebuild-node`, `recheck`; `NODE_ACTIONS` in `lib/node-alerts.mjs`) to
  `.node-actions/req/`. A host systemd path unit runs only the matching fixed script and writes
  `node-action-<name>.json` before removing the request. No arguments pass. Owner-only route,
  one request at a time, one per action per minute on both sides; links are refused or replaced,
  never followed. Buttons appear only when the host's health file lists the action (no helper, no button).
- **Not automatable:** what needs the owner on the VM (the disk passphrase, growing a data volume)
  opens the main chat with a request to 管家 filled in (never sent), and the card says so.
- **Activity log:** critical rows pinned on top for a week; routine runs fold into "label ×N".

## Consequences
Nodes without the private overlay (Mac, demo) show only job alerts and no host buttons. The rebuild
takes the node down for about 2 minutes; the button asks to confirm with that stated first.
