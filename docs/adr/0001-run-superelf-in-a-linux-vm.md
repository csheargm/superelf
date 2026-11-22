# ADR 0001 — Run superelf in a Linux VM on a Windows PC, owned by a systemd user service

Status: accepted · 2026-10-11

## Context

- The owner's agent lane runs Claude Code with `--dangerously-skip-permissions`
  (`lib/config.mjs`). On a family Windows PC that reaches the family's files, credentials and home
  network. Windows offers no cheap, robust sandbox for "a process that may run anything".
- `install.sh` supported autostart only on macOS. On Linux it skipped the service, ran a `start.sh`
  that only knew `launchctl`, started nothing, and still printed "runs at boot from now on".
- `start.sh`/`stop.sh` matched processes with the literal `personal_agent/…` — the author's checkout
  name — so on any fresh clone (directory `superelf`) status lied and strays survived `stop.sh`.

## Decision

1. The Windows PC hosts superelf **inside an Ubuntu Server LTS VM**, as an isolation layer: NAT
   networking, no shared folders / clipboard / USB, ufw denying outbound to private LAN ranges, and
   Tailscale as a tagged node (`tag:superelf`) that family devices reach on 443 and that reaches
   nothing. Steps: `docs/vm-node.md`.
2. On Linux, web.mjs is owned by a **systemd user unit** `superelf-web`
   (`ops/superelf-web.service.template`) with `Restart=always` and linger enabled — the same
   one-owner model as launchd on macOS: `run.sh` refuses web while the unit is enabled or active,
   and `stop.sh` stops the unit rather than only killing the process.
   - A *user* unit, not a system one: the agent runs as the user, never as root, with that user's
     own Claude/Codex sign-in.
   - `Restart=always`, not `on-failure`: `/api/admin/restart` exits 0.
   - Logs go to the journal: no app code reads a log file.
3. Where no systemd user manager answers (WSL without systemd, containers), the installer installs no
   service and says so; the operator runs `./run.sh web` under their own supervisor.
4. Service names, the unit path and process patterns live once, in `ops/service.sh`; the full-path
   pattern is derived from the checkout's own directory name, regex-escaped.

## Consequences

- The agent's reach is bounded by the VM: Windows files and LAN devices are out of reach. It is
  **not** bounded inside superelf: family data, the signed-in AI accounts and internet egress stay
  exposed to it, by design.
- Local (on-device) models stay on the Mac: no GPU in the VM, and MLX is Apple-only.
- Boot autostart on Linux depends on linger. When it cannot be enabled the installer says, loudly,
  that the node will not start at boot.
- There must be one active node; migrating into the VM includes retiring the old one.
- `network-online.target` is not used: it exists only in the system manager, and a user unit cannot
  order after it. web.mjs does not need the network to start.
- Not verified on a real systemd in this change (no Linux host available, Docker daemon down):
  the scripts are exercised against recording fakes that model systemctl/loginctl exit codes.
