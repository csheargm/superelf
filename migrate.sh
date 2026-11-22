#!/bin/bash
# Build a migration bundle for a second node · 迁移包
#
#   ./migrate.sh /Volumes/USB/superelf-migration
#
# Copies what belongs to PEOPLE — config.json and every workspace — into a target directory you
# then move to the other machine. The code comes from git, not from here.
#
# READ-ONLY on this node. It never modifies, moves or deletes anything in the source; if it cannot
# write the target it stops before copying a single byte.
#
# What it adds over a hand-typed `cp`: it refuses to overwrite a target that already holds data,
# it skips the committed workspace.example (the clone already has it), and it copies byte for byte.
set -euo pipefail
cd "$(dirname "$0")"
SRC="$PWD"

die() { printf '\n!! %s\n' "$1" >&2; exit 1; }
say() { printf '\n== %s\n' "$1"; }

TARGET="${1:-}"
FORCE=0
for a in "${@:2}"; do
  case "$a" in
    --force) FORCE=1 ;;
    *) die "unknown option: $a" ;;
  esac
done
[ -n "$TARGET" ] || die "usage: ./migrate.sh <target-dir> [--force]

Builds a bundle you copy to the other machine. Nothing in this folder is changed."

[ -f "$SRC/config.json" ] || die "no config.json here — run this from the superelf folder"

# Refuse a target that already holds someone's data, unless asked twice. Overwriting a workspace
# is the one irreversible thing this script could do, so it is the one thing it will not do quietly.
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null || true)" ] && [ "$FORCE" != "1" ]; then
  die "$TARGET is not empty. Pass --force only if you are certain nothing there is needed."
fi
mkdir -p "$TARGET" || die "cannot create $TARGET"

say "config.json · 配置"
# cp -p: bytes and timestamps as they are. It holds every account and password hash, so the copy
# must be exact.
cp -p "$SRC/config.json" "$TARGET/config.json"

say "workspaces · 工作区"
shopt -s nullglob
copied=0
# One glob: workspace, workspace-<id>, and anything workspace-shaped a later version
# adds. The explicit skip below is what excludes the template — with the narrower
# "workspace-*" the glob missed workspace.example on its own and the skip was dead code,
# which meant the test covering it could not fail.
for d in "$SRC"/workspace*; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  # workspace.example is committed to git; the clone already has it.
  [ "$name" = "workspace.example" ] && continue
  # cp -a preserves bytes and timestamps. Mini-app data is fingerprinted by content, so a copy
  # that "helpfully" rewrites anything would make every app read as modified on the new node.
  cp -a "$d" "$TARGET/$name"
  printf '   %-22s %s\n' "$name" "$(du -sh "$d" | cut -f1)"
  copied=$((copied + 1))
done
[ "$copied" -gt 0 ] || die "no workspaces found to copy — is this really a superelf node?"

say "Done · 完成"
cat <<EOF
Bundle: $TARGET  ($(du -sh "$TARGET" | cut -f1), $copied workspace(s))
This node was not modified.

On the other machine:
  1. get the code: download the repo ZIP in a browser, or git clone it
  2. copy config.json and the workspace folders from this bundle into that folder
  3. powershell -ExecutionPolicy Bypass -File .\\install.ps1
     (add -CheckOnly first if you want to see what it finds before it changes anything)
EOF
