// Release-notes engine · 版本记录: merges hand-curated version-notes.json with
// git-derived history per tag, cached in-process. Curated entries that carry
// any features/fixes win for their tag; an EMPTY seeded entry (what version.sh
// creates on bump) is filled from the commits between the previous tag and it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './webutil.mjs';
import { autoSince, autoEntry } from './version-auto.mjs';

const RELEASE_RE = /^release:/;
// Types that change nothing a person can SEE. This sheet is read by a family member asking
// "what's new", not by a developer reading a changelog — a plan edit, a test, or a
// no-behaviour refactor answers that question with noise. They stay in git, where they belong.
// `refactor` is deliberately included: R8 defines it as a change with NO behaviour change, so
// by its own definition it has nothing to show a reader.
const INTERNAL_RE = /^(?:docs|chore|test|refactor|style|ci|build)[(:]/;               // the bump commit itself carries no user-facing content
const FIX_RE = /^fix[(:]/;                    // fix(scope): … or fix: …
const PREFIX_RE = /^[a-z]+(?:\(([^)]*)\))?!?:\s*/; // conventional type + optional scope

// "feat(journal): photo insertion…" → "journal: photo insertion…"; "fix: x" → "x"
export function stripPrefix(subject) {
  const m = subject.match(PREFIX_RE);
  if (!m) return subject;
  const rest = subject.slice(m[0].length);
  return m[1] ? `${m[1]}: ${rest}` : rest;
}

// Commit subjects → {features, fixes}. fix(/fix: → fixes; release: dropped;
// everything else (feat/refactor/docs/chore/merge) → features. Order preserved.
export function classifySubjects(subjects) {
  const features = [], fixes = [];
  for (const s of subjects) {
    if (RELEASE_RE.test(s) || INTERNAL_RE.test(s)) continue;
    (FIX_RE.test(s) ? fixes : features).push(stripPrefix(s));
  }
  return { features, fixes };
}

const hasContent = (e) => !!(e && ((e.features && e.features.length) || (e.fixes && e.fixes.length)));

// argv, never a command string: POSIX single quotes are not quoting to cmd.exe, which passed the
// apostrophes through literally and made every tag name in the release-notes sheet garbage. An
// argv array needs no quoting on either platform (the precedent set in tools/fetch-daily-digest).
// stderr:'ignore' — see web.mjs GIT_QUIET. In a tree with no .git, git's "fatal:" on stderr is
// caught here as a failure, but the TEXT itself killed the Windows supervisor.
const defaultExec = (root) => (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// One git call for all tags: name, date, annotation subject — newest first.
function listTags(exec) {
  try {
    return exec(['for-each-ref', 'refs/tags', '--sort=-version:refname',
      '--format=%(refname:short)%09%(creatordate:short)%09%(subject)'])
      .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  } catch {
    // R5: no git / not a repo (deployed tarball) → curated notes alone still
    // render in the sheet, so the degradation is user-visible and correct.
    return [];
  }
}

function deriveEntry(tag, date, subject, prev, seeded, exec) {
  let subjects = [];
  try {
    // argv, so the refs need no quoting and cmd.exe cannot reinterpret them (see defaultExec).
    const range = prev ? `${prev}..${tag}` : tag;
    subjects = exec(['log', '--format=%s', range]).trim().split('\n').filter(Boolean);
  } catch {
    // R5: unreadable range (shallow clone, pruned tag) → tag-subject fallback below
  }
  const { features, fixes } = classifySubjects(subjects);
  // Fallback: the tag annotation's note, minus the "release: vX — " boilerplate. It is KEPT for
  // a range that read cleanly but held nothing user-visible, because version.sh puts the
  // author's own release note in that annotation — that note is curation, not noise, and it is
  // the only thing a docs/tests-only release has to say. A tag with no note after the
  // boilerplate therefore contributes nothing, which is the correct outcome for a release that
  // genuinely changed nothing a person can see.
  if (!features.length && !fixes.length) {
    const note = (subject || '').replace(/^release:\s*v?[\d.]+\s*[—–-]?\s*/, '').trim();
    if (note) features.push(note);
  }
  return { date: (seeded && seeded.date) || date, features, fixes };
}

// Full merged map {tag: {date, features, fixes}}, newest tag first. First of all the automatic
// entry 'v<package>+<N>' (lib/version-auto.mjs, flagged auto:true) when merges landed since the
// newest tag; `head` keys its cache, so a new merge shows without a restart.
export function buildNotes(root, exec = defaultExec(root), head = null) {
  const curated = readJson(path.join(root, 'version-notes.json'), {});
  const tags = listTags(exec);
  const out = {};
  const auto = autoEntry(pkgVersion(root), autoSince(root, head, exec));
  if (auto) out[auto.key] = auto.entry;
  for (let i = 0; i < tags.length; i++) {
    const [tag, date, subject] = tags[i];
    const cur = curated[tag];
    out[tag] = hasContent(cur) ? cur : deriveEntry(tag, date, subject, tags[i + 1] && tags[i + 1][0], cur, exec);
  }
  for (const [v, e] of Object.entries(curated)) if (!out[v]) out[v] = e; // notes curated before tagging still show
  return out;
}

// Cache key: package.json version (bumped on every release, so new tags
// invalidate) + version-notes.json mtime/size (any curated edit invalidates) + git HEAD.
// Both are cheap per-request checks, mirroring appVersion's read-per-request.
const pkgVersion = (root) => (readJson(path.join(root, 'package.json'), {}).version) || '';
function cacheKey(root, head) {
  const ver = pkgVersion(root);
  let stamp = 'absent';
  try {
    const st = fs.statSync(path.join(root, 'version-notes.json'));
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // R5: file may legitimately not exist yet — 'absent' is a valid cache state
  }
  return `${root}|${ver}|${stamp}|${head || ''}`;   // + HEAD: a merge moves the auto entry (version-auto)
}

let _cache = null; // { key, json }

// JSON string of the merged notes, rebuilt only when the cache key moves —
// git runs at most (1 + uncurated tags) times per rebuild, not per request.
export function appNotesJson(root, exec, head = null) {
  const key = cacheKey(root, head);
  if (!_cache || _cache.key !== key) _cache = { key, json: JSON.stringify(buildNotes(root, exec, head)) };
  return _cache.json;
}

// Escape JSON for embedding inside a back-tick template literal in served HTML.
// Backslashes FIRST (JSON strings contain \"), then the literal-breakers, then
// `<` as \u003c so `</script>` in a note can never terminate the script block.
export function embedInTemplateLiteral(json) {
  return json.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/</g, '\\u003c');
}
