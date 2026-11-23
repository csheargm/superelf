#!/bin/bash
# superelf demo container start · 演示容器启动. The image holds CODE only (/opt/superelf); the
# node folder lives on the size-capped data volume (/data/superelf) with its config, visitor
# workspaces and counters, so backup.sh/restore.sh see one folder exactly as on a Mac.
# Each start copies the image's code over the folder (newer code wins); data files are never in
# the image, so nothing a visitor wrote is overwritten. The first start seeds config.json.
set -euo pipefail
umask 077   # every file the node writes (chats, sessions, counters) is owner-only
NODE_DIR=/data/superelf
# The marker sits on the size-capped data disk (rebuild-demo.sh writes it right after mounting).
# Without it /data is the plain host folder — the disk did not mount — so refuse to start rather
# than write past the cap onto the host disk.
# SUPERELF_PRIVATE=1 (ops/private): the owner's node — no capped demo disk, a private config seed.
PRIVATE=; [[ "${SUPERELF_PRIVATE:-}" == 1 ]] && PRIVATE=1
# Private: /data must be the unlocked encrypted volume (rebuild-private.sh); locked, it is an empty folder.
[[ -z "$PRIVATE" || -f /data/.superelf-private-disk ]] || { echo "entrypoint: /data is not the unlocked private volume (no .superelf-private-disk); run ops/private/rebuild-private.sh" >&2; exit 1; }
[[ -n "$PRIVATE" || -f /data/.superelf-demo-disk ]] || { echo "entrypoint: /data is not the capped demo disk (no .superelf-demo-disk); refusing to start" >&2; exit 1; }
# A copied marker on a big disk is still not the cap: the file system itself must be small.
[[ -n "$PRIVATE" ]] || node -e 'const s=require("fs").statfsSync("/data"),g=Number(process.env.DEMO_DISK_MAX_GB),max=(Number.isFinite(g)&&g>0?g:20)*2**30;
  if(s.blocks*s.bsize>max){console.error(`entrypoint: /data is ${(s.blocks*s.bsize/2**30).toFixed(1)} GB, over DEMO_DISK_MAX_GB; refusing to start`);process.exit(1);}'
mkdir -p "$NODE_DIR"
# Code folders are replaced whole, so a file the image no longer has (a removed seed app) is gone
# too; visitor data lives elsewhere in the folder and is never touched.
for d in lib web tools workspace.example bible-data ops builtin-apps; do rm -rf "${NODE_DIR:?}/$d"; done
tar -C /opt/superelf -cf - . | tar -C "$NODE_DIR" -xf -
chmod 700 "$NODE_DIR"   # tar's "." entry resets it to the image's 755; visitor data is private
SEED=/opt/superelf/ops/demo/config.demo.json; [[ -n "$PRIVATE" ]] && SEED=/opt/superelf/ops/private/config.private.json
[[ -f "$NODE_DIR/config.json" ]] || cp "$SEED" "$NODE_DIR/config.json"
mkdir -p "$NODE_DIR/workspace"
[[ -n "$PRIVATE" ]] && mkdir -p "$NODE_DIR/.agent-home"   # HOME for the Claude/Codex CLIs (compose)   # the unused default project folder config.demo.json names
cd "$NODE_DIR"
[[ $# -gt 0 ]] && exec "$@"
exec node web.mjs
