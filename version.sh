#!/bin/bash
# Usage: ./version.sh [major|minor|patch] ["release note"]
#        ./version.sh --next <bump> [current]   → print the next version, change nothing
# Bumps the version, updates version-notes.json, commits + tags.
#
# MINOR IS CAPPED AT 99. A minor bump from x.99.z rolls over to (x+1).0.0 rather than
# producing x.100.0 — version numbers stay readable, and a release train that ran long
# turns into the next major instead of growing a third digit. The cap self-heals a minor
# that is ALREADY out of range (2.110 → 3.0.0), which is how this rule arrived: the minor
# had reached 110 before anyone noticed.
set -e
cd "$(dirname "$0")"

MINOR_MAX=99

# `--next` exists so the arithmetic above can be exercised by a test against THIS script
# rather than against a re-implementation of it — a copied rule is a rule that drifts (R3).
# It prints and exits: no package.json write, no commit, no tag.
DRY=""
if [[ "$1" == --next ]]; then DRY=1; shift; fi

BUMP="${1:-patch}"
NOTE="${2:-}"

if [[ "$BUMP" != major && "$BUMP" != minor && "$BUMP" != patch ]]; then
  echo "Usage: $0 [major|minor|patch] [\"release note\"]"; exit 1
fi

# In --next mode the current version may be supplied, so every boundary is testable without
# rewriting package.json.
if [[ -n "$DRY" && -n "$2" ]]; then CURRENT="$2"; else CURRENT=$(node -p "require('./package.json').version"); fi
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
  minor)
    MINOR=$((MINOR+1)); PATCH=0
    # Past the cap this is a MAJOR release, not a wider minor.
    if (( MINOR > MINOR_MAX )); then MAJOR=$((MAJOR+1)); MINOR=0; fi
    ;;
  patch) PATCH=$((PATCH+1)) ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"

if [[ -n "$DRY" ]]; then echo "$NEW"; exit 0; fi
TAG="v$NEW"
TODAY=$(date +%Y-%m-%d)
MSG="release: $TAG${NOTE:+ — $NOTE}"

# Update package.json
node -e "
  const fs=require('fs'), p=JSON.parse(fs.readFileSync('package.json','utf8'));
  p.version='$NEW'; fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
"

# Add empty entry to version-notes.json for the new version (features/fixes filled in separately)
node -e "
  const fs=require('fs'), f='version-notes.json';
  const notes=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
  if(!notes['$TAG']) notes['$TAG']={date:'$TODAY',features:[],fixes:[]};
  // Re-sort keys descending
  const sorted=Object.fromEntries(Object.keys(notes).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(k=>[k,notes[k]]));
  fs.writeFileSync(f,JSON.stringify(sorted,null,2)+'\n');
"

git add package.json version-notes.json
git commit -m "$MSG"
git tag -a "$TAG" -m "$MSG"

echo "✓ $CURRENT → $NEW  (tag: $TAG)"
echo "  commit: $(git rev-parse --short HEAD)"
echo "  Edit version-notes.json to add features/fixes for $TAG"
echo "  If this release adds UI, add its key to _PA_NEW_KEYS (web/index.html) + a mark call (markNew / PANewDot.mark)"
