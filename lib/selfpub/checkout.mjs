// 自我发布的代码副本 · The core-change checkout (docs/adr/0043, docs/plans/self-publish.md §2).
// A real git clone of the public repo at <selfpub_root>/repo, OUTSIDE the served /data/superelf, so
// nothing in it is served and the entrypoint never wipes it. One branch per request: self/<date>-<id>.
// Every git call runs with core.hooksPath=/dev/null (the agent can write files, never run a planted
// hook), a scrubbed env (no token, no prompts) and a timeout. The clone is anonymous https: no token
// is ever stored in .git/config. One change in flight per node: lib/selfpub/lock.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PublishError } from '../publish/collect.mjs';

export const DEFAULT_SELFPUB_ROOT = '/data/superelf-src';
export const DEFAULT_CLONE_URL = 'https://github.com/csheargm/superelf.git';
export const GIT_TIMEOUT_MS = 120000;
export const MAX_CHECKOUT_MB = 300;
export const MAX_FILES = 40;
export const MAX_DIFF_KB = 512;
export const MAX_FILE_BYTES = 1 << 20;
export const BRANCH_PREFIX = 'self/';
const ID_RE = /^[a-z0-9]{4,16}$/;

// Never published from the node, whatever the owner taps (plan §5, D4: .github is never allowed).
// package.json / lockfile / .npmrc: they set the CI test command, so a change could fake its own green run.
const DENY_RES = [/^\.github\//, /^package(-lock)?\.json$/, /(^|\/)\.npmrc$/, /^\.git(\/|$)/, /^\.git[a-z]*$/i, /^ops\/private\//, /(^|\/)\.env/i, /(^|\/)config\.json$/, /token/i, /auth[^/]*\.json$/i];
export const deniedPath = (rel) => DENY_RES.some((re) => re.test(rel));

// Every GIT_* var is dropped and no user/system git config is read: no URL rewrite, helper or
// alias from outside the checkout can steer a git call (GPT review, ADR 0044).
const SCRUB = /^(ANTHROPIC_|CLAUDE_|GITHUB_|GH_|GIT_)/i;   // /i: Windows env names are case-insensitive
export const NULL_DEV = process.platform === 'win32' ? 'NUL' : '/dev/null';
export function scrubbedEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEV, ...extra };
}

const NO_HOOKS = NULL_DEV;   // no hook ever runs from the checkout
export function git(cwd, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    return execFileSync('git', ['--literal-pathspecs', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', ...args],
      { cwd, env: scrubbedEnv(), encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 << 20 });
  } catch (e) {
    throw new PublishError('GIT_FAILED', `git ${args[0]} 失败 · git ${args[0]} failed: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
}

export const repoDir = (root) => path.join(root, 'repo');

// Clone once (blob-less: small and fast), then reuse. Mode 700: only the node's own uid reads it.
export function ensureCheckout({ root = DEFAULT_SELFPUB_ROOT, cloneUrl = DEFAULT_CLONE_URL } = {}) {
  const dir = repoDir(root);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  git(root, ['clone', '-q', '--filter=blob:none', '--branch', 'main', cloneUrl, dir]);
  return dir;
}

export function dirSizeMb(dir) {
  let bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.isFile()) bytes += fs.statSync(p).size;
  } };
  walk(dir);
  return bytes / (1 << 20);
}

export const branchFor = (id, now = new Date()) => `${BRANCH_PREFIX}${now.toISOString().slice(0, 10).replace(/-/g, '')}-${id}`;

// Sync to origin/main and start the request's branch. A dirty tree is refused unless it is on a
// self/* branch (the owner's earlier change, still open): its edits are never thrown away silently.
export function startBranch(dir, id, { now = new Date(), maxMb = MAX_CHECKOUT_MB } = {}) {
  if (!ID_RE.test(id)) throw new PublishError('BAD_ID', 'bad change id');
  if (dirSizeMb(dir) > maxMb) throw new PublishError('CHECKOUT_TOO_BIG', `代码副本超过 ${maxMb} MB · The checkout is over ${maxMb} MB`);
  const cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dirty = git(dir, ['status', '--porcelain']).trim();
  if (dirty && !cur.startsWith(BRANCH_PREFIX)) throw new PublishError('CHECKOUT_DIRTY', '代码副本有未知改动 · The checkout has changes not made by a superelf request');
  if (dirty) throw new PublishError('CHANGE_OPEN', `上一个改动 ${cur} 还没发布或丢弃 · The last change (${cur}) is not published or discarded yet`);
  git(dir, ['fetch', '-q', 'origin', 'main']);
  const branch = branchFor(id, now);
  git(dir, ['checkout', '-q', '-B', branch, 'origin/main']);
  return branch;
}

// Throw away a change: back to a clean origin/main (the owner said no, or it was published).
export function discardBranch(dir) {
  const cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '-f', '--detach', 'origin/main']);
  git(dir, ['clean', '-qfdx']);   // -x: ignored files too (a crashed turn's leftovers); this checkout holds nothing else
  if (cur.startsWith(BRANCH_PREFIX)) git(dir, ['branch', '-q', '-D', cur]);
}

const nulList = (s) => s.split('\0').filter(Boolean);

// What the turn changed against origin/main: tracked edits, deletes and new (untracked) files.
export function changedPaths(dir) {
  const changes = new Map();
  const ns = nulList(git(dir, ['diff', '--name-status', '-z', '--no-renames', 'origin/main']));
  for (let i = 0; i + 1 < ns.length; i += 2) changes.set(ns[i + 1], ns[i] === 'D' ? 'delete' : 'write');
  for (const p of nulList(git(dir, ['ls-files', '--others', '--exclude-standard', '-z']))) changes.set(p, 'write');
  return [...changes].map(([p, kind]) => ({ path: p, kind })).sort((a, b) => a.path.localeCompare(b.path));
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0);

// The change as Publish sends it. Refused (never sent): denied paths, symlinks, binaries, big files.
// Over the caps → throws: the whole change is refused, never a silent part of it.
export function collectChange(dir, { maxFiles = MAX_FILES, maxDiffKb = MAX_DIFF_KB } = {}) {
  const files = [], deletes = [], refused = [];
  let bytes = 0;
  const list = changedPaths(dir);
  if (list.length > maxFiles) throw new PublishError('TOO_MANY_FILES', `改动文件太多（${list.length} > ${maxFiles}） · Too many files changed`);
  for (const { path: rel, kind } of list) {
    if (deniedPath(rel)) { refused.push({ file: rel, why: 'denied path' }); continue; }
    if (kind === 'delete' && /^test\//.test(rel)) { refused.push({ file: rel, why: 'test deleted' }); continue; }
    if (kind === 'delete') { deletes.push(rel); continue; }
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) { refused.push({ file: rel, why: 'not a regular file' }); continue; }
    if (st.size > MAX_FILE_BYTES) { refused.push({ file: rel, why: 'over 1 MB' }); continue; }
    const content = fs.readFileSync(abs);
    if (!isText(content)) { refused.push({ file: rel, why: 'binary' }); continue; }
    bytes += content.length;
    files.push({ path: rel, content, mode: st.mode & 0o111 ? '100755' : '100644' });   // keep an executable bit
  }
  if (bytes > maxDiffKb * 1024) throw new PublishError('DIFF_TOO_BIG', `改动太大（> ${maxDiffKb} KB） · The change is over ${maxDiffKb} KB`);
  return { files, deletes, refused };
}

// The full diff the owner reviews, NEW files included (intent-to-add, so their content shows too).
export function diffText(dir) {
  const fresh = nulList(git(dir, ['ls-files', '--others', '--exclude-standard', '-z']));
  if (fresh.length) git(dir, ['add', '-N', '--', ...fresh]);
  return git(dir, ['diff', '--no-color', '--no-renames', '--text', 'origin/main']);   // --text: a .gitattributes 'binary' never hides what Publish sends
}

// What the change IS, byte for byte: verify stores it; Publish refuses if the tree moved since.
export function treeHash(dir) {
  const h = crypto.createHash('sha256');
  for (const { path: rel, kind } of changedPaths(dir)) {
    h.update(`${kind}\0${rel}\0`);
    const abs = path.join(dir, rel);
    if (kind === 'write') { const st = fs.lstatSync(abs); h.update(`${st.mode & 0o111 ? 'x' : '-'}\0`); h.update(st.isFile() ? fs.readFileSync(abs) : `link:${st.mode}`); }
    h.update('\0');
  }
  return h.digest('hex');
}
