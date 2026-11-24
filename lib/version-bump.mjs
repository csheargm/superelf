// Version bump rules · 版本升级规则 (docs/adr/0038). Pure: git answers come in through `exec`, files
// through the caller (tools/bump-version.mjs), so every rule is testable without a repo.
//   feat merge → minor, any other merge → patch, a breaking `type!:` / "BREAKING CHANGE" → major.
//   One release entry per merge DAY (oldest first), each bumped by the strongest merge of that day.
//   Minor is capped at 99 like version.sh (x.99 + minor → (x+1).0.0); test/version-bump-tool pins
//   the two against each other so the rule cannot drift (R3).
import { mergeItem, mergesSince, releaseBase } from './version-auto.mjs';

export const MINOR_MAX = 99;
const LEVELS = ['patch', 'minor', 'major'];
const BREAKING_RE = /^[a-z]+(?:\([^)]*\))?!:|BREAKING CHANGE/;
const FEAT_RE = /^feat(?:\([^)]*\))?:/;
// Types a reader of the sheet cannot see (same list as lib/vernotes.mjs INTERNAL_RE).
const INTERNAL_RE = /^(?:docs|chore|test|refactor|style|ci|build|release)[(:!]/;
export const UPKEEP_ITEM = '内部改进 · Internal upkeep';

export function nextVersion(cur, level) {
  let [ma, mi, pa] = String(cur).split('.').map((n) => parseInt(n, 10) || 0);
  if (level === 'major') return `${ma + 1}.0.0`;
  if (level === 'minor') { mi += 1; return mi > MINOR_MAX ? `${ma + 1}.0.0` : `${ma}.${mi}.0`; }
  return `${ma}.${mi}.${pa + 1}`;
}

// Branch commit subjects → {level, internal}: internal = every commit is a type nobody sees.
export function classifyBranch(subjects) {
  let level = 'patch';
  for (const s of subjects) {
    if (BREAKING_RE.test(s)) return { level: 'major', internal: false };
    if (FEAT_RE.test(s)) level = 'minor';
  }
  return { level, internal: subjects.length > 0 && subjects.every((s) => INTERNAL_RE.test(s)) };
}

// Merges since the newest release, oldest first: [{sha, date, subject, branch:[subjects]}].
export function pendingMerges(root, exec) {
  const base = releaseBase(root, exec);
  if (!base) return { base, merges: [] };
  const out = [];
  let lines = [];
  try {
    lines = exec(['log', '--merges', '--first-parent', '--format=%H%x09%P%x09%cs%x09%s', `${base}..HEAD`]).trim().split('\n').filter(Boolean);
  } catch (e) {
    // R5: the bump must never pass for "nothing to do" when git could not answer (R14).
    throw new Error(`cannot list merges since ${base}: ${e.message}`);
  }
  for (const l of lines.reverse()) {
    const [sha, parents, date, ...rest] = l.split('\t');
    const [p1, p2] = parents.split(' ');
    const branch = exec(['log', '--format=%s', `${p1}..${p2}`]).trim().split('\n').filter(Boolean);
    out.push({ sha, date, subject: rest.join('\t'), branch });
  }
  return { base, merges: out };
}

// Merges → release entries, oldest day first, versions continuing from `cur`.
export function planReleases(cur, merges) {
  const days = new Map();
  for (const m of merges) { if (!days.has(m.date)) days.set(m.date, []); days.get(m.date).push(m); }
  const out = [];
  let v = cur;
  for (const [date, ms] of days) {
    let lvl = 0;
    const features = [], fixes = [];
    for (const m of ms) {
      const c = classifyBranch(m.branch);
      lvl = Math.max(lvl, LEVELS.indexOf(c.level));
      if (c.internal) continue;
      (c.level === 'patch' ? fixes : features).unshift(mergeItem(m.subject));   // newest first, like the sheet
    }
    if (!features.length && !fixes.length) fixes.push(UPKEEP_ITEM);
    v = nextVersion(v, LEVELS[lvl]);
    out.push({ version: v, entry: { date, features, fixes, through: ms[ms.length - 1].sha } });
  }
  return out;
}

// Notes map + releases → new map, keys newest version first (the order version.sh writes).
export function applyReleases(notes, releases) {
  const all = { ...notes };
  for (const r of releases) all[`v${r.version}`] = r.entry;
  return Object.fromEntries(Object.keys(all).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((k) => [k, all[k]]));
}

export { mergesSince };
