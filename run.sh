#!/bin/bash
# Supervisor: keeps web.mjs alive, restarting it if it exits. Usage: ./run.sh web
# Ownership model（进程归属）: in production web.mjs is OWNED BY THE OS SERVICE
# MANAGER — launchd com.superelf.web (KeepAlive) on macOS, the systemd user
# unit superelf-web (Restart=always) on Linux; see start.sh/stop.sh. This
# supervisor is for a machine WITHOUT that service only — refusing otherwise
# stops the duelling-supervisor EADDRINUSE crash loop.
cd "$(dirname "$0")" || exit 1
[ -f ops/service.sh ] || { echo "ops/service.sh is missing — refusing to run: it defines the service names and process patterns" >&2; exit 1; }   # explicit: a failed `.` aborts under set -e before any message
. ops/service.sh   # WEB_SVC, WEB_UNIT, service_kind, systemd_owns_web, explain_unreachable
target="${1:-web}"
[ "$target" = web ] || { echo "usage: ./run.sh web — web.mjs is the only server this supervises" >&2; exit 1; }
script="${target}.mjs"
[ -f "$script" ] || { echo "no $script"; exit 1; }
case "$(service_kind)" in
  launchd)
    if launchctl print "gui/$(id -u)/$WEB_SVC" >/dev/null 2>&1; then
      echo "refusing: web.mjs is owned by the $WEB_SVC launchd service — use ./start.sh (launchctl), not run.sh"
      exit 1
    fi ;;
  systemd)
    if systemd_owns_web; then
      echo "refusing: web.mjs is owned by the $WEB_UNIT systemd user service — use ./start.sh (systemctl --user), not run.sh"
      exit 1
    fi ;;
  systemd-unreachable) explain_unreachable; echo "refusing: run.sh will not supervise a second web.mjs"; exit 1 ;;
esac
echo "[supervisor] watching $script — $(date)"
while true; do
  node "$script" >> "${target}.log" 2>&1
  code=$?
  echo "[supervisor] $script exited ($code) — restarting in 2s $(date)" >> "${target}.log"
  sleep 2
done
