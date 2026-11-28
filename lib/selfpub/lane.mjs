// 改 superelf · The owner's core-change turn (docs/adr/0043 §1–4), host-agnostic: web.mjs gives it the
// agent runner. Order: role gate (server-side, fail closed) → lock → sync checkout + new branch →
// agent turn jailed to the checkout (lib/agent-origin.mjs coreJailArgs) → backstop on its file tool
// calls → server-run tests + render → a pending change the owner may Publish. The reply's first
// lines are a server template: it says "可以发布 · Ready to publish" or "未通过检查 · Checks failed",
// never "done" or "fixed" (nothing is live until Publish + deploy).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agentConfined, coreJailArgs } from '../agent-origin.mjs';
import { PublishError } from '../publish/collect.mjs';
import { acquireLock, lockOptions } from './lock.mjs';
import { ensureCheckout, startBranch, discardBranch, changedPaths, git, treeHash } from './checkout.mjs';
import { verifyChange, verifyHeadline } from './verify.mjs';
import { putChange, loadState, PENDING } from './state.mjs';

export const CORE_TAG_PREFIX = 'self:';   // the core conversation's tag: no composer or app turn can resume it
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep']);

// Only the owner, from the composer (never an app, never a member or guest, never the demo).
export function coreLaneAllowed(user, origin, { demo = false } = {}) {
  return !demo && !!user && user.role === 'owner' && agentConfined(user, origin) === false;
}

const within = (dir, abs) => { const r = path.relative(dir, abs); return !r.startsWith('..') && !path.isAbsolute(r); };
const badSeg = (rel) => rel.split(/[\\/]/).some((s) => s.startsWith('.'));
// Where the path really lands: the deepest existing ancestor resolved through symlinks (a link in
// the checkout pointing out must not pass a spelling check).
function realTarget(abs) {
  let cur = abs, rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync(cur), rest); }
    catch { const up = path.dirname(cur); if (up === cur) return abs; rest = path.join(path.basename(cur), rest); cur = up; }
  }
}

// Every file tool call the agent made (even a denied one, reads too) must name a path in the
// checkout — by its real destination — and no dot-path.
export function lanePathProblems(dir, toolCalls = []) {
  const out = [];
  for (const c of toolCalls) {
    if (!c || !FILE_TOOLS.has(c.name)) continue;
    const p = c.input && (c.input.file_path || c.input.notebook_path || c.input.path);
    if (typeof p !== 'string') continue;
    const abs = path.resolve(dir, p), rel = path.relative(dir, abs);
    const real = realTarget(abs), realDir = realTarget(dir);
    if (!within(dir, abs) || badSeg(rel) || !within(realDir, real) || badSeg(path.relative(realDir, real))) out.push(p);
  }
  return out;
}

// Owner decision (2026-11-25): the node never runs code the agent wrote. Data-only changes (.css, .md)
// get the trusted tests run here; anything else is tested by GitHub CI only, and Publish merges only on green.
export const DATA_ONLY_RE = /\.(css|md)$/;
export const hasCode = (changed) => changed.some((c) => c.kind === 'delete' || !DATA_ONLY_RE.test(c.path));
export const CI_NOTE = '这个改动含代码：本节点不运行它，由 GitHub CI 测试，CI 通过才会合并 · This change has code: the node does not run it; GitHub CI tests it and Publish merges only on green';

export const CORE_PROMPT = [
  '你在 superelf 源代码的 git 副本里工作 · You are working in a git checkout of superelf\'s own source.',
  'Write only inside this folder. Never under /data/superelf (the running node). You cannot run commands:',
  'the server runs the affected tests and renders the page after you. Keep files <=300 lines and functions <=50;',
  'user-facing strings are 中文 first, then English. Never say "done" or "fixed": say what you changed.',
].join('\n');

// The reply must match the diff (owner 2026-11-26: a card that shows one file while the reply names three).
// Every repo path the reply names (web/…, lib/…, test/…, docs/…, ops/…, tools/…, or a root .mjs/.json file) that is NOT in the
// real diff vs origin/main. Known limits: a regex over prose — a path named only as context ("I read web/x.js")
// counts as a claim too, which errs on the safe side (not ready; the owner asks again); an unnamed file is not seen.
const CLAIM_RE = /(?<![\w./-])((?:web|lib|test|docs|ops|tools)\/[\w./-]*\w\.[a-z0-9]+|[\w-]+\.(?:mjs|json))(?![\w/-])/gi;   // + root files: web.mjs, package.json, version-notes.json (GPT review)
export function claimedNotChanged(reply, changed) {
  const have = new Set(changed.map((c) => c.path));
  return [...new Set([...String(reply || '').matchAll(CLAIM_RE)].map((m) => m[1]))].filter((p) => !have.has(p)).sort();
}
export const claimsNote = (missing) => `回复说改了 ${missing.join('、')}，但改动里没有，不能发布 · The reply names ${missing.join(', ')}, which the change does not contain: cannot publish`;

// runAgent({ cwd, args, prompt, message }) → { reply, toolCalls: [{ name, input }] }
export async function runCoreChange({ user, origin, demo, message, convo, cfg = {}, root, cloneUrl, baseArgs = [], runAgent, render, exec }) {
  if (!coreLaneAllowed(user, origin, { demo })) throw Object.assign(new Error('只有主人可以修改 superelf 本身 · Only the owner can change superelf itself'), { status: 403, code: 'edit_superelf_owner_only' });
  const release = acquireLock(root, lockOptions(cfg));
  try {
    const dir = fs.realpathSync(ensureCheckout({ root, cloneUrl }));
    const id = crypto.randomBytes(5).toString('hex');
    const prev = openChange(root, dir, user);
    if (prev) return await continueChange({ prev, dir, id, user, convo, message, cfg, root, baseArgs, runAgent, render, exec });
    const branch = startFresh(root, dir, id, { maxMb: Number(cfg.selfpub_max_mb) || undefined });
    const base = git(dir, ['rev-parse', 'origin/main']).trim();
    try {
      return await turnAndVerify({ dir, id, branch, base, user, convo, message, cfg, root, baseArgs, runAgent, render, exec });
    } catch (e) { discardBranch(dir); throw e; }   // a failed turn never leaves a dirty branch behind (CHANGE_OPEN with no id)
  } finally { release(); }
}

// The open (unpublished) change on the checked-out branch, when it is this owner's: a follow-up request
// ("a bit more", "fix that error") builds on it from ANY conversation instead of being refused — the owner
// hit a dead end when "fix it" came from a new chat (2026-11-26). Only one change is ever open (one checkout),
// so this is never ambiguous. A change mid-publish (state 'publishing'/'merged'/...) stays CHANGE_OPEN.
function openChange(root, dir, user) {
  const cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const c = Object.values(loadState(root).changes).find((x) => x.branch === cur && PENDING.includes(x.state));
  return c && c.who === user.id ? c : null;
}

// One change from two requests: the earlier edits are kept in a local snapshot commit while the agent works,
// so a failed follow-up puts them back exactly (never the earlier change lost). The new id supersedes the old.
async function continueChange({ prev, dir, id, ...rest }) {
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=superelf', '-c', 'user.email=superelf@invalid', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'snapshot']);
  const unsnap = () => git(dir, ['reset', '-q', '--mixed', prev.base]);   // HEAD back on the base; every edit stays in the tree
  let out;
  try { unsnap(); out = await turnAndVerify({ dir, id, branch: prev.branch, base: prev.base, ...rest, request: `${prev.request}\n${rest.message}` }); }
  catch (e) { git(dir, ['reset', '-q', '--hard', 'HEAD@{1}']); git(dir, ['clean', '-qfdx']); unsnap(); throw e; }   // HEAD@{1}: the snapshot
  if (out.id) putChange(rest.root, prev.id, { state: 'superseded', by: out.id });
  return out;
}

// A dirty self/* branch that no saved change owns is a crash leftover (no id to discard it by):
// thrown away. One a saved change owns is still CHANGE_OPEN.
function startFresh(root, dir, id, opts) {
  try { return startBranch(dir, id, opts); }
  catch (e) {
    if (e.code !== 'CHANGE_OPEN') throw e;
    const cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (Object.values(loadState(root).changes).some((c) => c.branch === cur)) throw e;
    discardBranch(dir);
    return startBranch(dir, id, opts);
  }
}

// Tests the server may run: tracked at origin/main and not changed by this turn.
function trustedTests(dir, changed) {
  const mine = new Set(changed.map((c) => c.path));
  return new Set(git(dir, ['ls-tree', '-r', '-z', '--name-only', 'origin/main', '--', 'test/']).split('\0').filter((f) => f && !mine.has(f)));
}

async function turnAndVerify({ dir, id, branch, base, user, convo, message, request, cfg, root, baseArgs, runAgent, render, exec }) {
  const turn = await runAgent({ cwd: dir, args: coreJailArgs(baseArgs, dir), prompt: CORE_PROMPT, message });
  const bad = lanePathProblems(dir, turn.toolCalls);
  if (bad.length) throw new PublishError('JAIL_BREACH', `改动已撤销：试图碰副本以外的文件 · Change undone: it touched files outside the checkout (${bad.length})`);
  const changed = changedPaths(dir);
  if (!changed.length) { discardBranch(dir); return { id: null, ready: false, headline: '没有改动任何文件 · No file was changed', reply: turn.reply || '' }; }
  // An ignored file is never in `changed` but a trusted test could still load it: CI only.
  const ignored = git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const ciOnly = hasCode(changed) || ignored.length > 0;
  const before = treeHash(dir);
  const v = await verifyChange(dir, changed.map((c) => c.path), { render: render ? (d, pages) => render(d, pages, id) : null, exec, ciOnly: ciOnly ? CI_NOTE : '',
    onlyTests: trustedTests(dir, changed), timeoutMs: Number(cfg.selfpub_test_ms) || undefined });
  const moved = treeHash(dir) !== before;   // the checks must be of the bytes that get published
  if (moved) Object.assign(v, { ready: false, render: { ...v.render, note: '检查期间文件被改动 · Files changed during the checks' } });
  const missing = claimedNotChanged(turn.reply, changed);
  if (missing.length) Object.assign(v, { ready: false, claims: { missing, note: claimsNote(missing) } });
  putChange(root, id, { who: user.id, convo: convo || '', branch, base, verifiedHash: before, state: v.ready ? 'ready' : 'unverified', files: changed,
    verify: { ready: v.ready, tests: v.tests, render: v.render, claims: v.claims || null }, request: String(request || message).slice(0, 300) });
  return { id, branch, ready: v.ready, headline: verifyHeadline(v, changed.length), reply: turn.reply || '', changed, shots: v.render.shots };
}
