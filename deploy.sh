#!/bin/bash
# Update a Linux node to origin/main, with a way back · 部署更新（Linux / systemd）
#
#   ./deploy.sh             fetch, fast-forward, syntax-check, ./install.sh, health check
#   ./deploy.sh --dry-run   show what would be deployed, then stop; changes nothing
#
# Exit codes: 0 deployed, already up to date, or a dry run · 1 refused (nothing changed), or deployed,
# found unhealthy and ROLLED BACK · 2 not Linux, or an unknown option · 3 the rollback could not be
# done, or is unhealthy too: read the message, then restore the hypervisor snapshot if need be.
#
# It refuses rather than guesses. Every refusal happens before anything changes. The server keeps
# running throughout, and may commit (shelf) or edit tracked apps meanwhile, so the only reset it
# ever does is `git reset --keep` back to the commit it started from, and only from exactly the
# commit it deployed: --keep refuses rather than discard an edit, and any failure is exit 3.
set -uo pipefail

usage() { sed -n '2,9p' "$0"; }
say() { printf '\n== %s\n' "$1"; }
refuse() { printf '\n!! deploy refused, nothing changed: %s\n' "$1" >&2; exit 1; }

# The health check: is-active alone is not enough. With Restart=always a web.mjs that crashes at
# startup is "active" for a moment before every crash, so the port must answer too, several times
# in a row. ~45 s in all: a cold node with many apps takes a few seconds to listen.
# HEALTH_STABLE outlasts web.mjs's own listen retry (LISTEN_RETRIES 10 x 500 ms = 5 s), during which
# the unit is "active" while a stray process holding the port answers 200; a streak also restarts
# whenever MainPID or NRestarts changes, so a crash loop never adds up to "stable".
HEALTH_TRIES=45
HEALTH_STABLE=8
DEFAULT_PORT=8787   # web.mjs: cfg.web_port || 8787

# --- platform and preconditions ----------------------------------------------------------------

require_linux() {
  [ "$(uname -s)" = Linux ] && return 0
  cat >&2 <<EOT
deploy.sh updates a Linux node whose web.mjs is the systemd user service, and nothing else.
This is $(uname -s). On macOS update with: git pull && ./install.sh && ./stop.sh && ./start.sh
On Windows: git pull, then .\\install.ps1. Nothing was changed.
EOT
  exit 2
}

require_checkout() {
  local top branch
  top="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    refuse "$PWD is not a git checkout. A node installed from a ZIP is updated by hand."
  [ "$(cd "$top" && pwd -P)" = "$(pwd -P)" ] || refuse "run deploy.sh from the repository root ($top)"
  branch="$(git symbolic-ref --short -q HEAD)" || refuse "HEAD is detached; check out main first"
  [ "$branch" = main ] || refuse "on branch '$branch'. Deploys come from main only: git checkout main"
}

# Since 2026-10-01 the owner's apps (workspace/apps/*/index.html and meta.json) are TRACKED, and the
# agent edits them live on the node. A deploy over such an edit either stops on it half-way or
# mixes it, unseen, into code it was not written for. Which copy wins is the operator's call.
require_clean() {
  local dirty
  dirty="$(git status --porcelain --untracked-files=no)"
  [ -z "$dirty" ] && return 0
  printf '%s\n' "$dirty" >&2
  cat >&2 <<'EOT'

These tracked files are modified on this node (above). workspace/apps/*/{index.html,meta.json}
are tracked, and the agent may have edited an app here; a deploy would stop on that edit or mix
it into new code. Decide first, then run deploy.sh again:
  keep it:     git diff > ~/app-edits.patch   then apply, commit and push it from your development
               machine (this node's key is read-only), and discard it here; the deploy brings it back
  discard it:  git restore <files>
EOT
  refuse "tracked modifications"
}

# One deploy at a time: a second one could fast-forward or reset under the first. The lock goes when
# this process exits, however it exits. flock is util-linux, on every systemd distro.
take_lock() {
  command -v flock >/dev/null || refuse "flock is missing (util-linux): apt install util-linux"
  exec 9>"$(git rev-parse --git-dir)/deploy.lock" || refuse "cannot open the deploy lock"
  flock -n 9 || refuse "another deploy.sh is running on this checkout"
}

require_service() {
  case "$(service_kind)" in
    systemd)
      [ -f "$UNIT_FILE" ] ||
        refuse "the $WEB_UNIT unit is not installed ($UNIT_FILE). Install the node first: ./install.sh" ;;
    systemd-unreachable) explain_unreachable; refuse "no user bus in this shell" ;;
    *) refuse "no systemd user manager answers here. deploy.sh needs the $WEB_UNIT user service (docs/vm-node.md)" ;;
  esac
}

# --- the health check ----------------------------------------------------------------------------

web_port() {
  node -e 'let p; try { p = JSON.parse(require("fs").readFileSync("config.json", "utf8")).web_port; } catch {}
    console.log(Number.isInteger(p) && p > 0 ? p : Number(process.argv[1]))' "$DEFAULT_PORT"
}

http_ok() {   # http_ok <url> → 0 only for an HTTP 200
  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1")" = 200 ]
  else
    node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(5000) })
      .then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))' "$1"
  fi
}

main_process() {   # → "<MainPID>/<NRestarts>", or fails when no process runs
  local pid n
  pid="$(systemctl --user show -p MainPID --value "$WEB_UNIT")" && [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
  n="$(systemctl --user show -p NRestarts --value "$WEB_UNIT")" || return 1
  echo "$pid/$n"
}

# wait_healthy → 0 once the unit is active AND / answers 200, HEALTH_STABLE probes in a row, all
# from the same process.
wait_healthy() {
  local url i ok=0 proc seen=
  url="http://127.0.0.1:$(web_port)/"
  echo "   waiting for $WEB_UNIT to be active and $url to answer 200 ..."
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    if systemctl --user is-active --quiet "$WEB_UNIT" && proc="$(main_process)" && http_ok "$url"; then
      [ "$proc" = "$seen" ] || { ok=0; seen="$proc"; }
      ok=$((ok + 1))
      [ "$ok" -ge "$HEALTH_STABLE" ] && { echo "   healthy"; return 0; }
    else
      ok=0; seen=
    fi
    sleep 1
  done
  echo "   NOT healthy after ${HEALTH_TRIES} probes"
  return 1
}

show_journal() {
  say "Last 40 lines of the $WEB_UNIT journal · 日志"
  journalctl --user -u "$WEB_UNIT" -n 40 --no-pager || echo "   (journalctl failed)"
}

# --- the steps that change things ----------------------------------------------------------------

# Everything the server imports, so a commit that cannot even parse never reaches the service.
# R14: an empty list, or one without web.mjs, is a gate that checked nothing, so it fails.
syntax_gate() {
  local f files bad=0 n=0
  files="$(git ls-files -- ':(glob)*.mjs' ':(glob)lib/**/*.mjs' ':(glob)lib/**/*.js' ':(glob)tools/**/*.mjs')"
  grep -qx web.mjs <<<"$files" || { echo "   web.mjs is not among the files to check" >&2; return 1; }
  while IFS= read -r f; do
    n=$((n + 1))
    node --check "$f" || { echo "   SYNTAX ERROR: $f" >&2; bad=1; }
  done <<<"$files"
  [ "$bad" = 0 ] && echo "   $n files parse"
  return "$bad"
}

# </dev/null: on an installed node install.sh asks nothing (setup.mjs refuses once an owner exists,
# linger is already on), and if that ever changes a prompt must fail, not hang a deploy.
# 9>&-: nothing install.sh starts may inherit, and so keep holding, the deploy lock.
run_install() { ./install.sh </dev/null 9>&-; }

# roll_back <prev> <new> <why>. Never from anywhere but <new>: a commit made since (web.mjs commits
# shelf promotes to main) would silently drop off the branch. --keep, not --hard: an edit made since
# is carried over, or the reset refuses. A rollback that did not happen is never reported as one.
roll_back() {
  local prev="$1" new="$2" kept
  say "ROLLING BACK to $(git rev-parse --short "$prev") · 回滚 ($3)"
  if [ "$(git rev-parse HEAD)" != "$new" ]; then
    echo "!! main moved during the deploy; these commits were made on this node meanwhile:" >&2
    git --no-pager log --oneline "$new..HEAD" >&2
    rollback_failed "$prev"
  fi
  { git reset -q --keep "$prev" && [ "$(git rev-parse HEAD)" = "$prev" ]; } ||
    { echo "!! git reset --keep failed (above)" >&2; rollback_failed "$prev"; }
  kept="$(git status --porcelain --untracked-files=no)"
  [ -z "$kept" ] || printf '   kept these edits made during the deploy (deploy.sh will refuse until you decide):\n%s\n' "$kept"
}

rollback_failed() {   # rollback_failed <prev> → exit 3
  cat >&2 <<EOT
!! ROLLBACK FAILED: NOT rolled back. HEAD is $(git rev-parse --short HEAD) (the deployed code or newer),
!! not $(git rev-parse --short "$1"), and the next start of $WEB_UNIT loads it. Save anything listed above (git format-patch,
!! git diff), then: git reset --keep $(git rev-parse --short "$1") && ./install.sh
!! or restore the hypervisor snapshot you took before this deploy (docs/vm-node.md, Snapshots).
EOT
  exit 3
}

# --- main ----------------------------------------------------------------------------------------

show_incoming() {
  say "Incoming commits · 待部署的提交 (HEAD..origin/main)"
  git --no-pager log --oneline HEAD..origin/main
  cat <<'EOT'

   BEFORE deploying: take a hypervisor snapshot (Checkpoint-VM / VBoxManage snapshot / vmrun
   snapshot, docs/vm-node.md). The VM cannot snapshot itself, and a snapshot is the only undo if
   the rollback below also fails. Deploy only commits that are green in CI.
EOT
}

# A path origin/main starts tracking must not exist here yet: workspace/ is ignored and un-ignored
# a piece at a time, so it may hold this node's own data, which the fast-forward would overwrite and
# a rollback delete. (git merge refuses for untracked files, but not for ignored ones.)
require_no_collisions() {
  local f hits=
  while IFS= read -r -d '' f; do
    { [ -e "$f" ] || [ -L "$f" ]; } && hits="$hits   $f"$'\n'
  done < <(git diff -z --no-renames --name-only --diff-filter=A HEAD origin/main)
  [ -z "$hits" ] && return 0
  printf '%s' "$hits" >&2
  cat >&2 <<'EOT'

origin/main starts tracking these paths, and they already exist on this node (above), probably
ignored and node-only. Move them aside, deploy, then compare and copy back what is yours.
EOT
  refuse "incoming files would overwrite files on this node"
}

# The server commits to this main by itself (web.mjs commitShelf: promote, rollback, unshare), and
# this node's deploy key cannot push them.
explain_diverged() {
  echo "Commits on this node that origin/main lacks:" >&2
  git --no-pager log --oneline origin/main..HEAD >&2
  [ -n "$(git diff --name-only origin/main...HEAD | grep -v '^shared-apps/')" ] && return 0
  cat >&2 <<'EOT'

They only touch shared-apps/: shelf commits the server made itself. Carry them over:
  git format-patch origin/main..HEAD -o ~/shelf-patches     then on your development machine
  git am them and push; then here: git fetch && git reset --keep origin/main   (docs/vm-node.md)
EOT
}

up_to_date() {
  say "Up to date · 已是最新 ($(git rev-parse --short HEAD))"
  wait_healthy && exit 0
  show_journal
  echo "!! no update was pending, but $WEB_UNIT is NOT healthy (journal above)." >&2
  exit 1
}

deploy_and_verify() {   # deploy_and_verify <prev>
  local prev="$1" short new
  short="$(git rev-parse --short "$prev")"
  git merge --ff-only --no-overwrite-ignore -q origin/main || refuse "the fast-forward to origin/main failed (above)"
  new="$(git rev-parse HEAD)"
  say "Syntax check · 语法检查"
  if ! syntax_gate; then
    roll_back "$prev" "$new" "an incoming file does not parse; install.sh was NOT run"
    echo "!! deploy FAILED and was rolled back to $short before the service was touched." >&2
    exit 1
  fi
  say "Installing · 安装 (restarts $WEB_UNIT)"
  if run_install && wait_healthy; then
    say "Deployed · 已部署 $short..$(git rev-parse --short HEAD)"
    exit 0
  fi
  show_journal
  roll_back "$prev" "$new" "the new code is not healthy"
  if run_install && wait_healthy; then
    echo "!! DEPLOY FAILED: the new code was unhealthy. ROLLED BACK to $short, which is healthy again." >&2
    exit 1
  fi
  show_journal
  echo "!! DEPLOY FAILED AND THE ROLLBACK IS UNHEALTHY TOO. superelf is DOWN." >&2
  echo "!! Restore the hypervisor snapshot you took before this deploy (docs/vm-node.md, Snapshots)." >&2
  exit 3
}

main() {
  local dry=0 a prev
  for a in "$@"; do
    case "$a" in
      --dry-run|-n) dry=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown option: $a" >&2; usage >&2; exit 2 ;;
    esac
  done
  require_linux
  cd "$(dirname "$0")" || exit 1
  [ -f ops/service.sh ] || { echo "ops/service.sh is missing — refusing to run: it defines the service names and process patterns" >&2; exit 1; }
  . ops/service.sh   # WEB_UNIT, UNIT_FILE, service_kind, explain_unreachable (R3)
  require_checkout; take_lock; require_clean; require_service
  say "Fetching origin · 获取更新"
  git fetch -q origin || refuse "git fetch origin failed"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && up_to_date
  git merge-base --is-ancestor HEAD origin/main ||
    { explain_diverged; refuse "local main and origin/main have diverged. Nothing is merged or reset."; }
  require_no_collisions
  show_incoming
  [ "$dry" = 1 ] && { say "Dry run · 演练: nothing changed"; exit 0; }
  prev="$(git rev-parse HEAD)"
  deploy_and_verify "$prev"
}

# One line, so bash has parsed the whole file before anything runs: the fast-forward replaces this
# very script on disk mid-run.
main "$@"; exit $?
