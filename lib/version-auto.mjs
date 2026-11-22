// Automatic versioning · 自动版本 (docs/adr/0026): what has landed on main since the newest tag.
//
// No tag had been pushed since v5.0.0 (2026-10-12) while ~30 merges landed, so the Release Notes
// sheet said "v5.0.0 · current" for a month of changes. Nobody bumps on every merge, so the
// version names itself: 'v<package version>+<N>', N = merge commits on HEAD since the newest tag.
// ONE function computes N (R3): the shell footer (appVersion in web.mjs) and the sheet's auto entry
// (lib/vernotes.mjs) both read autoSince(). Cached by HEAD and the newest tag, so a new merge or a
// new tag shows without a restart; per call that is one cheap for-each-ref, the log runs once per key.
import { execFileSync } from 'node:child_process';

// stderr ignored for the same reason as lib/vernotes.mjs defaultExec (GIT_QUIET in web.mjs).
const defaultExec = (root) => (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export const AUTO_MARK = 'auto · 自动';
const MERGE_PREFIX_RE = /^Merge:\s*/;
// "(branch note-important, one review round)" — the merge script's own tail, not a note to a reader.
const MERGE_TAIL_RE = /\s*\(branch\s[^)]*\)\s*$/;

// 'Merge: title (branch x, one review round)' → 'title'. Bilingual text is kept as written.
export const mergeItem = (subject) => String(subject || '').replace(MERGE_PREFIX_RE, '').replace(MERGE_TAIL_RE, '').trim();

// The newest tag by version, or '' when the repo has none (then nothing is "since").
function newestTag(exec) {
  try {
    const first = exec(['for-each-ref', 'refs/tags', '--sort=-version:refname', '--count=1', '--format=%(refname:short)']).trim().split('\n')[0] || '';
    return first.split('\t')[0].trim();
  } catch {
    return '';   // R5: no git / no repo → no auto entry, the curated notes still render
  }
}

// Merge commits on HEAD since `tag`, newest first: [{date, subject}].
function mergesSince(exec, tag) {
  try {
    return exec(['log', '--merges', '--first-parent', '--format=%cs%x09%s', `${tag}..HEAD`])
      .trim().split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { date: l.slice(0, i), subject: l.slice(i + 1) }; });
  } catch {
    return [];   // R5: unreadable range (shallow clone, pruned tag) → nothing since; the sheet shows the tags alone
  }
}

// {tag, n, date, items}: n merges on HEAD since `tag`, dated from the newest, items = their
// subjects newest first. n = 0 (or no tag) → {n:0}. The computation itself; autoSince() caches it.
export function uncachedAutoSince(root, exec = defaultExec(root), tag = newestTag(exec)) {
  if (!tag) return { tag: '', n: 0, date: '', items: [] };
  const merges = mergesSince(exec, tag);
  return { tag, n: merges.length, date: merges.length ? merges[0].date : '', items: merges.map((m) => mergeItem(m.subject)) };
}

let _cache = null;   // { key, value }
// head: the current HEAD sha or null (the TTL'd one from lib/buildid.mjs). The newest tag is read on
// every call: a tag pushed onto the same HEAD must reset N to 0 without a restart.
export function autoSince(root, head, exec = defaultExec(root)) {
  const tag = newestTag(exec);
  const key = `${root}|${head || ''}|${tag}`;
  if (!_cache || _cache.key !== key) _cache = { key, value: uncachedAutoSince(root, exec, tag) };
  return _cache.value;
}

export const autoKey = (pkgVersion, n) => `v${pkgVersion}+${n}`;
// The sheet entry for the auto version, or null when nothing has landed since the tag.
export function autoEntry(pkgVersion, since) {
  if (!since || !since.n) return null;
  // `auto` carries the badge text: the sheet (web/settings.js) shows what the server says, ONE wording (R3).
  return { key: autoKey(pkgVersion, since.n), entry: { date: since.date, features: since.items, fixes: [], auto: AUTO_MARK } };
}
