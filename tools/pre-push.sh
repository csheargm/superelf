#!/bin/sh
# git pre-push hook: refuse a push while the privacy scan finds anything (tools/privacy-scan.mjs).
# Install: cp tools/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
# Scans every outgoing commit (added lines, paths, identity), then the whole checked-out tree.
root="$(git rev-parse --show-toplevel)"
# Pushing main: every merge must be in a release entry first (docs/adr/0038) — prints the fix command.
if [ "$(git rev-parse --abbrev-ref HEAD)" = main ]; then node "$root/tools/bump-version.mjs" --check || exit 1; fi
node "$root/tools/privacy-scan.mjs" --pre-push "$1" || exit 1   # $1 = destination remote
exec node "$root/tools/privacy-scan.mjs"
