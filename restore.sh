#!/bin/bash
# Restore a superelf backup · 恢复
#   ./restore.sh <backup file, or rclone path like gdrive:superelf-backups/superelf-...gpg> <new-or-empty-folder>
# Never restores over an existing superelf: the target must be new or empty. The passphrase comes
# from SUPERELF_BACKUP_PASS_FILE when set (Linux: the backup_pass_file, first line), else the macOS
# Keychain (backup.sh --setup); if that one does not open the file (an older passphrase, or a new
# machine), it is asked for. Extra folders in the backup (config "backup_extra") go back
# to their own paths when those are new or empty; a folder that has files gets the copy beside it.
set -euo pipefail
umask 077
# SUPERELF_REQUIRE_MARKER (the demo container): refuse unless that file exists — the capped disk
# is mounted — before anything is written, so nothing is ever staged on the host disk.
if [[ -n "${SUPERELF_REQUIRE_MARKER:-}" && ! -f "$SUPERELF_REQUIRE_MARKER" ]]; then echo "$(basename "$0"): $SUPERELF_REQUIRE_MARKER missing: the demo data disk is not mounted" >&2; exit 1; fi
# TMPDIR may name a folder not made yet (the demo puts it on the capped data disk, never the host).
if [[ -n "${TMPDIR:-}" ]]; then mkdir -p "$TMPDIR"; fi
. "$(dirname "$0")/lib/backup-extra.sh"
SRC=${1:?usage: ./restore.sh <backup.tar.gz.gpg or remote:path> <new-or-empty-folder>}
TARGET=${2:?usage: ./restore.sh <backup.tar.gz.gpg or remote:path> <new-or-empty-folder>}
if [[ -e "$TARGET" ]]; then
  # Counted in bytes: $(...) would strip a newline-only file name to nothing. Unreadable is not empty.
  BYTES=$(ls -A "$TARGET" | wc -c) || { echo "restore: cannot list $TARGET" >&2; exit 1; }
  [[ "${BYTES// /}" == 0 ]] || { echo "restore: $TARGET is not empty" >&2; exit 1; }
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/superelf-restore.XXXXXX")
trap 'rm -rf "$WORK"' EXIT   # the decrypted archive never outlives the run
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM   # a signal runs the EXIT trap too
if [[ ! -f "$SRC" && "$SRC" != /* && "$SRC" =~ ^[A-Za-z0-9_.-]+: ]]; then
  command -v rclone >/dev/null || { echo "restore: rclone is not installed (brew install rclone)" >&2; exit 1; }
  rclone copyto "$SRC" "$WORK/backup.gpg"; FILE="$WORK/backup.gpg"
else
  [[ -f "$SRC" ]] || { echo "restore: no such file: $SRC" >&2; exit 1; }; FILE=$SRC
fi

decrypt() { gpg --batch --quiet --yes --decrypt --passphrase-fd 3 -o "$WORK/backup.tar.gz" "$FILE" 3< <(printf '%s\n' "$1") 2>/dev/null; }
if [[ -n "${SUPERELF_BACKUP_PASS_FILE:-}" ]]; then   # unattended: this file or nothing, never a prompt
  F=$SUPERELF_BACKUP_PASS_FILE
  [[ "$F" == /* && -f "$F" ]] || { echo "restore: SUPERELF_BACKUP_PASS_FILE must be an absolute path to a file: $F" >&2; exit 1; }
  node -e 'process.exit(require("fs").statSync(process.argv[1]).mode & 0o077 ? 1 : 0)' "$F" \
    || { echo "restore: $F is readable by others; chmod 600 it (owner only)" >&2; exit 1; }
  decrypt "$(head -n 1 "$F")" || { echo "restore: the passphrase in $F does not open this backup, or the file is damaged" >&2; exit 1; }
  PASS=unused; FROM=file
elif command -v security >/dev/null; then
  PASS=$(security find-generic-password -a "$USER" -s superelf-backup -w 2>/dev/null || true); FROM="Keychain"   # absent: asked for below
else PASS=; FROM=; fi
if [[ "$FROM" != file ]] && { [[ -z "$PASS" ]] || ! decrypt "$PASS"; }; then
  [[ -n "$PASS" ]] && echo "The $FROM passphrase does not open this backup (it may predate a new --setup)." >&2
  read -rsp "Backup passphrase: " PASS; echo >&2
  decrypt "$PASS" || { echo "restore: wrong passphrase, or the file is damaged" >&2; exit 1; }
fi
mkdir -p "$TARGET"
tar -xzf "$WORK/backup.tar.gz" -C "$TARGET"
echo "Restored into $TARGET."
# SUPERELF_BACKUP_EXTRA=off (the demo's root restore): the archive holds a web-writable tree, so
# its extra-folder list is never trusted to say where to write.
if [[ "${SUPERELF_BACKUP_EXTRA:-on}" != off ]]; then extra_place "$TARGET"; fi
echo "Same Mac: stop superelf, swap this folder in for the old one, start it."
echo "New machine: install Node, claude, codex, ollama, tailscale, rclone; cd \"$TARGET\" && ./install.sh;"
echo "  sign in to claude and codex; tailscale up; ./start.sh"
