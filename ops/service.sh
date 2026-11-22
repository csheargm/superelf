# shellcheck shell=bash
# Who owns web.mjs on this machine · 服务归属 — sourced by install.sh, start.sh, stop.sh, run.sh.
#
# ONE definition (R3) of the service names, the unit path, the "is a service manager here" probe and
# the process patterns, because the four scripts must agree on all of them or the ownership model
# breaks: a run.sh that cannot see the service duels it over the port (the 6-agent scar), and a
# stop.sh whose pattern misses the service's command line leaves strays running.

SUPERELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_SVC="com.superelf.web"     # macOS: launchd label
WEB_UNIT="superelf-web"        # Linux: systemd USER unit (ops/superelf-web.service.template)
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$WEB_UNIT.service"

# service_kind → launchd | systemd | systemd-unreachable | none
# "systemd" means a systemd USER manager answers right now, not merely that systemctl exists: WSL
# without systemd and most containers ship the binary and fail every call ("System has not been
# booted with systemd"), and an installer that trusted the binary would claim a service it never
# installed.
# "systemd-unreachable": the unit IS installed but this shell has no user bus (su, sudo -iu, cron).
# systemd still owns web.mjs there; calling that "none" let run.sh supervise a second web.mjs (the
# EADDRINUSE duel) and stop.sh pkill a node Restart=always respawned, then report "stopped".
service_kind() {
  case "$(uname -s)" in
    Darwin) echo launchd ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        echo systemd
      elif [ -f "$UNIT_FILE" ]; then
        echo systemd-unreachable
      else
        echo none
      fi ;;
    *) echo none ;;
  esac
}

# The one explanation for "systemd-unreachable" (R3), printed by every script that refuses there.
explain_unreachable() {
  cat >&2 <<EOT
web: the $WEB_UNIT systemd user unit is installed ($UNIT_FILE), but this shell cannot
     reach your systemd user manager (no user bus: su, sudo -u, cron). systemd still owns web.mjs,
     so nothing was started, stopped or supervised from here. Log in directly or over SSH as
     $(id -un), or run: export XDG_RUNTIME_DIR=/run/user/$(id -u) — then run this again.
     (If systemd never runs on this machine, delete that unit file.)
EOT
}

# systemd_owns_web — true when the unit is enabled OR active. Either one means systemd is the owner
# and nothing else may supervise web.mjs (an enabled-but-stopped unit still starts at next boot).
systemd_owns_web() {
  systemctl --user is-enabled --quiet "$WEB_UNIT" 2>/dev/null ||
    systemctl --user is-active --quiet "$WEB_UNIT" 2>/dev/null
}

# The process patterns (ERE, for pgrep/pkill -f). The full-path half used to be the literal
# "personal_agent/…": the author's checkout name. A fresh `git clone …/superelf.git` lands in
# "superelf", so on every other machine status lied ("down" while serving) and stop.sh left strays.
# It is now derived from this checkout's own directory name, regex-escaped. The directory NAME, not
# the whole path: launchd/systemd run the path install.sh rendered, which can differ from $PWD by a
# symlinked parent, while the last component is the same either way.
_ere_escape() { printf '%s' "$1" | sed 's/[][\\.*^$+?(){}|]/\\&/g'; }
# path_pattern <alternation> → "(^|[ /])<dir>/(<alternation>)\.mjs"
path_pattern() { printf '(^|[ /])%s/(%s)\\.mjs' "$(_ere_escape "$(basename "$SUPERELF_ROOT")")" "$1"; }
# bare_pattern <alternation> → "^node (\./)?(<alternation>)\.mjs$" — a manual `node web.mjs`.
bare_pattern() { printf '^node (\\./)?(%s)\\.mjs$' "$1"; }
# proc_pattern <alternation> → either form.
proc_pattern() { printf '%s|%s' "$(path_pattern "$1")" "$(bare_pattern "$1")"; }
