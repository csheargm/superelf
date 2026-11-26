// Version bump rules · 版本升级规则 (docs/adr/0038). Pure: git answers come in through `exec`, files
// through the caller (tools/bump-version.mjs), so every rule is testable without a repo.
//   feat merge → minor, any other merge → patch, a breaking `type!:` / "BREAKING CHANGE" → major.
//   One release entry per merge DAY (oldest first), each bumped by the strongest merge of that day.
//   Minor is capped at 99 like version.sh (x.99 + minor → (x+1).0.0); test/version-bump-tool pins
//   the two against each other so the rule cannot drift (R3).
import { mergeItem, mergesSince, releaseBase } from './version-auto.mjs';

export const MINOR_MAX = 99;
const LEVELS = ['patch', 'minor', 'major'];
const BREAKING_HEAD_RE = /^[a-z]+(?:\([^)]*\))?!:/;
const BREAKING_FOOT_RE = /^BREAKING[ -]CHANGE:/m;   // a footer line, not a subject that mentions it
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

// Branch commits → {level, internal}: internal = every commit is a type nobody sees. Each item is a
// subject string or {subject, body}; a `BREAKING CHANGE:` footer in the body is a major bump.
export function classifyBranch(commits) {
  let level = 'patch';
  const subjects = commits.map((c) => (typeof c === 'string' ? c : c.subject));
  for (const c of commits) {
    const s = typeof c === 'string' ? c : c.subject, b = typeof c === 'string' ? '' : (c.body || '');
    if (BREAKING_HEAD_RE.test(s) || BREAKING_FOOT_RE.test(b)) return { level: 'major', internal: false };
    if (FEAT_RE.test(s)) level = 'minor';
  }
  return { level, internal: subjects.length > 0 && subjects.every((s) => INTERNAL_RE.test(s)) };
}

// Merges since the newest release, oldest first: [{sha, date, subject, branch:[subjects]}].
export function pendingMerges(root, exec) {
  const base = releaseBase(root, exec);
  // R14: no base, or a base off HEAD's first-parent line, would make "nothing pending" vacuous.
  if (!base) throw new Error('no release base: version-notes.json has no `through` and the repo has no tag');
  try { exec(['merge-base', '--is-ancestor', base, 'HEAD']); } catch { throw new Error(`release base ${base} is not an ancestor of HEAD`); }
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
    const branch = exec(['log', '--format=%s%x1f%b%x1e', `${p1}..${p2}`]).split('\x1e')
      .map((r) => r.replace(/^\n/, '')).filter((r) => r.trim())
      .map((r) => { const [subject, body = ''] = r.split('\x1f'); return { subject: subject.trim(), body }; });
    const merge = exec(['log', '-1', '--format=%B', sha]);   // the merge's own footer can mark it breaking
    if (BREAKING_FOOT_RE.test(merge)) branch.push({ subject: 'merge', body: 'BREAKING CHANGE: merge' });
    out.push({ sha, date, subject: rest.join('\t'), branch });
  }
  return { base, merges: out };
}

// Merges → release entries in first-parent order, versions continuing from `cur`. A run of merges
// with the same date is one entry; grouping only CONSECUTIVE days keeps `through` monotonic even when
// commit dates go A, B, A (a rebased or clock-skewed merge).
// time: the release's UTC ISO time, recorded on every entry it plans (absent: no `time` key).
export function planReleases(cur, merges, time) {
  const days = [];
  for (const m of merges) {
    const last = days[days.length - 1];
    if (last && last[0] === m.date) last[1].push(m); else days.push([m.date, [m]]);
  }
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
    out.push({ version: v, entry: { date, ...(time ? { time } : {}), features, fixes, through: ms[ms.length - 1].sha } });
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
