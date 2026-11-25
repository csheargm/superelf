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
CODE_DIRS=(lib web tools workspace.example bible-data ops builtin-apps)
CODE_FILES=(web.mjs superelf.md package.json version-notes.json REVISION backup.sh restore.sh)
# The private node made them read-only last start (below): writable again so they can be replaced.
for d in "${CODE_DIRS[@]}"; do [[ -e "$NODE_DIR/$d" ]] && chmod -R u+w "$NODE_DIR/$d"; done
for f in "${CODE_FILES[@]}"; do [[ -e "$NODE_DIR/$f" ]] && chmod u+w "$NODE_DIR/$f"; done
for d in "${CODE_DIRS[@]}"; do rm -rf "${NODE_DIR:?}/$d"; done
tar -C /opt/superelf -cf - . | tar -C "$NODE_DIR" -xf -
# Private: the served code is read-only on disk (superelf docs/adr/0044, owner decision 2026-11-25): the owner's
# main-chat agent changes superelf only through the core lane + Publish. Node data and config stay writable.
# Same uid, so this stops edits by mistake (and every shell write the agent tries), not a deliberate chmod;
# the agent's args deny these paths too (lib/agent-origin.mjs ownerCodeDenies).
if [[ -n "$PRIVATE" ]]; then
  for d in "${CODE_DIRS[@]}"; do [[ -e "$NODE_DIR/$d" ]] && chmod -R a-w "$NODE_DIR/$d"; done
  for f in "${CODE_FILES[@]}"; do [[ -e "$NODE_DIR/$f" ]] && chmod a-w "$NODE_DIR/$f"; done
fi
chmod 700 "$NODE_DIR"   # tar's "." entry resets it to the image's 755; visitor data is private
SEED=/opt/superelf/ops/demo/config.demo.json; [[ -n "$PRIVATE" ]] && SEED=/opt/superelf/ops/private/config.private.json
[[ -f "$NODE_DIR/config.json" ]] || cp "$SEED" "$NODE_DIR/config.json"
mkdir -p "$NODE_DIR/workspace"
[[ -n "$PRIVATE" ]] && mkdir -p "$NODE_DIR/.agent-home"   # HOME for the Claude/Codex CLIs (compose)   # the unused default project folder config.demo.json names
cd "$NODE_DIR"
[[ $# -gt 0 ]] && exec "$@"
exec node web.mjs
