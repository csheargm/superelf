#!/bin/bash
# Bring the superelf public demo up on a fresh Ubuntu host (arm64 or amd64) with Docker · 重建演示
#   ops/demo/rebuild-demo.sh                      build and start
#   ops/demo/rebuild-demo.sh --restore latest     restore the newest backup first (empty data only)
#   ops/demo/rebuild-demo.sh --restore gdrive:superelf-demo-backups/<file>.tar.gz.gpg
# BACKUP_REMOTE (.env; default gdrive:superelf-demo-backups) is where "latest" is looked for.
# Run from the repo checkout (meant for ~/sandbox/superelf-demo). Touches only the Compose project
# `superelf-demo`; publishes no port. Data lives on a size-capped loop-mounted ext4 image
# (DEMO_DISK_GB, default 16: 5 GB of demo data + room to stage a backup and a restore) so a full demo can never fill the host disk. docs/demo-node.md.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT=superelf-demo
# One rebuild at a time: a second one's "compose up" would copy code into a tree being restored.
exec 9>>"$PWD/.rebuild.lock"
flock -n 9 || { echo "rebuild-demo: another rebuild is running" >&2; exit 1; }
RESTORE=
die() { echo "rebuild-demo: $*" >&2; exit 1; }
[[ "${1:-}" == --restore ]] && { RESTORE=${2:?--restore needs "latest" or a backup path}; }
[[ -z "$RESTORE" || "$RESTORE" == latest || "$RESTORE" =~ ^[A-Za-z0-9_.-]+: ]] || die "--restore takes \"latest\" or an rclone path like gdrive:folder/file.tar.gz.gpg"
compose() { docker compose -p "$PROJECT" "$@"; }

case "$(uname -m)" in aarch64|arm64|x86_64) ;; *) die "unsupported CPU $(uname -m) (arm64 or amd64 only)";; esac
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/ubuntu/)"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing (apt install docker-compose-plugin)"
[[ -f .env ]] || die "no .env: cp .env.example .env, fill in TUNNEL_TOKEN and OLLAMA_API_KEY, chmod 600 .env"
chmod 600 .env
# .env is read the way Compose reads it (KEY=value, spaces around = allowed, optional quotes),
# never sourced as shell. The process environment wins, as it does for Compose.
envval() {
  [[ -n "${!1:-}" ]] && { printf '%s' "${!1}"; return; }
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
# The data disk and the backup remote come from .env ONLY: the nightly systemd job reads .env
# alone, so a shell-only override would make the app and its backup use different places.
unset DEMO_DATA_DIR BACKUP_REMOTE
for k in TUNNEL_TOKEN OLLAMA_API_KEY DEMO_DATA_DIR DEMO_DISK_GB BACKUP_REMOTE; do
  v=$(envval "$k"); if [[ -n "$v" ]]; then printf -v "$k" '%s' "$v"; fi
done
DISK_GB=${DEMO_DISK_GB:-16}
[[ -n "${TUNNEL_TOKEN:-}" ]] || die "TUNNEL_TOKEN is empty in .env"
[[ -n "${OLLAMA_API_KEY:-}" ]] || die "OLLAMA_API_KEY is empty in .env"
# Compose reads a bare name ("data") as a named volume, so the path must start with / or ./
[[ "${DEMO_DATA_DIR:-./data}" == /* || "${DEMO_DATA_DIR:-./data}" == ./* ]] || die "DEMO_DATA_DIR must start with / or ./ (got ${DEMO_DATA_DIR})"
DATA=$(realpath -m "${DEMO_DATA_DIR:-./data}")
export DEMO_DATA_DIR="$DATA"
IMG="$DATA.img"
[[ "$DATA" != *[[:space:]]* ]] || die "the data path may not contain spaces (it goes into /etc/fstab): $DATA"
MARK="$DATA/.superelf-demo-disk"   # entrypoint.sh refuses to start without it

# The size cap: an ext4 file system in a file, mounted at $DATA, listed in /etc/fstab so a
# reboot mounts it BEFORE Docker starts the container (else it would write to the host disk).
if ! mountpoint -q "$DATA"; then
  [[ -z "$(ls -A "$DATA" 2>/dev/null)" ]] || die "$DATA has files but is not the capped mount; move them away first"
  if [[ ! -f "$IMG" ]]; then
    echo "Creating a ${DISK_GB} GB data disk at $IMG"
    sudo mkdir -p "$(dirname "$IMG")"
    # nodiscard: discard would punch holes and make the reserved image sparse again. A failed
    # allocation or format removes the image, so the next run starts over instead of skipping it.
    { sudo fallocate -l "${DISK_GB}G" "$IMG" && sudo chmod 600 "$IMG" && sudo mkfs.ext4 -q -F -E nodiscard "$IMG"; } || { sudo rm -f "$IMG"; die "could not make the ${DISK_GB} GB data disk at $IMG"; }
  fi
  sudo mkdir -p "$DATA"
  sudo mount -o loop "$IMG" "$DATA"
  sudo touch "$MARK"
fi
sudo chmod 600 "$IMG"   # the raw image holds every visitor's data: root only
# Whoever mounted it: $DATA must be exactly this image's loop device, not any file system.
[[ -f "$IMG" && "$(findmnt -n -o SOURCE --target "$DATA")" == "$(losetup -j "$IMG" | cut -d: -f1 | head -n 1)" ]] \
  || die "$DATA is not $IMG mounted by loop; unmount it and run again"
[[ -f "$MARK" ]] || die "$DATA is mounted but is not the demo data disk (no $MARK)"
# Every run, once the mount is proven to be this image, so an older entry gains the options below.
# X-fstrim.notrim: Ubuntu's weekly fstrim would punch holes in the image and give the reserved
# space back to the host. An entry from an older run without it is replaced.
ENTRY="$IMG $DATA ext4 loop,nofail,X-fstrim.notrim,x-systemd.before=docker.service 0 2"
if ! grep -qxF "$ENTRY" /etc/fstab; then
  echo "Writing $IMG to /etc/fstab"
  { grep -vF " $DATA " /etc/fstab || true; } | sudo tee /etc/fstab.superelf-demo >/dev/null   # no other line: grep exits 1
  echo "$ENTRY" | sudo tee -a /etc/fstab.superelf-demo >/dev/null
  sudo mv /etc/fstab.superelf-demo /etc/fstab
fi
# Re-reserve every block of the image (fallocate fills holes, leaves data alone): an image a trim
# reached before X-fstrim.notrim existed is made whole again.
sudo fallocate -l "$(stat -c %s "$IMG")" "$IMG"
# /data is root's: the web process (uid 10001) owns only /data/superelf, so it can never replace
# /data/.tmp, where the ROOT backup and restore stage their archives.
sudo chown root:root "$DATA" && sudo chmod 755 "$DATA"
sudo install -d -o root -g root -m 700 "$DATA/.tmp"
sudo install -d -o 10001 -g 10001 -m 700 "$DATA/superelf"

if [[ -z "$RESTORE" ]] && sudo test -e "$DATA/.restoring"; then
  die "a restore did not finish: empty $DATA/superelf (docs/demo-node.md) and run --restore again"
fi
# The image stamps the commit it holds (REVISION); unknown or conflicting → stop here (revision.sh).
. ./revision.sh; superelf_revision "$(cd ../.. && pwd)" || die "cannot tell which commit is being built"
compose build
if [[ -n "$RESTORE" ]]; then
  emptydir() { local b; b=$(sudo ls -A "$1" | wc -c) || die "cannot list $1"; [[ "${b// /}" == 0 ]]; }   # bytes: a newline-only name still counts
  # Checked as root (the folder is uid 10001's, 700) BEFORE anything changes: a refused restore
  # leaves the running demo and its backups alone.
  emptydir "$DATA/superelf" || die "$DATA/superelf is not empty; restore only into an empty data dir"
  # Then the marker: a nightly backup starting from now on refuses; one already running is waited
  # for, so no backup sees the empty or half-restored tree. On any exit, a target still empty
  # (refused, bad passphrase, failed download) drops the marker; a partial tree keeps it.
  # A marker left by an earlier unfinished restore is never dropped here: only one this run made.
  if sudo test -e "$DATA/.restoring"; then OWN_MARK=; else OWN_MARK=1; sudo touch "$DATA/.restoring"; fi
  trap 'if [[ -n "$OWN_MARK" ]] && emptydir "$DATA/superelf"; then sudo rm -f "$DATA/.restoring"; fi' EXIT
  backups() { docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=backup; }
  for _ in $(seq 1 600); do
    IDS=$(backups) || die "cannot ask Docker whether a backup is running"   # no answer is not "none"
    [[ -z "$IDS" ]] && break
    sleep 2
  done
  [[ -z "$IDS" ]] || die "a backup is still running; try again later"
  compose stop superelf || die "could not stop superelf for the restore"   # nothing may write into the folder while it is restored
  RUNNING=$(compose ps -q --status running superelf) || die "cannot ask Compose whether superelf stopped"
  [[ -z "$RUNNING" ]] || die "superelf is still running; not restoring"
  emptydir "$DATA/superelf" || die "$DATA/superelf is not empty; restore only into an empty data dir"
  if [[ "$RESTORE" == latest ]]; then
    REMOTE=${BACKUP_REMOTE:-gdrive:superelf-demo-backups}   # the same default as docker-compose.yml
    # Only this demo's own archives (hostname superelf-demo); names then sort by date.
    NAME=$(compose --profile backup run --rm --entrypoint rclone backup lsf --files-only "$REMOTE" | { grep -E '^superelf-superelf-demo-[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar\.gz\.gpg$' || true; } | sort | tail -n 1)
    [[ -n "$NAME" ]] || die "no backup found in $REMOTE"
    RESTORE="$REMOTE/$NAME"
  fi
  echo "Restoring $RESTORE"
  sudo find "$DATA/.tmp" -mindepth 1 -delete   # leftovers of an interrupted run
  compose --profile backup run --rm -e SUPERELF_BACKUP_PASS_FILE=/run/secrets/backup-pass backup /opt/superelf/restore.sh "$RESTORE" /data/superelf
  compose --profile backup run --rm --entrypoint chown backup -R 10001:10001 /data/superelf
  sudo rm -f "$DATA/.restoring"
fi
UP_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # the tunnel check reads only log lines from this start on
compose up -d --force-recreate superelf   # a fresh process: nothing from before a restore stays in memory
compose up -d --force-recreate cloudflared   # a fresh connection, so its registration is in the log read below
# Up means healthy: the entrypoint accepted the disk and Node answers (compose healthcheck).
STATE=starting
for _ in $(seq 1 30); do
  STATE=$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q superelf)" 2>/dev/null || echo starting)
  [[ "$STATE" == healthy ]] && break
  sleep 3
done
compose ps
[[ "$STATE" == healthy ]] || { compose logs --tail 30 superelf >&2; die "superelf is not healthy ($STATE); see the log above"; }
# ...and the tunnel is connected to Cloudflare (a rejected TUNNEL_TOKEN never registers).
for _ in $(seq 1 20); do   # the log is read whole first: grep -q closing the pipe early would trip pipefail
  LOG=$(compose logs --since "$UP_AT" cloudflared 2>&1 || true)
  [[ "$LOG" == *'Registered tunnel connection'* ]] && { TUNNEL=ok; break; }; sleep 3
done
[[ "${TUNNEL:-}" == ok ]] || { compose logs --tail 30 cloudflared >&2; die "cloudflared did not connect; check TUNNEL_TOKEN"; }
echo "Up. Logs: docker compose -p $PROJECT logs -f superelf"
