// 只读副本与审查范围 · The read-only clone and the range to review (docs/adr/0046).
// Each repo gets its own anonymous https clone under the job's dir, through the core lane's ONE git
// helper (lib/selfpub/checkout.mjs git: hooks off, scrubbed env, no prompts, timeout). No token is ever
// given, and the push URL is set to an address git cannot reach: this clone can never push.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../selfpub/checkout.mjs';

export const NO_PUSH_URL = 'no-push.invalid:/never';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';   // git's empty tree: a repo's first commit diffs against it
const SHA_RE = /^[0-9a-f]{40}$/;

// Clone once, then fetch; the work tree is always the branch tip, clean (Codex reads it as context).
export function syncRepo({ dir, url, branch }) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    const filter = url.startsWith('https://') ? ['--filter=blob:none'] : [];
    git(path.dirname(dir), ['clone', '-q', '--no-checkout', ...filter, '--branch', branch, '--', url, dir]);
  } else git(dir, ['remote', 'set-url', 'origin', url]);
  git(dir, ['remote', 'set-url', '--push', 'origin', NO_PUSH_URL]);
  git(dir, ['fetch', '-q', '--prune', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const tip = git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]).trim();
  git(dir, ['checkout', '-q', '-f', '--detach', tip]);
  git(dir, ['clean', '-qfdx']);
  return tip;
}

// git answers "no" by exiting 1, which the helper throws for: here a throw IS the answer (not an error).
function yes(dir, args) { try { git(dir, args); return true; } catch { return false; /* exit 1 = no */ } }
const revList = (dir, args) => git(dir, ['rev-list', ...args]).split('\n').filter(Boolean);

// What to review: lastSha..tip when lastSha is still in the history; otherwise (first run, or history
// rewritten) the commits of the last windowMs. Returns { base, tip, commits, note } — commits newest first.
export function pickRange(dir, { tip, lastSha, now, windowMs }) {
  if (lastSha && lastSha === tip) return { base: tip, tip, commits: [], note: '' };
  if (lastSha === EMPTY_TREE) return { base: EMPTY_TREE, tip, commits: revList(dir, [tip]), note: '' };   // a failed first review that began at the root
  if (lastSha && SHA_RE.test(lastSha) && yes(dir, ['cat-file', '-e', `${lastSha}^{commit}`]) && yes(dir, ['merge-base', '--is-ancestor', lastSha, tip])) {
    return { base: lastSha, tip, commits: revList(dir, [`${lastSha}..${tip}`]), note: '' };
  }
  const note = lastSha ? 'history rewritten since the last review; reviewed by time window' : '';
  const commits = revList(dir, [`--max-age=${Math.floor((now - windowMs) / 1000)}`, tip]);
  if (!commits.length) return { base: tip, tip, commits, note };
  const oldest = commits[commits.length - 1];
  const parent = yes(dir, ['rev-parse', '--verify', '-q', `${oldest}^`]) ? git(dir, ['rev-parse', `${oldest}^`]).trim() : EMPTY_TREE;
  // A time window can pick commits whose parent is NOT an ancestor-line base (merges): diff from the
  // oldest's parent to the tip covers every picked commit, plus any merged-in work they brought.
  return { base: parent, tip, commits, note };
}

// The range's diff in chunks of at most capBytes, split on file boundaries. A single file over the cap
// is cut, and that is said in the chunk's `cut` list (the prompt and the email both say it).
export function diffChunks(dir, { base, tip, capBytes }) {
  const diff = git(dir, ['diff', '--no-color', '--no-renames', '--text', base, tip]);
  const files = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const chunks = [];
  let cur = { text: '', files: [], cut: [] };
  const flush = () => { if (cur.text) chunks.push(cur); cur = { text: '', files: [], cut: [] }; };
  for (let f of files) {
    const name = (/^diff --git a\/(\S+)/.exec(f) || [])[1] || '?';
    const over = Buffer.byteLength(f) > capBytes;
    if (over) f = Buffer.from(f).subarray(0, capBytes).toString('utf8') + '\n[cut: file diff over the cap]\n';
    if (cur.text && Buffer.byteLength(cur.text) + Buffer.byteLength(f) > capBytes) flush();
    cur.text += f; cur.files.push(name);
    if (over) cur.cut.push(name);
  }
  flush();
  return chunks;
}

export const commitLines = (dir, commits) => commits.length
  ? git(dir, ['log', '--no-walk=unsorted', '--format=%h %s', ...commits.slice(0, 200)]).split('\n').filter(Boolean) : [];
