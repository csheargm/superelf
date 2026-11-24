#!/bin/sh
# git pre-push hook: refuse a push while the privacy scan finds anything (tools/privacy-scan.mjs).
# Install: cp tools/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
# Scans every outgoing commit (added lines, paths, identity), then the whole checked-out tree.
root="$(git rev-parse --show-toplevel)"
refs="$(cat)"   # git's stdin: <local ref> <local sha> <remote ref> <remote sha>, read once, fed to both checks
# Pushing to remote main (from any branch): every merge must be in a COMMITTED release entry (docs/adr/0038).
# --check reads HEAD's tree, so the commit pushed to main must be HEAD — else refuse, never skip.
main_sha="$(printf '%s\n' "$refs" | awk '$3 == "refs/heads/main" { print $2 }')"
if [ -n "$main_sha" ] && [ "$main_sha" != 0000000000000000000000000000000000000000 ]; then
  if [ "$main_sha" != "$(git rev-parse HEAD)" ]; then echo "pre-push: push main from a checkout of the commit being pushed (git checkout main)" >&2; exit 1; fi
  node "$root/tools/bump-version.mjs" --check || exit 1
fi
printf '%s\n' "$refs" | node "$root/tools/privacy-scan.mjs" --pre-push "$1" || exit 1   # $1 = destination remote
exec node "$root/tools/privacy-scan.mjs"
