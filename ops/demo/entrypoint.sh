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
[[ -f /data/.superelf-demo-disk ]] || { echo "entrypoint: /data is not the capped demo disk (no .superelf-demo-disk); refusing to start" >&2; exit 1; }
# A copied marker on a big disk is still not the cap: the file system itself must be small.
node -e 'const s=require("fs").statfsSync("/data"),g=Number(process.env.DEMO_DISK_MAX_GB),max=(Number.isFinite(g)&&g>0?g:20)*2**30;
  if(s.blocks*s.bsize>max){console.error(`entrypoint: /data is ${(s.blocks*s.bsize/2**30).toFixed(1)} GB, over DEMO_DISK_MAX_GB; refusing to start`);process.exit(1);}'
mkdir -p "$NODE_DIR"
# Code folders are replaced whole, so a file the image no longer has (a removed seed app) is gone
# too; visitor data lives elsewhere in the folder and is never touched.
for d in lib web tools workspace.example bible-data ops; do rm -rf "${NODE_DIR:?}/$d"; done
tar -C /opt/superelf -cf - . | tar -C "$NODE_DIR" -xf -
chmod 700 "$NODE_DIR"   # tar's "." entry resets it to the image's 755; visitor data is private
[[ -f "$NODE_DIR/config.json" ]] || cp /opt/superelf/ops/demo/config.demo.json "$NODE_DIR/config.json"
mkdir -p "$NODE_DIR/workspace"   # the unused default project folder config.demo.json names
cd "$NODE_DIR"
[[ $# -gt 0 ]] && exec "$@"
exec node web.mjs
