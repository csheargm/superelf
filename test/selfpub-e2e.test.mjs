// 改 superelf → 可以发布 → 发布 → 已上线 (docs/adr/0043, R6): the whole server flow on a throwaway
// checkout, a local bare remote and a FAKE GitHub. The agent is a stand-in that writes like the real
// lane would (the real model run is a separate, manual step). Nothing reaches the fake GitHub before
// the Publish call; the served folder is never touched; the token only ever travels in a header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startFakeGitHub, FAKE_TOKEN } from './helpers-fake-github.mjs';
import { runCoreChange } from '../lib/selfpub/lane.mjs';
import { previewSelf, startSelf, liveStatus, sameVersion, versionAtLeast, securityRelevant } from '../lib/selfpub/run.mjs';
import { handleSelfpubRoute } from '../lib/selfpub/routes.mjs';
import { getChange, putChange } from '../lib/selfpub/state.mjs';
import { discardBranch } from '../lib/selfpub/checkout.mjs';
import { skipIf } from './helpers-skip.mjs';
const POSIX_ONLY = skipIf(process.platform === 'win32', 'posix-only', 'the core lane runs on Linux/macOS nodes; its jail rule paths, fake CLI permissions and checkout are POSIX (docs/adr/0044)');

const OWNER = { id: 'owner', role: 'owner' };
// The PR's parent is the commit the change was made on (bare main): the fake GitHub must know it.
const seedBase = (fx, gh) => gh.st.commits.set(tgit(fx.bare, 'rev-parse', 'main').trim(), { tree: { sha: 'basetree' }, parents: [] });
const opts = (fx, gh, extra = {}) => (seedBase(fx, gh), { token: FAKE_TOKEN, api: gh.url, repo: 'csheargm/superelf', remoteUrl: fx.bare, termsRoot: fx.terms, pollMs: 5, maxPolls: 20, maxFiles: 40, maxDiffKb: 512, ...extra });
const agent = (write) => async ({ cwd, args }) => { assert.ok(args.includes(`Edit(/${cwd}/**)`)); write(cwd); return { reply: '我改了首页颜色 · I changed the home colour', toolCalls: [{ name: 'Edit', input: { file_path: path.join(cwd, 'web/home.css') } }] }; };
const cssAgent = agent((cwd) => fs.writeFileSync(path.join(cwd, 'web', 'home.css'), 'body{color:#222}\n'));

async function change(fx, runAgent = cssAgent, extra = {}) {
  return runCoreChange({ user: OWNER, origin: { fromApp: false }, message: '改 superelf：首页文字更深 · darker home text', convo: 'c1', root: fx.root, cloneUrl: fx.bare, runAgent,
    cfg: {}, ...extra });
}

test('owner change → "Ready to publish" (server template) → nothing on GitHub → Publish → PR → merged → release → live', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture();
  const served = path.join(fx.d, 'served'); fs.mkdirSync(served); fs.writeFileSync(path.join(served, 'index.html'), 'live');
  const gh = await startFakeGitHub({ onMerge: (pr) => fx.doMerge(pr) });
  try {
    const r = await change(fx);
    assert.equal(r.ready, false, 'a web/ change with no renderer is not ready (D3/D6)');
    assert.match(r.headline, /^未通过检查 · Checks failed/);
    assert.match(r.headline, /No headless browser/);
    assert.doesNotMatch(r.headline, /done|fixed|完成/i);
    const shot = path.join(fx.d, 'shot.png');
    const render = async () => { fs.writeFileSync(shot, 'png'); return { ok: true, shots: [shot] }; };
    discard(fx, r.id);
    const r2 = await change(fx, cssAgent, { render });
    assert.equal(r2.ready, true, r2.headline);
    assert.match(r2.headline, /^可以发布 · Ready to publish — 改了 1 个文件 · 1 file\(s\) changed; 测试 1\/1 通过/);
    assert.match(r2.headline, /GPT review rides the nightly run/);
    assert.equal(gh.st.requests.length, 0, 'nothing reached GitHub before the tap');
    const p = previewSelf({ root: fx.root, id: r2.id, options: opts(fx, gh) });
    assert.deepEqual(p.files.map((f) => f.path), ['web/home.css']); assert.equal(p.hits.length, 0);
    assert.match(p.diff, /\+body\{color:#222\}/);
    assert.equal(gh.st.requests.length, 0, 'the preview sends nothing either');
    const { status, done } = await startSelf({ root: fx.root, id: r2.id, options: opts(fx, gh), expectHash: p.hash });
    assert.equal(status.state, 'checking', JSON.stringify(status));
    const pr = gh.st.pulls[0];
    assert.match(pr.head, /^self\/\d{8}-[a-z0-9]+$/);
    assert.match(pr.title, /^改 superelf：首页文字更深 · darker home text · Change superelf$/);
    assert.equal(String(gh.files(pr)['web/home.css']), 'body{color:#222}\n');
    const end = await done;
    assert.equal(end.state, 'deploying', JSON.stringify(end)); assert.equal(end.version, 'v5.1.0');
    assert.equal(tgit(fx.bare, 'log', '-1', '--format=%s', 'main').trim(), 'release: v5.1.0');
    assert.equal(liveStatus(fx.root, r2.id, 'v5.0.0+0 · b1').state, 'deploying');
    assert.equal(liveStatus(fx.root, r2.id, 'v5.1.0+0 · b2 · 2026-11-25').state, 'live');
    assert.ok(gh.st.authSeen.every((h) => h === `Bearer ${FAKE_TOKEN}`));
    assert.ok(!fs.readFileSync(path.join(fx.root, 'state.json'), 'utf8').includes(FAKE_TOKEN));
    assert.equal(fs.readFileSync(path.join(served, 'index.html'), 'utf8'), 'live', 'the served folder is untouched');
  } finally { await gh.close(); rmTemp(fx.d); }
});

function discard(fx, id) { discardBranch(path.join(fx.root, 'repo')); putChange(fx.root, id, { state: 'discarded' }); }
const okRender = async () => ({ ok: true, shots: ['x.png'] });
const libAgent = agent((cwd) => fs.writeFileSync(path.join(cwd, 'notes.md'), 'a note\n'));
const codeAgent = agent((cwd) => { fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'lib', 'x.mjs'), 'export const x = 1;\n'); });

test('a failing test → Checks failed, the change cannot be published', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();
  try {
    const bad = agent((cwd) => fs.writeFileSync(path.join(cwd, 'web', 'home.css'), 'body{content:"BOOM"}\n'));
    const r = await change(fx, bad, { render: okRender });
    assert.equal(r.ready, false); assert.match(r.headline, /测试 0\/1/); assert.match(r.headline, /Failed: ok/);
    const p = previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) });
    const end = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p.hash })).done;
    assert.equal(end.code, 'NOT_READY'); assert.equal(gh.st.pulls.length, 0);
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('red CI: PR stays open, nothing released, the change can be tried again', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();
  try {
    gh.st.checks = 'failure';
    const r = await change(fx, libAgent);
    assert.equal(r.ready, true, r.headline);
    const before = tgit(fx.bare, 'rev-parse', 'main');
    const p = previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) });
    const end = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p.hash })).done;
    assert.equal(end.code, 'CI_RED'); assert.match(end.pr, /pull\/1$/);
    assert.equal(tgit(fx.bare, 'rev-parse', 'main'), before); assert.equal(getChange(fx.root, r.id).state, 'ready');
    // Tried again (nightly review 2026-11-26): the first attempt's branch is deleted (its PR closed), never BRANCH_EXISTS —
    // even when the saved status lost the PR URL (a failure after the ref was made; GPT review).
    putChange(fx.root, r.id, { publish: { state: 'failed', step: 'pr', code: 'GITHUB_ERROR', at: Date.now() } });
    const p2 = previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) });
    const end2 = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p2.hash })).done;
    assert.equal(end2.code, 'CI_RED', end2.error); assert.match(end2.pr, /pull\/2$/);
    assert.equal(gh.st.pulls[0].closed, true, 'the first PR was closed with its branch');
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('a repeated Publish on a released change is refused and never overwrites its deploy status; a later release counts as live', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture();
  try {
    const r = await change(fx, libAgent);
    assert.equal(r.ready, true, r.headline);
    putChange(fx.root, r.id, { state: 'released', publish: { state: 'deploying', step: 'deploy', version: 'v5.1.0', pr: 'https://x/pull/1', at: Date.now() } });
    await assert.rejects(startSelf({ root: fx.root, id: r.id, options: { token: 't' }, expectHash: 'h' }), (e) => e.code === 'NOT_READY');
    assert.equal(getChange(fx.root, r.id).publish.state, 'deploying', 'the deploy status is kept');
    // The node skipped v5.1.0 and deployed v5.2.0, which contains it: live, not "waiting" for good.
    assert.equal(liveStatus(fx.root, r.id, 'v5.0.9+0 · abc').state, 'deploying');
    assert.equal(liveStatus(fx.root, r.id, 'v5.2.0+0 · abc · 2026-11-27').state, 'live');
  } finally { rmTemp(fx.d); }
});

test('scan hit blocks; a changed checkout after preview refuses; token missing refuses; a write outside undoes the turn', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();
  try {
    const leak = agent((cwd) => fs.writeFileSync(path.join(cwd, 'notes.md'), 'hello Zorblax\n'));
    const r = await change(fx, leak);
    const p = previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) });
    assert.equal(p.hits[0].file, 'notes.md');
    const blocked = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p.hash })).done;
    assert.equal(blocked.state, 'blocked'); assert.equal(gh.st.requests.length, 0);
    fs.writeFileSync(path.join(fx.root, 'repo', 'notes.md'), 'clean now\n');
    const moved = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p.hash })).done;
    assert.equal(moved.code, 'SNAPSHOT_CHANGED');
    await assert.rejects(startSelf({ root: fx.root, id: r.id, options: opts(fx, gh, { token: '' }), expectHash: p.hash }), { code: 'TOKEN_MISSING' });
    discard(fx, r.id);
    const sneaky = async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'x.md'), 'x'); return { reply: '', toolCalls: [{ name: 'Write', input: { file_path: '/data/superelf/web/x.js' } }] }; };
    await assert.rejects(change(fx, sneaky), { code: 'JAIL_BREACH' });
    assert.equal(tgit(path.join(fx.root, 'repo'), 'status', '--porcelain').trim(), '', 'the breached turn was undone');
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('members, guests and app turns never reach the lane', async () => {
  const fx = selfpubFixture();
  try {
    for (const [user, origin] of [[{ id: 'm', role: 'member' }, { fromApp: false }], [{ id: 'g', role: 'guest' }, { fromApp: false }], [OWNER, { fromApp: true }]]) {
      await assert.rejects(runCoreChange({ user, origin, message: '改 superelf：x', root: fx.root, cloneUrl: fx.bare, runAgent: cssAgent }), { status: 403, code: 'edit_superelf_owner_only' });
    }
    assert.ok(!fs.existsSync(path.join(fx.root, 'repo')), 'no checkout was even made');
  } finally { rmTemp(fx.d); }
});

test('route: 403 for a member and the demo; 404 for another user\'s change; owner GET status; discard', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture();
  try {
    const r = await change(fx, libAgent);
    const call = async (user, method, p, extra = {}) => { let out; await handleSelfpubRoute({ method }, {}, p, { user, cfg: { selfpub_root: fx.root }, root: fx.d, readBody: async () => ({}), audit: () => {},
      send: (res, code, type, body) => { out = { code, body: JSON.parse(body) }; }, ...extra }); return out; };
    assert.equal((await call({ id: 'm', role: 'member' }, 'GET', `/api/selfpub/${r.id}`)).code, 403);
    assert.equal((await call(OWNER, 'GET', `/api/selfpub/${r.id}`, { demo: true })).code, 403);
    assert.equal((await call({ id: 'other', role: 'owner' }, 'GET', `/api/selfpub/${r.id}`)).code, 404);
    const st = await call(OWNER, 'GET', `/api/selfpub/${r.id}`);
    assert.equal(st.code, 200); assert.equal(st.body.state, 'ready'); assert.equal(st.body.tokenSet, false);
    assert.equal((await call(OWNER, 'POST', `/api/selfpub/${r.id}/publish`)).body.code, 'TOKEN_MISSING');
    assert.equal((await call(OWNER, 'POST', `/api/selfpub/${r.id}/discard`)).body.state, 'discarded');
    assert.equal(tgit(path.join(fx.root, 'repo'), 'status', '--porcelain').trim(), '');
  } finally { rmTemp(fx.d); }
});

test('a code change is never run by the node: ready, "CI will test this", 0 tests run; the PR body says CI', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub({ onMerge: (pr) => fx.doMerge(pr) });
  try {
    const mark = path.join(fx.d, 'ran');
    const code = agent((cwd) => { fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'lib', 'x.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mark)}, '1');\n`); });
    const r = await change(fx, code);
    assert.equal(r.ready, true, r.headline); assert.match(r.headline, /CI 会测试 · CI will test this/); assert.match(r.headline, /merges only on green CI/);
    assert.equal(getChange(fx.root, r.id).verify.tests.tests, 0); assert.equal(getChange(fx.root, r.id).verify.tests.ci, true);
    assert.ok(!fs.existsSync(mark), 'the agent-written code never ran on the node');
    const p = previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) });
    gh.st.checks = 'failure';
    const end = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p.hash })).done;
    assert.equal(end.code, 'CI_RED', 'red CI: never merged'); assert.match(gh.st.pulls[0].body, /GitHub CI only/);
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('an edit after the checks refuses Publish; a stale discard never wipes a newer change; an API key cannot publish', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();
  try {
    const r = await change(fx, codeAgent);
    assert.equal(r.ready, true, r.headline);
    fs.appendFileSync(path.join(fx.root, 'repo', 'lib', 'x.mjs'), '// later\n');
    assert.throws(() => previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) }), { code: 'SNAPSHOT_CHANGED' });
    const call = async (method, p, extra = {}) => { let out; await handleSelfpubRoute({ method }, {}, p, { user: OWNER, cfg: { selfpub_root: fx.root }, root: fx.d, readBody: async () => ({}), audit: () => {},
      send: (res, code, type, body) => { out = { code, body: JSON.parse(body) }; }, ...extra }); return out; };
    assert.equal((await call('POST', `/api/selfpub/${r.id}/publish`, { apiKey: true })).code, 403);
    assert.equal((await call('POST', `/api/selfpub/${r.id}/discard`)).body.state, 'discarded');
    const b = await change(fx, cssAgent, { render: okRender });
    putChange(fx.root, r.id, { state: 'ready' });   // a replayed discard of the old change
    await call('POST', `/api/selfpub/${r.id}/discard`);
    assert.equal(tgit(path.join(fx.root, 'repo'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), b.branch, 'B is still checked out');
    assert.match(tgit(path.join(fx.root, 'repo'), 'status', '--porcelain'), /home\.css/, "B's edit survived");
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('preview shows a NEW file\'s content; a turn that throws leaves no dirty branch', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();
  try {
    const r = await change(fx, agent((cwd) => fs.writeFileSync(path.join(cwd, 'notes.md'), 'a quiet new line\n')), { render: okRender });
    assert.match(previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) }).diff, /\+a quiet new line/);
    discard(fx, r.id);
    const boom = async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'web', 'home.css'), 'x'); throw new Error('runner died'); };
    await assert.rejects(change(fx, boom), /runner died/);
    assert.equal(tgit(path.join(fx.root, 'repo'), 'status', '--porcelain').trim(), '');
    assert.ok((await change(fx, cssAgent, { render: okRender })).id, 'the next request is not blocked');
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('round 2: no sandbox → a new or ignored test file is never run; odd names and .gitattributes binary still preview', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();
  try {
    const mark = path.join(fx.d, 'ran');
    const sneaky = agent((cwd) => { fs.writeFileSync(path.join(cwd, ':notes.md'), 'odd name\n');
      fs.writeFileSync(path.join(cwd, 'test', 'x.test.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(mark)}, '1'); // /:notes.md'\n`);
      fs.writeFileSync(path.join(cwd, '.gitattributes'), '*.md binary\n'); });
    const r = await change(fx, sneaky, { cfg: {} });
    assert.ok(!fs.existsSync(mark), 'the agent-written test never ran');
    assert.equal(getChange(fx.root, r.id).verify.tests.ci, true, 'CI tests it');
    discard(fx, r.id);
    const r2 = await change(fx, agent((cwd) => fs.writeFileSync(path.join(cwd, ':notes.md'), 'odd name\n')), { cfg: {}, render: okRender });
    assert.match(previewSelf({ root: fx.root, id: r2.id, options: opts(fx, gh) }).diff, /\+odd name/);
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('round 2: a dirty self/* branch no saved change owns (a crash leftover) is thrown away, not CHANGE_OPEN', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture();
  try {
    const crash = async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'web', 'home.css'), 'half\n'); return { reply: '', toolCalls: [] }; };
    const r = await change(fx, crash, { render: okRender });
    const s = JSON.parse(fs.readFileSync(path.join(fx.root, 'state.json'), 'utf8')); delete s.changes[r.id];
    fs.writeFileSync(path.join(fx.root, 'state.json'), JSON.stringify(s));   // as if the node died before saving
    assert.ok((await change(fx, cssAgent, { render: okRender })).ready);
  } finally { rmTemp(fx.d); }
});

test('GPT review: merged but no new version cut is never "deploying" or "Live"; an edited test is flagged', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture(); const gh = await startFakeGitHub();   // no onMerge: main gets nothing new to release
  try {
    const r = await change(fx, libAgent);
    const p = previewSelf({ root: fx.root, id: r.id, options: opts(fx, gh) });
    assert.match(p.title, /^改 superelf：/, 'the public PR title is in the preview');
    const end = await (await startSelf({ root: fx.root, id: r.id, options: opts(fx, gh), expectHash: p.hash })).done;
    assert.equal(end.code, 'NO_RELEASE', JSON.stringify(end)); assert.equal(getChange(fx.root, r.id).state, 'merged');
    assert.equal(liveStatus(fx.root, r.id, 'v5.0.0+0 · b').state, 'failed');
    assert.equal(tgit(path.join(fx.root, 'repo'), 'status', '--porcelain').trim(), '', 'merged: the checkout is clean for the next request');
    assert.ok(securityRelevant('test/x.test.mjs'));
  } finally { await gh.close(); rmTemp(fx.d); }
});

test('versionAtLeast: a later X.Y.Z counts, an earlier or unreadable one does not', () => {
  assert.ok(versionAtLeast('v5.1.0+0', 'v5.1.0')); assert.ok(versionAtLeast('v5.10.0', 'v5.9.3')); assert.ok(versionAtLeast('v6.0.0', 'v5.99.99'));
  assert.ok(!versionAtLeast('v5.0.9', 'v5.1.0')); assert.ok(!versionAtLeast('', 'v5.1.0')); assert.ok(!versionAtLeast('v5.2.0', ''));
});
test('sameVersion compares X.Y.Z only', () => {
  assert.ok(sameVersion('v5.1.0+0 · abc · 2026-11-25', 'v5.1.0'));
  assert.ok(!sameVersion('v5.1.01', 'v5.1.0')); assert.ok(!sameVersion('v5.10.0', 'v5.1.0')); assert.ok(!sameVersion('', 'v5.1.0'));
});
