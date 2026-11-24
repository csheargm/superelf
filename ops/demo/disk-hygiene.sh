# Disk hygiene for the VM rebuilds · 构建前后的磁盘卫生. Sourced by ops/demo/rebuild-demo.sh and the
# private node's rebuild-private.sh. A build on a near-full disk once SKIPPED Claude's optional
# native package silently (2026-11-24), so the build refuses below a floor and cleans up after.
#   SUPERELF_MIN_FREE_GB  free space on / a build needs (default 3)
# Test hooks: DF, DOCKER replace the real tools.
superelf_disk_guard() {   # $1 name for the message
  local min=${SUPERELF_MIN_FREE_GB:-3} kb
  [[ "$min" =~ ^[0-9]+$ ]] || { echo "$1: SUPERELF_MIN_FREE_GB must be a whole number" >&2; return 1; }
  kb=$(${DF:-df} -Pk / | awk 'NR==2{print $4}')
  [[ "$kb" =~ ^[0-9]+$ ]] || { echo "$1: cannot read free disk space on /" >&2; return 1; }
  (( kb >= min * 1048576 )) || { echo "$1: only $((kb / 1048576)) GB free on /, a build needs $min GB; free space first (sudo docker builder prune -af)" >&2; return 1; }
}
# After a GOOD build only: dangling images and the build cache. Never volumes, never tagged images
# (other projects' images on the host stay). A failed prune is not a failed deploy: it is reported.
superelf_prune() {   # $1 name for the message
  ${DOCKER:-docker} image prune -f >/dev/null || echo "$1: warning: docker image prune failed" >&2
  ${DOCKER:-docker} builder prune -af >/dev/null || echo "$1: warning: docker builder prune failed" >&2
}
