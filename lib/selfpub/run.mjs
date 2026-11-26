// 发布 superelf 改动 · Core Publish (docs/adr/0043 §5): the app Publish steps (ADR 0039) over a change in
// the checkout. Nothing reaches GitHub before the owner's tap (POST with the preview's hash).
//   preview: collect the diff → deny-list + caps → strict privacy scan → hash        (sends nothing)
//   start:   same again, hash must match → PR via the git data API (token in a header only)
//   finish:  checks → merge → release (shared mergeAndRelease) → "merged, waiting for deploy"
//   live:    after the node restarts on the new release, liveStatus() says "已上线 vX · Live"
import { snapshotHash, PublishError } from '../publish/collect.mjs';
import { loadTermsStrict, scanFiles, scanLabels } from '../publish/scan.mjs';
import { makeClient, openChangePR } from '../publish/github.mjs';
import { destOf, mergeAndRelease } from '../publish/run.mjs';
import { acquireLock, collectChange, diffText, discardBranch, git, repoDir, treeHash } from './checkout.mjs';
import { getChange, putChange } from './state.mjs';

const SECURITY_PATHS = [/^test\//, /^lib\/auth/, /^lib\/agent-origin/, /^lib\/publish\//, /^lib\/selfpub\//, /^web\.mjs$/];
export const securityRelevant = (p) => SECURITY_PATHS.some((re) => re.test(p));

const summaryOf = (c) => String(c.request || '').replace(/^\s*(change superelf|改\s*superelf)\s*[:：]\s*/i, '').split('\n')[0].slice(0, 70) || c.branch;

// Collect + gates, shared by preview and start. Any refused file refuses the WHOLE change (fail closed).
function gather(root, change, o) {
  const dir = repoDir(root);
  const head = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (head !== change.branch) throw new PublishError('SNAPSHOT_CHANGED', '代码副本已换到别的改动 · The checkout moved to another change');
  // The tree must be exactly what verify checked: an edit after it would reuse a stale 'ready'.
  if (!change.verifiedHash || treeHash(dir) !== change.verifiedHash) throw new PublishError('SNAPSHOT_CHANGED', '检查之后文件又变了，请重新提出改动 · Files changed after the checks; ask for the change again');
  const { files, deletes, refused } = collectChange(dir, { maxFiles: o.maxFiles, maxDiffKb: o.maxDiffKb });
  const terms = loadTermsStrict(o.termsRoot);
  const title = `改 superelf：${summaryOf(change)} · Change superelf`;
  const diff = diffText(dir);
  const hits = [...scanFiles(files, terms), ...scanLabels({ 'PR title': title, branch: change.branch, diff, deletes: deletes.join('\n') }, terms)];
  const hash = snapshotHash([...files, ...deletes.map((d) => ({ path: d, content: Buffer.from('\0deleted') }))], destOf(o));
  return { dir, files, deletes, refused, hits, title, hash, diff };
}

export const PREVIEW_DIFF_CHARS = 200000;

export function previewSelf({ root, id, options: o }) {
  const c = getChange(root, id);
  if (!c) throw new PublishError('NO_CHANGE', '没有这个改动 · No such change');
  const g = gather(root, c, o);
  return { id, branch: c.branch, title: g.title, ready: c.state === 'ready', verify: c.verify, repo: o.repo, hash: g.hash, hits: g.hits, refused: g.refused,
    files: g.files.map((f) => ({ path: f.path, bytes: f.content.length, security: securityRelevant(f.path) })), deletes: g.deletes,
    diff: g.diff.slice(0, PREVIEW_DIFF_CHARS), truncated: g.diff.length > PREVIEW_DIFF_CHARS };
}

const prBody = (c, g) => ['改 superelf · Change superelf, from the owner\'s main chat (docs/adr/0043).', '', `Request: ${summaryOf(c)}`, '',
  'Files:', ...g.files.map((f) => `- ${f.path}`), ...g.deletes.map((d) => `- ${d} (deleted)`), '',
  c.verify.tests.ci ? 'Node checks: privacy scan clean. Tests: GitHub CI only (the node never runs code it did not ship); merges only on green.'
    : `Node checks: tests ${c.verify.tests.pass}/${c.verify.tests.tests} pass; privacy scan clean.`, 'GPT review rides the nightly run.'].join('\n');

function refuseStart(c, g) {
  if (c.state !== 'ready') throw new PublishError('NOT_READY', '检查未通过，不能发布 · Checks did not pass; cannot publish');
  if (g.refused.length) throw new PublishError('PATH_REFUSED', `含不允许发布的文件 · Has files that are never published: ${g.refused.map((r) => r.file).join(', ')}`);
  if (!g.files.length && !g.deletes.length) throw new PublishError('NO_CHANGE', '没有改动 · Nothing changed');
  // The owner approves only what the preview could show in full (GPT review).
  if (g.diff.length > PREVIEW_DIFF_CHARS) throw new PublishError('DIFF_TOO_BIG', '改动太长，预览放不下 · The change is too long to preview in full');
}

// A change already handed to GitHub: a new Publish on it is refused, never recorded.
const PAST_READY = ['publishing', 'merged', 'released', 'live'];

// Returns { status, done }. done resolves when merge + release end (tests await it).
export async function startSelf({ root, id, options: o, fetchFn, expectHash }) {
  if (!o.token) throw new PublishError('TOKEN_MISSING', '需要 GitHub 令牌 · GitHub token needed');
  const c = getChange(root, id);
  if (!c) throw new PublishError('NO_CHANGE', '没有这个改动 · No such change');
  // A repeated tap on a released, merged or publishing change is refused
  // BEFORE anything is recorded, so its deploy status is never overwritten with 'failed' (nightly review 2026-11-26).
  if (PAST_READY.includes(c.state)) throw new PublishError('NOT_READY', '这个改动已在发布或已发布 · This change is already publishing or published');
  const release = acquireLock(root);
  let handedOff = false;
  const set = (st) => putChange(root, id, { publish: { ...st, at: Date.now() } }).publish;
  try {
    const g = gather(root, c, o);
    if (!expectHash || g.hash !== expectHash) throw new PublishError('SNAPSHOT_CHANGED', '预览后有改动，请重新预览 · Changed since the preview; preview again');
    refuseStart(c, g);
    if (g.hits.length) { const s = set({ state: 'blocked', step: 'scan', code: 'SCAN_HIT', error: '隐私检查未通过 · Privacy scan found something', hits: g.hits }); return { status: s, done: Promise.resolve(s) }; }
    set({ state: 'opening', step: 'pr' });
    const gh = makeClient({ token: o.token, api: o.api, repo: o.repo, fetchFn });
    // A retry after red CI or a refused merge: the first attempt's branch is still on GitHub and would refuse
    // the new PR (BRANCH_EXISTS). Deleting it closes that PR; the new one replaces it (nightly review 2026-11-26).
    if (c.publish && c.publish.pr) await dropRemoteBranch(gh, c.branch);
    // Parent = the commit the change was made on: if main moved on the same lines, GitHub shows a
    // conflict and the merge is refused, instead of the old file silently undoing the new edit.
    const pr = await openChangePR(gh, { base: c.base, branch: c.branch, title: g.title, body: prBody(c, g), files: g.files, deletes: g.deletes,
      message: `feat(self): ${summaryOf(c)}\n\n- Changed from the owner's main chat (docs/adr/0043); node checks and privacy scan clean; tests in CI.` });
    putChange(root, id, { state: 'publishing' });
    const s = set({ state: 'checking', step: 'checks', pr: pr.url });
    handedOff = true;
    return { status: s, done: finishSelf(root, id, gh, pr, g, o, set).finally(release) };
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    const s = set({ state: 'failed', step: getChange(root, id)?.publish?.step || 'scan', code: e.code, error: e.message });
    return { status: s, done: Promise.resolve(s) };
  } finally { if (!handedOff) release(); }
}

async function dropRemoteBranch(gh, branch) {
  try { await gh.call('DELETE', `/git/refs/heads/${branch}`); }
  catch (e) { if (e.status !== 404 && e.status !== 422) throw e; /* already gone: nothing to delete */ }
}

async function finishSelf(root, id, gh, pr, g, o, set) {
  let step = 'checks';
  const report = (st) => { step = st.step; return set(st); };
  try {
    const rel = await mergeAndRelease(gh, pr, o, `Merge: ${g.title}`, report);
    // No new version cut (bump found nothing to release): it is merged, but nothing will deploy it — never "Live".
    if (!rel.pushed) { putChange(root, id, { state: 'merged' }); try { discardBranch(g.dir); } catch { /* the next request syncs anyway */ } return set({ state: 'failed', step: 'release', code: 'NO_RELEASE', pr: pr.url,
      error: `已合并，但没有发出新版本（仍是 ${rel.version}） · Merged, but no new release was cut (still ${rel.version})` }); }
    putChange(root, id, { state: 'released' });
    try { discardBranch(g.dir); } catch { /* the merged branch stays locally; the next request's startBranch syncs anyway */ }
    return set({ state: 'deploying', step: 'deploy', pr: pr.url, version: rel.version });
  } catch (e) {
    // Merged but no release: the change IS on main; never offer it as 'ready' again (a re-tap would re-PR it).
    // TODO(docs/TODO.md): a retry that resumes at the release step.
    putChange(root, id, { state: step === 'release' ? 'merged' : 'ready' });   // not merged: the PR stays open; the owner can try again
    return set({ state: 'failed', step: e.step || 'merge', code: e.code || 'ERROR', error: e.message, pr: pr.url });
  }
}

// appVersion() reads 'v5.22.0+0 · build · date': the release counts when the X.Y.Z part matches exactly.
const coreOf = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v)) || []).slice(1).map(Number);
export const sameVersion = (running, released) => {
  const a = coreOf(running), b = coreOf(released);
  return b.length === 3 && a.length === 3 && a.every((n, i) => n === b[i]);
};
// Releases are cut from main in order, so a running X.Y.Z at or past the released one contains the change:
// a node that skipped the exact release and deployed a later one is live too (nightly review 2026-11-26).
export const versionAtLeast = (running, released) => {
  const a = coreOf(running), b = coreOf(released);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
export const DEPLOY_WAIT_MS = 30 * 60 * 1000;   // the self-deploy timer runs every 10 min; three tries
// The node's own version after a restart: the released change is live once they match. Not yet → still deploying.
export function liveStatus(root, id, runningVersion) {
  const c = getChange(root, id);
  const p = c && c.publish;
  if (!p || p.state !== 'deploying') return p || null;
  if (runningVersion && p.version && versionAtLeast(runningVersion, p.version)) {
    putChange(root, id, { state: 'live' });
    return putChange(root, id, { publish: { ...p, state: 'live', step: 'done', at: Date.now() } }).publish;
  }
  if (Date.now() - p.at > DEPLOY_WAIT_MS) return { ...p, state: 'waiting', code: 'DEPLOY_TIMEOUT', error: `已合并 ${p.version}，等待部署 · Merged ${p.version}, waiting for deploy` };
  return p;
}
