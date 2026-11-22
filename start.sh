#!/bin/bash
# Ownership model（进程归属）— ONE owner per process, no duelling supervisors:
#   web.mjs — OWNED BY THE OS SERVICE MANAGER, never by run.sh:
#             macOS: launchd com.superelf.web (~/Library/LaunchAgents/
#             com.superelf.web.plist, KeepAlive). Start = launchctl bootstrap
#             (load) or kickstart (already loaded).
#             Linux: systemd user unit superelf-web (Restart=always).
#             Start = systemctl --user start.
#             A second supervisor duelled launchd over the port (EADDRINUSE
#             crash loop, the 6-agent scar).
cd "$(dirname "$0")" || exit 1
[ -f ops/service.sh ] || { echo "ops/service.sh is missing — refusing to run: it defines the service names and process patterns" >&2; exit 1; }   # explicit: a failed `.` aborts under set -e before any message
. ops/service.sh   # WEB_SVC, WEB_UNIT, UNIT_FILE, service_kind, proc_pattern
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$WEB_SVC.plist"

start_web_launchd() {
  if launchctl print "$DOMAIN/$WEB_SVC" >/dev/null 2>&1; then
    launchctl kickstart "$DOMAIN/$WEB_SVC" && echo "web: launchd service $WEB_SVC kickstarted (was loaded)"
  elif [ -f "$PLIST" ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" && echo "web: launchd service $WEB_SVC bootstrapped from $PLIST"
  else
    echo "web: NOT started — $PLIST missing. web.mjs is launchd-owned; install the plist (see docs), never run it under run.sh."
  fi
}

# `systemctl start` is a no-op on a running unit, so it is both bootstrap and kickstart.
start_web_systemd() {
  if [ -f "$UNIT_FILE" ]; then
    if systemctl --user start "$WEB_UNIT"; then
      echo "web: systemd user service $WEB_UNIT started"
    else
      echo "web: systemctl --user start $WEB_UNIT FAILED — see: journalctl --user -u $WEB_UNIT"
    fi
  else
    echo "web: NOT started — $UNIT_FILE missing. web.mjs is systemd-owned; run ./install.sh, never run it under run.sh."
  fi
}

case "$(service_kind)" in
  launchd) start_web_launchd ;;
  systemd) start_web_systemd ;;
  systemd-unreachable) explain_unreachable ;;
  *) echo "web: NOT started — no service manager here (no launchd, no systemd user session). Run ./run.sh web under your own supervisor." ;;
esac

sleep 2
web_state=$(pgrep -f "$(proc_pattern web)" >/dev/null && echo up || echo down)
echo "web: $web_state"
