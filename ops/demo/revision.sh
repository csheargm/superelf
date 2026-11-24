#!/bin/bash
# The commit being built · 正在构建的提交. Sourced by rebuild-demo.sh and rebuild-private.sh before
# `compose build`; exports SUPERELF_REVISION (40-hex sha) and SUPERELF_REVISION_DATE (YYYY-MM-DD),
# which the compose files pass to ops/demo/Dockerfile as build args (the image writes REVISION).
# $1 = the repo root. Two sources:
#   · REVISION, written by ops/private/deploy-vm.sh on every deploy (a `git archive` copy);
#   · git, when the folder is a checkout (a `git pull` update).
# Both present and different: one of them is stale (a pull after a deploy, or a deploy over a
# checkout whose HEAD did not move) — refuse rather than guess. Neither, or malformed: refuse.
# A guessed or stale stamp is how "ca28633" stayed in the footer and PAUpdate never fired.
superelf_revision() {
  local root=$1 sha= date= gsha= gdate=
  if [[ -f "$root/REVISION" ]]; then { IFS= read -r sha; IFS= read -r date; } < "$root/REVISION" || true; fi
  if [[ -e "$root/.git" ]]; then
    # safe.directory: the rebuild runs under sudo in a checkout another user owns.
    gsha=$(git -c safe.directory="$root" -C "$root" rev-parse HEAD 2>/dev/null) || gsha=
    [[ -z "$gsha" ]] || gdate=$(git -c safe.directory="$root" -C "$root" log -1 --format=%cs "$gsha" 2>/dev/null) || gdate=
    if [[ -n "$sha" && -n "$gsha" && "$sha" != "$gsha" ]]; then
      echo "revision: $root/REVISION says ${sha:0:7} but git HEAD is ${gsha:0:7}; deploy with ops/private/deploy-vm.sh, or delete REVISION after a git pull" >&2; return 1
    fi
    # Uncommitted edits: the build copies the working tree, so the image would ship code the sha does not name.
    if [[ -n "$gsha" && -n "$(git -c safe.directory="$root" -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      echo "revision: $root has uncommitted changes to tracked files; commit or discard them so the stamp names the code" >&2; return 1
    fi
    [[ -n "$sha" ]] || { sha=$gsha; date=$gdate; }
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "revision: no commit sha for $root (no REVISION from deploy-vm.sh, no git checkout)" >&2; return 1; }
  [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "revision: no commit date for ${sha:0:7} in $root" >&2; return 1; }
  export SUPERELF_REVISION=$sha SUPERELF_REVISION_DATE=$date
}
