#!/bin/bash
# Install superelf on macOS / Linux · 安装
#
#   git clone https://github.com/csheargm/superelf.git && cd superelf && ./install.sh
#
# Idempotent: run it again after a `git pull` and it re-installs the service without touching
# config.json, your workspace, or the owner account. It never overwrites data. On Linux the re-run
# also restarts the service, so the new code runs; on macOS follow it with ./stop.sh && ./start.sh.
#
# Until now there was no installer at all, and the documented start path was broken on every
# machine but the author's: start.sh requires ~/Library/LaunchAgents/com.superelf.web.plist and
# pointed at "the docs" for it, but no plist and no such doc were ever committed. This script
# renders it from ops/com.superelf.web.plist.template — and on Linux, a systemd user unit from
# ops/superelf-web.service.template (see docs/vm-node.md for running it in a VM).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
[ -f ops/service.sh ] || { echo "ops/service.sh is missing — refusing to run: it defines the service names and process patterns" >&2; exit 1; }   # explicit: a failed `.` aborts under set -e before any message
. ops/service.sh   # WEB_UNIT, UNIT_FILE, service_kind — one definition shared with start/stop/run.sh

# --no-service: do everything except install the service (launchd agent / systemd user unit) and
# start the node. For a machine whose service you manage yourself, and for testing this script
# without touching a running node.
NO_SERVICE=0
for a in "$@"; do
  case "$a" in
    --no-service) NO_SERVICE=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$1"; }
die() { printf '\n!! %s\n' "$1" >&2; exit 1; }

# Never as root: the service, config.json and the workspace must belong to the user who runs the
# node. Under sudo there is no user bus either, so the install would quietly skip the service.
[ "$(id -u)" != 0 ] || die "run ./install.sh as your normal user, not root or sudo — it asks for sudo itself where needed"

say "Checking prerequisites · 检查依赖"

# INSTALL what is missing rather than telling you to go away and come back. The floor comes from
# package.json so it cannot drift from what the app actually requires (R3).
FLOOR="$(node -e 'const m=/(\d+)/.exec(require("./package.json").engines.node);console.log(m?m[1]:22)' 2>/dev/null || echo 22)"

pkg_install() {   # pkg_install <what> <brew-formula> <apt-package>
  if command -v brew >/dev/null; then echo "   installing $1 with brew..."; brew install "$2" && return 0; return 1; fi
  if command -v apt-get >/dev/null; then
    echo "   installing $1 with apt (sudo may prompt)..."; sudo apt-get install -y "$3" && return 0; return 1
  fi
  return 1
}

if ! command -v node >/dev/null; then
  echo "   Node is missing."
  pkg_install "Node" node nodejs || die "could not install Node automatically.
Install Node ${FLOOR}+ from https://nodejs.org (or brew/apt/nvm) and run this again."
fi
command -v node >/dev/null || die "Node still not on PATH after installing. Open a new terminal and run this again."

# `node -v`, never `node -p` with quotes: that form breaks under Windows PowerShell 5.1 and this
# script shares the habit deliberately so the two installers do not drift apart.
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt "$FLOOR" ]; then
  echo "   Node $NODE_MAJOR is below the required $FLOOR."
  pkg_install "a newer Node" node nodejs || true
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  [ "${NODE_MAJOR:-0}" -ge "$FLOOR" ] || die "Node is still $NODE_MAJOR. Upgrade to ${FLOOR}+ and run this again."
fi
echo "   node $(node -v) at $NODE_BIN"

# Claude Code is what actually answers; without it the node starts and every turn fails.
if ! command -v claude >/dev/null; then
  echo "   Claude Code CLI is missing."
  if command -v npm >/dev/null; then npm i -g @anthropic-ai/claude-code || true; fi
fi
if command -v claude >/dev/null; then
  echo "   claude at $(command -v claude)"
else
  echo "   WARNING: could not install the Claude Code CLI automatically."
  echo "            npm i -g @anthropic-ai/claude-code   — superelf will start, but every turn will fail."
fi

# Signing in is interactive; nothing can automate it, so say so rather than letting every turn fail
# later with no explanation.
echo "   NOTE: if you have not already, run 'claude' once and send it a message to sign in."

say "Configuration · 配置"
if [ -f config.json ]; then
  echo "   config.json already exists — left untouched."
else
  cp config.example.json config.json
  echo "   created config.json from the example."
fi

say "Owner account · 主账号"
# setup.mjs refuses on a node that already has an owner, so this is safe to re-run.
node setup.mjs || echo "   (skipped — see the message above)"

# ── The service that owns web.mjs · 后台服务 ───────────────────────────────────────────────────
# One function per owner. The closing message is built from what each branch actually achieved:
# on Linux this script used to install no service, start nothing (start.sh only knew launchctl)
# and still print "runs at boot from now on".

install_launchd() {
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"
  LOG="$HOME/Library/Logs/superelf.log"
  # PATH is spelled out because a launchd agent gets no login shell: nvm's shims and ~/.local/bin
  # are absent, and `claude` must resolve or every turn fails with ENOENT.
  SVC_PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__ROOT__#$ROOT#g" \
      -e "s#__PATH__#$SVC_PATH#g" -e "s#__LOG__#$LOG#g" \
      ops/com.superelf.web.plist.template > "$PLIST_DIR/com.superelf.web.plist"
  plutil -lint "$PLIST_DIR/com.superelf.web.plist" >/dev/null || die "generated plist is invalid — this is a bug, please report it"
  echo "   installed $PLIST_DIR/com.superelf.web.plist"
  echo "   logs: $LOG"
}

# The unit's PATH: node's own dir first (an nvm node's npm -g lands there), then wherever claude and
# codex resolve right now, then the usual dirs. A user service gets no login shell either.
unit_path() {
  local p d c
  p="$(dirname "$NODE_BIN")"
  for c in claude codex; do
    d="$(command -v "$c" 2>/dev/null)" && p="$p:$(dirname "$d")"
  done
  printf '%s' "$p:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# A value for a sed replacement AND a systemd unit: % is a systemd specifier (%% is a literal one),
# & and # are special to this sed. " \ $ would need systemd quoting rules of their own; refuse them.
unit_val() {
  case "$1" in *[\"\\\$]*) die "cannot write a systemd unit for a path containing \" \\ or \$: $1
Move superelf (or node) to a plainer path and run this again." ;; esac
  printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/[&#]/\\&/g'
}

install_systemd() {
  local path node root
  path="$(unit_val "$(unit_path)")"; node="$(unit_val "$NODE_BIN")"; root="$(unit_val "$ROOT")"
  mkdir -p "$(dirname "$UNIT_FILE")"
  sed -e "s#__NODE__#$node#g" -e "s#__ROOT__#$root#g" -e "s#__PATH__#$path#g" \
      ops/superelf-web.service.template > "$UNIT_FILE"
  if command -v systemd-analyze >/dev/null; then
    # Advisory, not a gate: verify can fail for reasons outside the unit (no user bus, a target it
    # cannot load), and aborting every Linux install on that is worse than the miss. A unit that is
    # really broken still stops the install below, where enable/restart fail.
    systemd-analyze --user verify "$UNIT_FILE" ||
      echo "   !! systemd-analyze reported problems with $UNIT_FILE (above). Continuing; if the start fails, report it."
  fi
  systemctl --user daemon-reload || die "systemctl --user daemon-reload failed"
  systemctl --user enable "$WEB_UNIT" || die "could not enable $WEB_UNIT — see: journalctl --user -u $WEB_UNIT"
  # restart, not `enable --now`/start: those are no-ops on a running unit, so a re-run after a
  # `git pull` (or after migrating config.json in) left the OLD process serving — and that process
  # writes its in-memory users back over the migrated config.json. restart starts a stopped unit too.
  systemctl --user restart "$WEB_UNIT" || die "could not start $WEB_UNIT — see: journalctl --user -u $WEB_UNIT"
  echo "   installed $UNIT_FILE (enabled, restarted)"
  echo "   logs: journalctl --user -u $WEB_UNIT"
}

# LINGER is what makes a user service start at BOOT: without it systemd runs your user services only
# while you have a session, so the node would start at login and die at logout. Trust the RE-CHECK,
# not enable-linger's exit code — the state is the only honest signal.
ME="${USER:-$(id -un)}"
linger_on() { [ "$(loginctl show-user "$ME" --property=Linger --value 2>/dev/null)" = yes ]; }
ensure_linger() {
  if linger_on; then echo "   linger already on for $ME"; return 0; fi
  loginctl enable-linger "$ME" 2>/dev/null ||
    { echo "   enabling linger needs admin rights — sudo may prompt"; sudo loginctl enable-linger "$ME"; } || true
  if linger_on; then echo "   linger enabled for $ME — the service starts at boot, nobody logged in"; return 0; fi
  cat >&2 <<EOT

   !! LINGER IS OFF for $ME — enabling it was refused.
   !! superelf will NOT start at boot, and it STOPS when you log out: without linger, systemd runs
   !! your user services only while you have a session. Fix it once, nothing else is needed:
   !!     sudo loginctl enable-linger $ME
EOT
  return 1
}

explain_no_service() {
  echo "   No service manager to own web.mjs here: not macOS, and no systemd user session answers"
  echo "   (WSL without systemd, a container, or a shell with no user bus). Nothing was installed."
  echo "   Run ./run.sh web under a supervisor you already have (supervisord, tmux, a container's"
  echo "   init). run.sh restarts on ANY exit, which the in-app Restart needs."
  echo "   WSL: add [boot] systemd=true to /etc/wsl.conf, run 'wsl --shutdown', then run this again."
}

say "Background service · 后台服务"
SERVICE=none   # who owns web.mjs once this section is done: launchd | systemd | none
LINGER=no
if [ "$NO_SERVICE" = "1" ]; then
  echo "   skipped (--no-service)"
else
  SERVICE="$(service_kind)"
  case "$SERVICE" in
    launchd) install_launchd ;;
    systemd) install_systemd; if ensure_linger; then LINGER=yes; fi ;;
    systemd-unreachable) explain_unreachable; die "not installed — run ./install.sh from a shell that reaches your systemd user manager" ;;
    *) explain_no_service ;;
  esac
fi

if [ "$NO_SERVICE" = "1" ]; then
  say "Not started (--no-service). Start it with ./start.sh"
  exit 0
fi

if [ "$SERVICE" = none ]; then
  cat <<EOF

Installed, but superelf is NOT running and will NOT start at boot: there is no service manager
here to own it (see above). Start it with ./run.sh web under your own supervisor.
EOF
  exit 0
fi

say "Starting · 启动"
./start.sh

if [ "$SERVICE" = launchd ]; then
  cat <<EOF

Done. superelf runs at boot from now on.
  ./start.sh    start        ./stop.sh   stop
Open it at http://localhost:8787. For phones: tailscale serve (README), or set bind_host in config.json.
EOF
elif [ "$LINGER" = yes ]; then
  cat <<EOF

Done. superelf runs at boot from now on (systemd user service $WEB_UNIT, linger on).
  ./start.sh    start        ./stop.sh   stop        journalctl --user -u $WEB_UNIT -f   logs
Open it at http://localhost:8787 — or over Tailscale, see docs/vm-node.md.
EOF
else
  cat <<EOF

Installed and running — but superelf will NOT start at boot, and it stops when you log out:
linger is off (see the !! lines above). Fix: sudo loginctl enable-linger $ME
  ./start.sh    start        ./stop.sh   stop        journalctl --user -u $WEB_UNIT -f   logs
EOF
fi
