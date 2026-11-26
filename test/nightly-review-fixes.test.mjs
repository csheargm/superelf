// The first nightly review's confirmed findings (2026-11-26, range 1b24905..0686770), one regression each.
// Units over the real modules; the flows they sit in have their own e2e suites (selfpub-e2e, nightly-review-e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-app.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skipIf } from './helpers-skip.mjs';
import { tgit } from './helpers-selfpub.mjs';
import { nightlySetting } from '../lib/nightly-review/config.mjs';
import { runNightlyReview } from '../lib/nightly-review/job.mjs';
import { makeShareStore } from '../lib/app-share.mjs';
import { applyAccountName } from '../lib/demo-profile-name.mjs';
import { offerApply } from '../lib/app-edit-offer.mjs';
import { mintConfirm, pendingConfirm } from '../lib/app-edit-confirm.mjs';
import { makeRenderer } from '../lib/selfpub/render.mjs';
import { codexEnv, CODEX_ENV_KEYS } from '../lib/codex.mjs';
import { lastOutcome } from '../lib/jobstatus.mjs';
import { runJob } from '../lib/autonomy.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nrfix-')));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOT_ROOT_POSIX = skipIf(process.platform === 'win32' || (process.getuid && process.getuid() === 0), 'posix-non-root', 'needs a read-only folder that the user cannot write');

test('nightly config: two repo names that share a checkout folder are refused', () => {
  const cfg = (names) => ({ nightly_review: { enabled: true, dir: '/tmp/nr', repos: names.map((name) => ({ name, url: 'https://github.com/o/r.git' })) } });
  assert.throws(() => nightlySetting(cfg(['My Repo', 'my-repo']), {}), /same folder/);
  assert.equal(nightlySetting(cfg(['My Repo', 'Other']), {}).repos.length, 2, 'control: distinct folders pass');
});

test('nightly review: every project failed → the briefing still goes out, marked failed; one success → not failed', async () => {
  const d = tmp();
  try {
    const work = path.join(d, 'w'); fs.mkdirSync(work); tgit(work, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(work, 'a.mjs'), 'export const a = 1;\n'); tgit(work, 'add', '.');
    tgit(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'a');
    const bare = path.join(d, 'r.git'); tgit(d, 'clone', '-q', '--bare', work, bare);
    const run = (repos) => runNightlyReview({ cfg: { nightly_review: { enabled: true, dir: path.join(d, 'nr'), repos } }, env: {}, now: Date.now, audit: () => {},
      codex: async () => ({ ok: true, text: '[]' }), verify: async () => ({ ok: true, text: 'CONFIRMED' }) });
    const allBad = await run([{ name: 'gone', url: path.join(d, 'missing.git') }]);
    assert.equal(allBad.failed, true); assert.match(allBad.body, /REVIEW FAILED/);
    const mixed = await run([{ name: 'gone', url: path.join(d, 'missing.git') }, { name: 'ok', url: bare }]);
    assert.equal(mixed.failed, undefined, 'one project reviewed: the run did not fail');
  } finally { rmTemp(d); }
});

test('Jobs view: a job-run that reported but failed reads failed; runJob carries the flag with its briefing', async () => {
  const at = new Date().toISOString();
  assert.equal(lastOutcome([{ ev: 'job-run', who: 'o', job: 'nightly-review', briefing: 'b', failed: true, at }], 'o', { job: 'nightly-review' }).outcome, 'failed');
  assert.equal(lastOutcome([{ ev: 'job-run', who: 'o', job: 'nightly-review', briefing: 'b', at }], 'o', { job: 'nightly-review' }).outcome, 'ok', 'control');
  const d = tmp();
  try {
    const out = await runJob({ id: 'o', workspace: d }, { name: 'nightly-review', title: 'x' }, { run: async () => ({ body: 'REVIEW FAILED', failed: true }) });
    assert.ok(out.briefing); assert.equal(out.failed, true);
    const ok = await runJob({ id: 'o', workspace: d }, { name: 'nightly-review', title: 'x' }, { run: async () => ({ body: 'fine' }) });
    assert.equal(ok.failed, undefined);
  } finally { rmTemp(d); }
});

test('codex env: an allow-list — the node\'s secrets stay out, HOME / PATH / its own sign-in stay in', () => {
  const env = codexEnv({ PATH: '/bin', HOME: '/h', CODEX_HOME: '/h/.codex', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'c', AGENTMAIL_KEY: 'm' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CODEX_HOME: '/h/.codex', OPENAI_API_KEY: 'k' });
  assert.ok(!CODEX_ENV_KEYS.some((k) => /TOKEN|SECRET|PASS|GITHUB|ANTHROPIC|CLAUDE/i.test(k)));
});

test('share store: a link whose snapshot folder is missing is not active; a re-share keeps one live folder', () => {
  const d = tmp();
  try {
    const s = makeShareStore(d);
    const files = [{ path: 'index.html', content: Buffer.from('<p>v1</p>') }];
    const rec = s.put({ srcKey: 'o/app', slug: 'app', name: 'App', desc: '', by: { kind: 'owner', uid: 'o', name: 'O' }, files });
    assert.ok(s.get(rec.id));
    const again = s.put({ srcKey: 'o/app', slug: 'app', name: 'App', desc: '', by: { kind: 'owner', uid: 'o', name: 'O' }, files: [{ path: 'index.html', content: Buffer.from('<p>v2</p>') }] });
    assert.equal(again.id, rec.id); assert.equal(fs.readFileSync(path.join(s.dir, rec.id, 'index.html'), 'utf8'), '<p>v2</p>');
    fs.rmSync(path.join(s.dir, rec.id), { recursive: true });   // a crash between the two renames
    assert.equal(s.get(rec.id), null, 'no snapshot: never advertised as active');
    assert.throws(() => s.join(rec.id, 'v1', path.join(d, 'apps'), 10), (e) => e.code === 'gone', 'an open landing page joining it gets gone, not a raw fs error');
  } finally { rmTemp(d); }
});

test('share store: a failed swap puts the old snapshot back', () => {
  const d = tmp();
  const orig = fs.renameSync;
  try {
    const s = makeShareStore(d);
    const by = { kind: 'owner', uid: 'o', name: 'O' };
    const rec = s.put({ srcKey: 'o/app', slug: 'app', name: 'App', desc: '', by, files: [{ path: 'index.html', content: Buffer.from('v1') }] });
    let n = 0;
    fs.renameSync = (a, b) => { if (++n === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return orig(a, b); };   // the tmp → live rename fails
    assert.throws(() => s.put({ srcKey: 'o/app', slug: 'app', name: 'App', desc: '', by, files: [{ path: 'index.html', content: Buffer.from('v2') }] }), /EIO/);
    fs.renameSync = orig;
    assert.equal(fs.readFileSync(path.join(s.dir, rec.id, 'index.html'), 'utf8'), 'v1');
    assert.ok(s.get(rec.id));
  } finally { fs.renameSync = orig; rmTemp(d); }
});

test('demo sign-in: a profile name that cannot be written never aborts sign-in', { skip: NOT_ROOT_POSIX }, () => {
  const d = tmp(), ws = path.join(d, 'ws');
  fs.mkdirSync(ws); fs.chmodSync(ws, 0o500);
  try {
    assert.equal(applyAccountName({ workspace: ws, name: 'Visitor', role: 'member' }, { full_name: 'Ada Lovelace' }), false);
  } finally { fs.chmodSync(ws, 0o700); rmTemp(d); }
});

test('app edit: a replacement plan with nothing readable retires the earlier plan', () => {
  const who = 'o', slug = 'notes', convo = 'c-' + Date.now();
  mintConfirm({ who, slug, plan: 'old plan', request: 'make it blue', convo });
  assert.ok(pendingConfirm({ who, slug, convo }), 'control: the old plan is pending');
  const lines = [];
  offerApply({ who, edit: { slug }, message: 'make it red', r: { text: '[[apply]]   ' }, line: (l) => lines.push(l), convoId: convo, wsDir: '/x' });
  assert.equal(pendingConfirm({ who, slug, convo }), null, 'a later yes applies nothing stale');
  assert.equal(lines.length, 0, 'no Apply button');
});

test('render check: a page that hangs past the deadline rejects and closes the browser (the lock is released)', async () => {
  const d = tmp();
  try {
    const fake = path.join(d, 'pw.mjs'); fs.writeFileSync(fake, '');
    let closed = 0;
    const browser = { newContext: () => new Promise(() => {}), close: async () => { closed++; } };   // never answers, like a busy page
    const render = makeRenderer({ shotsDir: path.join(d, 'shots'), env: { SELFPUB_PLAYWRIGHT: fake }, deadlineMs: 50,
      load: async () => ({ chromium: { launch: async () => browser } }) });
    const work = path.join(d, 'w'); fs.mkdirSync(work); tgit(work, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(work, 'web')); fs.writeFileSync(path.join(work, 'web', 'a.css'), 'a{}'); tgit(work, 'add', '.');
    tgit(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'a'); tgit(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await assert.rejects(render(work, [], 'x'), /timed out/);
    assert.ok(closed >= 1);
  } finally { rmTemp(d); }
});

test('panel windows: top + bottom docks never take more than TB[1] of the height together, never overlapping', () => {
  const JS = /<script id="paw-script">([\s\S]*?)<\/script>/.exec(read('web/panel-window.inline.html'))[1];
  const win = { innerWidth: 1000, innerHeight: 800, addEventListener() {} };
  new Function('window', 'document', JS)(win, { documentElement: {} });
  const G = win.PAWin.geo;
  const st = (key, where, size) => ({ key, open: true, min: false, max: false, mode: 'dock', where, size: { right: 0.34, left: 0.34, top: size, bottom: size }, rect: null });
  const { rects, push } = G.layout([st('t', 'top', 0.75), st('b', 'bottom', 0.75)], 1000, 800);
  assert.ok(push.top + push.bottom <= Math.round(0.75 * 800), JSON.stringify(push));
  assert.ok(rects.t.y + rects.t.h <= rects.b.y, 'no overlap');
  const one = G.layout([st('t', 'top', 0.75)], 1000, 800);
  assert.equal(one.push.top, 600, 'control: one dock alone keeps its size');
});

test('camera note: gone after NOTE_MS even when the draft is left alone', () => {
  const nodes = {}, timers = [];
  const el = (id) => ({ id, setAttribute() {}, remove() { delete nodes[this.id]; }, prepend(n) { nodes[n.id] = n; } });
  nodes.chips = el('chips');
  const ctx = { document: { getElementById: (i) => nodes[i] || null, createElement: () => el('') }, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {}, PASnap: {} };
  const fresh = /\/\* ══ PA_SHOT_FRESH_BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ══ PA_SHOT_FRESH_END/.exec(read('web/snap.inline.html'))[1];
  vm.runInNewContext(fresh + ';' + read('web/shell-cam.js') + ';this.C=PAShellCam;', ctx);
  ctx.C.say('截图失败 · Screenshot failed');
  assert.ok(nodes.camNote, 'shown');
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 8000);
  timers[0].f();
  assert.equal(nodes.camNote, undefined, 'removed by its timer');
});

test('Share sheet and the core-change card: a dismissed wait never reopens; a poll writes only its own change\'s sheet; shot blobs are revoked', () => {
  const share = read('web/app-share.js'), sp = read('web/selfpub.js');
  assert.match(share, /if\(mine!==seq\|\|!\$\('#shWait'\)\) return;/);
  assert.match(sp, /s&&s\.dataset\.id===String\(id\)/);
  assert.match(sp, /id="spSheetState" data-id="\$\{esc\(String\(id\)\)\}"/);
  assert.match(sp, /URL\.revokeObjectURL/);
});

test('Run now: an all-failed run answers failed: true and the Jobs row says the run failed', () => {
  assert.match(read('web.mjs'), /alreadyRanToday, \.\.\.\(out\.failed \? \{ failed: true \} : \{\}\), body,/);
  assert.match(read('web/settings.js'), /:j\.failed\?` · ✗ 运行失败/);
});

test('nightly config: a non-string repo name is a config error, never a TypeError', () => {
  assert.throws(() => nightlySetting({ nightly_review: { enabled: true, dir: '/tmp/nr', repos: [{ name: 123, url: 'https://github.com/o/r.git' }] } }, {}), /nightly_review: repos\[0\]\.name/);
});
