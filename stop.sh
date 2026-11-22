#!/bin/bash
# Ownership model（进程归属）— ONE owner per process, no duelling supervisors:
#   web.mjs — OWNED BY THE OS SERVICE MANAGER. Stop = unload/stop the service
#             so it cannot respawn: macOS launchd com.superelf.web (KeepAlive)
#             → launchctl bootout; Linux systemd user unit superelf-web
#             (Restart=always) → systemctl --user stop. A bare
#             `pkill -f "node web.mjs"` MISSED launchd's full-path invocation
#             (/…/bin/node /…/<checkout>/web.mjs), and what it did kill
#             KeepAlive respawned instantly — the 6-agent scar.
# Stray manual runs are cleaned with patterns matching BOTH the full-path and
# the bare `node web.mjs` command lines (ops/service.sh derives the full-path
# one from this checkout's directory name).
cd "$(dirname "$0")" || exit 1
[ -f ops/service.sh ] || { echo "ops/service.sh is missing — refusing to run: it defines the service names and process patterns" >&2; exit 1; }   # explicit: a failed `.` aborts under set -e before any message
. ops/service.sh   # WEB_SVC, WEB_UNIT, UNIT_FILE, service_kind, *_pattern
DOMAIN="gui/$(id -u)"

stop_web_launchd() {
  if launchctl print "$DOMAIN/$WEB_SVC" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$WEB_SVC" && echo "web: launchd service $WEB_SVC booted out (unloaded — no KeepAlive respawn)"
  else
    echo "web: launchd service $WEB_SVC not loaded"
  fi
}

# Stop whenever the unit exists — NOT only when is-active says "active". Between two restarts the
# unit is "activating (auto-restart)", is-active answers no, and skipping the stop there would let
# systemd respawn node right after the pkill below.
stop_web_systemd() {
  if [ -f "$UNIT_FILE" ] || systemd_owns_web; then
    if systemctl --user stop "$WEB_UNIT"; then
      echo "web: systemd user service $WEB_UNIT stopped (Restart=always cannot respawn a stopped unit)"
    else
      echo "web: systemctl --user stop $WEB_UNIT FAILED — the strays below may be respawned"
    fi
  else
    echo "web: systemd user service $WEB_UNIT not installed"
  fi
}

case "$(service_kind)" in
  launchd) stop_web_launchd ;;
  systemd) stop_web_systemd ;;
  # No sweep either: pkill'ing the unit's node only gets it respawned, and "stopped" would be a lie.
  systemd-unreachable) explain_unreachable; exit 1 ;;
  *) echo "web: no service manager here — only strays to clean" ;;
esac

# Supervisors first (or they would respawn what we kill next), then strays.
# LEGACY bot cleanup: the Telegram bot was removed (docs/adr/0006), but a `run.sh bot` loop started
# before the update survives `git pull` and restarts the deleted bot.mjs every 2 s forever. So the
# three patterns still match `bot` as well as `web`, and the first stop after the update ends it.
# TODO(legacy-bot): drop `|bot` from these three lines once ADR 0006's one-time cleanup is confirmed
# on every node. Not sooner: deploy.sh never runs stop.sh, so a Linux node's leftover loop ends
# only when someone runs the cleanup.
pkill -f "run\.sh (web|bot)" 2>/dev/null && echo "supervisors: stray run.sh killed" || true
pkill -f "$(path_pattern 'web|bot')" 2>/dev/null && echo "strays: full-path node web/bot killed" || true
pkill -f "$(bare_pattern 'web|bot')" 2>/dev/null && echo "strays: bare node web/bot killed" || true

sleep 1
web_state=$(pgrep -f "$(proc_pattern web)" >/dev/null && echo STILL-RUNNING || echo stopped)
echo "web: $web_state"
