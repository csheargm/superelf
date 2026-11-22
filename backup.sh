#!/bin/bash
# Nightly encrypted backup of this superelf folder · 备份
#   ./backup.sh            make one backup now (the nightly job runs exactly this)
#   ./backup.sh --setup    create the passphrase (macOS Keychain; Linux: the backup_pass_file) and show it ONCE
#   ./backup.sh --install  run it every night at 03:30 (macOS launchd; a missed night runs on wake;
#                          Linux: prints the systemd timer to install, ops/demo/superelf-demo-backup.timer)
# Linux has no Keychain: config.json "backup_pass_file" names an absolute file holding the
# passphrase on its first line, readable by its owner only (chmod 600/400, e.g. root-only).
# config.json: "backup_dir" = where backups go — an rclone remote such as "gdrive:superelf-backups"
# (uploaded straight to Google Drive) or a local folder; "backup_keep" = how many nightly copies to
# keep (default 7); "backup_extra" = folders outside this one packed into the same archive
# (lib/backup-extra.sh). All are read on every run, so editing them needs no reinstall. The archive
# is AES-256 encrypted before it leaves this Mac; without the passphrase it cannot be read.
# The copy is taken while superelf runs: every file is written atomically, so each file in the
# archive is whole; a multi-file save caught mid-way is the accepted risk, fixed by the next night.
# Each extra folder is packed first, by its own tar (and paused around that when its entry says
# how), so a folder that cannot be read whole costs only itself, never the superelf folder's copy.
set -euo pipefail
umask 077   # every temp file this script makes is private
# SUPERELF_REQUIRE_MARKER (the demo container): refuse unless that file exists — the capped disk
# is mounted — before anything is written, so nothing is ever staged on the host disk.
if [[ -n "${SUPERELF_REQUIRE_MARKER:-}" && ! -f "$SUPERELF_REQUIRE_MARKER" ]]; then echo "$(basename "$0"): $SUPERELF_REQUIRE_MARKER missing: the demo data disk is not mounted" >&2; exit 1; fi
# SUPERELF_BUSY_MARKER (the demo container): a restore is running or did not finish — a backup of
# that tree would replace a good archive of the same day, so none is made.
if [[ -n "${SUPERELF_BUSY_MARKER:-}" && -e "$SUPERELF_BUSY_MARKER" ]]; then echo "backup: $SUPERELF_BUSY_MARKER exists (a restore is running or failed); not backing up" >&2; exit 1; fi
# A folder with no config.json is not a node (empty, or not restored yet): never archived.
if [[ ! -f "${SUPERELF_NODE_DIR:-$(dirname "$0")}/config.json" ]]; then echo "backup: no config.json in the node folder; not backing up" >&2; exit 1; fi
# TMPDIR may name a folder not made yet (the demo puts it on the capped data disk, never the host).
if [[ -n "${TMPDIR:-}" ]]; then mkdir -p "$TMPDIR"; fi
# The demo container (one backup at a time; a restore waits for it): staging a killed run left
# behind is removed, so orphans cannot fill the capped disk unseen.
if [[ -n "${SUPERELF_REQUIRE_MARKER:-}" && -n "${TMPDIR:-}" ]]; then
  find "$TMPDIR" -mindepth 1 -maxdepth 1 -name 'superelf-backup*' -mmin +360 -exec rm -rf {} +
fi
# SUPERELF_NODE_DIR backs up another folder with THIS script (the demo's backup container runs
# the image's copy, never the one on the data volume the web process can write).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
if [[ -n "${SUPERELF_NODE_DIR:-}" && ( -L "$SUPERELF_NODE_DIR" || ! -d "$SUPERELF_NODE_DIR" ) ]]; then
  echo "backup: SUPERELF_NODE_DIR must be a real folder, not a link: $SUPERELF_NODE_DIR" >&2; exit 1
fi
cd "${SUPERELF_NODE_DIR:-$SCRIPT_DIR}"
KEYCHAIN_ITEM=superelf-backup
LABEL=com.superelf.backup
. "$SCRIPT_DIR/lib/backup-extra.sh"

cfg() { node -e 'const c=require("./config.json"),v=c[process.argv[1]];process.stdout.write(String(v??process.argv[2]))' "$1" "$2"; }
PLATFORM=${SUPERELF_BACKUP_PLATFORM:-$(uname -s)}   # the override exists for the tests only
# Linux: the passphrase file must be absolute, a regular file, non-empty, and closed to group/other.
pass_file() {
  local f; f=${SUPERELF_BACKUP_PASS_FILE:-$(cfg backup_pass_file "")}
  [[ "$f" == /* ]] || { echo "backup: set \"backup_pass_file\" in config.json to an absolute path (Linux has no Keychain)" >&2; return 1; }
  [[ "${1:-}" == new ]] && { printf '%s' "$f"; return 0; }
  [[ -f "$f" && -n "$(head -n 1 "$f" | tr -d '[:space:]')" ]] || { echo "backup: no passphrase on the first line of $f; run ./backup.sh --setup" >&2; return 1; }
  node -e 'process.exit(require("fs").statSync(process.argv[1]).mode & 0o077 ? 1 : 0)' "$f" \
    || { echo "backup: $f is readable by others; chmod 600 it (owner only)" >&2; return 1; }
  printf '%s' "$f"
}
passphrase() { if [[ "$PLATFORM" == Darwin ]]; then security find-generic-password -a "$USER" -s "$KEYCHAIN_ITEM" -w; else head -n 1 "$PASS_FILE"; fi; }

if [[ "${1:-}" == --setup && "$PLATFORM" != Darwin ]]; then
  F=$(pass_file new)
  [[ -e "$F" ]] && { echo "A backup passphrase already exists in $F; keeping it, so old backups stay readable."; exit 0; }
  PASS=$(openssl rand -base64 24)
  # noclobber: created exclusively, so two --setup runs at once cannot leave a different secret.
  mkdir -p "$(dirname "$F")"; ( set -o noclobber; umask 077; printf '%s\n' "$PASS" > "$F" ) \
    || { echo "A backup passphrase appeared in $F meanwhile; keeping it." >&2; exit 1; }
  echo "Backup passphrase written to $F (save it in your password manager NOW; backups cannot be opened without it):"
  echo "  $PASS"
  exit 0
fi
if [[ "${1:-}" == --install && "$PLATFORM" != Darwin ]]; then
  echo "Linux: install the systemd timer from ops/demo (see docs/demo-node.md):"
  echo "  sudo cp ops/demo/superelf-demo-backup.service ops/demo/superelf-demo-backup.timer /etc/systemd/system/"
  echo "  sudo systemctl daemon-reload && sudo systemctl enable --now superelf-demo-backup.timer"
  exit 0
fi

if [[ "${1:-}" == --setup ]]; then
  if security find-generic-password -a "$USER" -s "$KEYCHAIN_ITEM" >/dev/null 2>&1; then
    echo "A backup passphrase is already in the Keychain ($KEYCHAIN_ITEM); keeping it, so old backups stay readable."; exit 0
  fi
  PASS=$(openssl rand -base64 24)
  # Through `security -i` on stdin, never on a command line (ps would show it).
  printf 'add-generic-password -a "%s" -s "%s" -w "%s"\n' "$USER" "$KEYCHAIN_ITEM" "$PASS" | security -i
  echo "Backup passphrase (save it in your password manager NOW; backups cannot be opened without it):"
  echo "  $PASS"
  exit 0
fi

if [[ "${1:-}" == --install ]]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  TOOLS_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v gpg)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$PWD/backup.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$TOOLS_PATH</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/superelf-backup.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/superelf-backup.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true   # not loaded yet is fine
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Nightly backup installed (03:30). Log: ~/Library/Logs/superelf-backup.log"; exit 0
fi

# SUPERELF_BACKUP_DIR / _KEEP / _PASS_FILE override config.json: the demo's root backup container
# sets them, so nothing in the web-writable config decides where or with what a backup goes.
DEST=${SUPERELF_BACKUP_DIR:-$(cfg backup_dir "")}
KEEP=${SUPERELF_BACKUP_KEEP:-$(cfg backup_keep 7)}
[[ -n "$DEST" ]] || { echo "backup: set \"backup_dir\" in config.json" >&2; exit 1; }
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "backup: backup_keep must be a whole number >= 1" >&2; exit 1; }
REMOTE=; [[ "$DEST" != /* && "$DEST" =~ ^[A-Za-z0-9_.-]+: ]] && REMOTE=1   # rclone "name:path"
if [[ -n "$REMOTE" ]]; then
  command -v rclone >/dev/null || { echo "backup: rclone is not installed (brew install rclone)" >&2; exit 1; }
  rclone mkdir "$DEST" || { echo "backup: cannot reach $DEST (run: rclone config reconnect ${DEST%%:*}:)" >&2; exit 1; }
else
  [[ -d "$DEST" ]] || { echo "backup: folder missing: $DEST" >&2; exit 1; }
  # A destination inside the folder being backed up would archive its own archives, night after night.
  case "$(cd "$DEST" && pwd -P)/" in "$(pwd -P)/"*) echo "backup: backup_dir $DEST is inside the folder being backed up" >&2; exit 1;; esac
fi
# Without this check a failed Keychain (or file) read would hand gpg an EMPTY passphrase and "succeed".
if [[ "$PLATFORM" == Darwin ]]; then
  security find-generic-password -a "$USER" -s "$KEYCHAIN_ITEM" >/dev/null 2>&1 \
    || { echo "backup: no passphrase in the Keychain; run ./backup.sh --setup" >&2; exit 1; }
else
  PASS_FILE=$(pass_file) || exit 1
fi

# The extra folders are read and checked before any file is written, then packed one by one.
# The exit trap resumes a paused folder's program; bash runs it on a failure and, through these
# signal traps, on HUP/INT/TERM as well.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/superelf-backup-extra.XXXXXX")
trap 'extra_resume; extra_unstage "$STAGE"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
# SUPERELF_BACKUP_EXTRA=off: no backup_extra at all — its pause/resume would run programs named in
# a config.json the demo's web process can write, and the backup container runs as root.
if [[ "${SUPERELF_BACKUP_EXTRA:-on}" == off ]]; then EXTRA_OPS=() EXTRA_NOTE=
elif [[ -n "$REMOTE" ]]; then extra_stage "$STAGE" ""; else extra_stage "$STAGE" "$DEST"; fi
# GNU tar (Linux) exits 1 when a file changes or vanishes during this live walk; that file is
# still whole or absent in the archive (atomic writes), so 1 is kept as a warning, not a failure.
TAR_LIVE=(); GNU_TAR=
if tar --version 2>/dev/null | grep -q 'GNU tar'; then GNU_TAR=1; TAR_LIVE=(--warning=no-file-changed --warning=no-file-removed); fi
# Only a SILENT exit 1 is kept: those two warnings are switched off, so anything tar does print
# (a file that shrank and was padded with zeros, an unreadable file) still fails the backup.
tar_live() {
  local s=0; tar "$@" 2> "$STAGE/tar.err" || s=$?
  if [[ -s "$STAGE/tar.err" ]]; then cat "$STAGE/tar.err" >&2; fi
  local said=; [[ -s "$STAGE/tar.err" ]] && said=1
  rm -f "$STAGE/tar.err"   # extra_unstage removes only what it made, then rmdir's the stage
  if [[ $s -eq 1 && -n "$GNU_TAR" && -z "$said" ]]; then return 0; fi
  return $s
}

# The machine's name is in the file name, so two machines can share one backup folder safely.
HOST=$(hostname -s | tr -c 'A-Za-z0-9\n-' '-')
NAME="superelf-$HOST-$(date +%F).tar.gz.gpg"
PATTERN="^superelf-$HOST-[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar\.gz\.gpg$"
# Each run writes its OWN part file (two overlapping runs must never share one), renamed or
# uploaded only once it is complete. A local destination gets it in the same folder, so the
# rename is atomic; a remote one gets it in local temp space, and the upload names it.
if [[ -n "$REMOTE" ]]; then PART=$(mktemp "${TMPDIR:-/tmp}/superelf-backup.XXXXXX")
else PART=$(mktemp "$DEST/.$NAME.XXXXXX"); fi
trap 'extra_resume; rm -f "$PART"; extra_unstage "$STAGE"' EXIT   # a failed run leaves no half file behind

# Options first, then names: bsdtar reads no options after the first name. ${a[@]+...} keeps an
# empty list from tripping set -u in macOS bash 3.2.
tar_live -czf - ${TAR_LIVE[@]+"${TAR_LIVE[@]}"} --exclude ./.claude/worktrees --exclude ./web.log --exclude ./bot.log \
    --exclude ./bible-data --exclude .DS_Store . ${EXTRA_OPS[@]+"${EXTRA_OPS[@]}"} \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-fd 3 -o "$PART" \
      3< <(passphrase)
SIZE=$(du -h "$PART" | cut -f1)

# Keep the newest $KEEP of THIS Mac's backups; names sort by date. Nothing else is ever deleted.
prune() { { grep -E "$PATTERN" || true; } | sort -r | tail -n "+$((KEEP + 1))"; }
if [[ -n "$REMOTE" ]]; then
  rclone copyto "$PART" "$DEST/$NAME"
  rclone lsf --files-only "$DEST" | prune | while read -r old; do rclone deletefile "$DEST/$old"; done
else
  mv "$PART" "$DEST/$NAME"
  ls -1 "$DEST" | prune | while read -r old; do rm -f "$DEST/$old"; done
fi
echo "backup: $(date '+%F %T') wrote $NAME ($SIZE) to $DEST${EXTRA_NOTE:+; extra folders: $EXTRA_NOTE}"
if [[ -n "$EXTRA_STUCK" ]]; then exit 1; fi   # the backup is kept, but a resume failed (warning above)
