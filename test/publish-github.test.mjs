// Publish against a FAKE GitHub (test/helpers-fake-github.mjs) and a local bare repo for the
// release push (docs/adr/0039 §5–6). No real token, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeGitHub, FAKE_TOKEN } from './helpers-fake-github.mjs';
import { startPublish } from '../lib/publish/run.mjs';
import { cutRelease } from '../lib/publish/release.mjs';
import { sha256 } from '../lib/publish/github.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pubgh-'));
  const a = path.join(d, 'node', 'workspace', 'apps', 'myapp');
  fs.mkdirSync(path.join(a, 'data'), { recursive: true });
  fs.writeFileSync(path.join(a, 'index.html'), '<h1>My App</h1>\n');
  fs.writeFileSync(path.join(a, 'meta.json'), JSON.stringify({ title: 'My App', shared: true }));
  fs.writeFileSync(path.join(a, 'data', 'x.json'), '{}');
  const terms = path.join(d, 'node');
  fs.writeFileSync(path.join(terms, 'privacy-terms.txt'), 'Zorblax\n');
  fs.writeFileSync(path.join(terms, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  // The public repo: a bare remote with a tagged release base.
  const work = path.join(d, 'work'); fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version: '5.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'version-notes.json'), JSON.stringify({ 'v5.0.0': { date: '2026-10-12', features: [], fixes: [] } }, null, 2) + '\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'base'); git(work, 'tag', 'v5.0.0');
  const bare = path.join(d, 'remote.git');
  git(d, 'clone', '-q', '--bare', work, bare);
  git(work, 'remote', 'add', 'origin', bare);
  // What a real merge does to main: the PR branch merged with a merge commit.
  const doMerge = (pr) => {
    git(work, 'fetch', '-q', 'origin'); git(work, 'checkout', '-q', '-B', 'main', 'origin/main');
    git(work, 'checkout', '-qb', 'pubbranch'); fs.writeFileSync(path.join(work, 'app.txt'), 'x'); git(work, 'add', '.');
    git(work, 'commit', '-qm', 'feat(apps): publish myapp'); git(work, 'checkout', '-q', 'main');
    git(work, 'merge', '-q', '--no-ff', 'pubbranch', '-m', pr.mergeTitle); git(work, 'push', '-q', 'origin', 'main'); git(work, 'branch', '-qD', 'pubbranch');
  };
  return { d, a, terms, bare, work, doMerge };
}
const opts = (fx, gh, extra = {}) => ({ token: FAKE_TOKEN, api: gh.url, repo: 'csheargm/superelf', remoteUrl: fx.bare, termsRoot: fx.terms, pollMs: 5, maxPolls: 20, ...extra });

test('PR has the code files (no data/), the builtin-versions entry and the bilingual title; green CI merges and releases', async () => {
  const fx = fixture();
  const gh = await startFakeGitHub({ versions: { other: ['00'] }, onMerge: (pr) => fx.doMerge(pr) });
  try {
    const { status, done } = await startPublish({ appDir: fx.a, slug: 'myapp', title: 'My App', options: opts(fx, gh) });
    assert.equal(status.state, 'checking');
    const pr = gh.st.pulls[0];
    assert.equal(pr.title, '发布 My App · Publish My App');
    assert.match(pr.head, /^publish\/myapp-\d{8}$/);
    const files = gh.files(pr);
    assert.deepEqual(Object.keys(files).sort(), ['lib/builtin-app-versions.json', 'workspace.example/apps/myapp/index.html', 'workspace.example/apps/myapp/meta.json']);
    assert.deepEqual(JSON.parse(files['lib/builtin-app-versions.json']).myapp, [sha256('<h1>My App</h1>\n')]);
    assert.deepEqual(JSON.parse(files['workspace.example/apps/myapp/meta.json']), { title: 'My App' });
    const end = await done;
    assert.equal(end.state, 'published', JSON.stringify(end));
    assert.equal(end.version, 'v5.1.0');
    assert.equal(pr.method, 'merge'); assert.equal(pr.mergeTitle, 'Merge: 发布 My App · Publish My App');
    assert.equal(git(fx.bare, 'log', '-1', '--format=%s%n%an <%ae>', 'main').trim(), 'release: v5.1.0\ncsheargm <csheargm@users.noreply.github.com>');
    assert.ok(gh.st.authSeen.every((h) => h === `Bearer ${FAKE_TOKEN}`));
    assert.ok(!JSON.stringify(end).includes(FAKE_TOKEN), 'the token is in no status');
  } finally { await gh.close(); fs.rmSync(fx.d, { recursive: true, force: true }); }
});

test('red CI: the PR stays open, nothing merged or released', async () => {
  const fx = fixture(); const gh = await startFakeGitHub();
  try {
    gh.st.checks = 'failure';
    const before = git(fx.bare, 'rev-parse', 'main');
    const end = await (await startPublish({ appDir: fx.a, slug: 'myapp', title: 'My App', options: opts(fx, gh) })).done;
    assert.equal(end.state, 'failed'); assert.equal(end.code, 'CI_RED'); assert.match(end.pr, /pull\/1$/);
    assert.ok(!gh.st.pulls[0].merged); assert.equal(git(fx.bare, 'rev-parse', 'main'), before);
  } finally { await gh.close(); fs.rmSync(fx.d, { recursive: true, force: true }); }
});

test('no check runs at all is pending, never green (R14): times out with the PR open', async () => {
  const fx = fixture(); const gh = await startFakeGitHub();
  try {
    gh.st.checks = 'none';
    const end = await (await startPublish({ appDir: fx.a, slug: 'myapp', title: 'My App', options: opts(fx, gh, { maxPolls: 3 }) })).done;
    assert.equal(end.code, 'CI_TIMEOUT'); assert.ok(!gh.st.pulls[0].merged);
  } finally { await gh.close(); fs.rmSync(fx.d, { recursive: true, force: true }); }
});

test('failure paths: bad token, branch exists, merge refused, scan hit, missing terms, one publish at a time', async () => {
  const fx = fixture(); const gh = await startFakeGitHub();
  const go = (o = {}) => startPublish({ appDir: fx.a, slug: 'myapp', title: 'My App', options: opts(fx, gh, o) });
  try {
    let s = (await go({ token: 'wrong-token' })).status;
    assert.equal(s.code, 'TOKEN_REJECTED'); assert.ok(!s.error.includes('wrong-token'));
    gh.st.mergeable = false;
    s = await (await go()).done;
    assert.equal(s.code, 'MERGE_REFUSED'); assert.match(s.error, /not mergeable/);
    s = (await go()).status;
    assert.equal(s.code, 'BRANCH_EXISTS', 'same day, same slug: refused, not overwritten');
    const p = go(); await assert.rejects(go(), { code: 'IN_FLIGHT' }); await p;
    fs.writeFileSync(path.join(fx.a, 'index.html'), '<p>made in Quux Town</p>\n');
    s = (await go()).status;
    assert.equal(s.state, 'blocked'); assert.equal(s.hits[0].text, '<p>made in Quux Town</p>');
    fs.rmSync(path.join(fx.terms, 'workspace', 'identity-denylist.txt'));
    s = (await go()).status;
    assert.equal(s.code, 'PRIVACY_TERMS_MISSING');
    assert.equal(gh.st.pulls.length, 1, 'only the merge-refused attempt opened a PR');
  } finally { await gh.close(); fs.rmSync(fx.d, { recursive: true, force: true }); }
});

test('release retries when main moved, and refuses loudly after the cap', () => {
  const fx = fixture();
  try {
    git(fx.work, 'checkout', '-qb', 'b1'); fs.writeFileSync(path.join(fx.work, 'f'), '1'); git(fx.work, 'add', '.'); git(fx.work, 'commit', '-qm', 'fix(x): one');
    git(fx.work, 'checkout', '-q', 'main'); git(fx.work, 'merge', '-q', '--no-ff', 'b1', '-m', 'Merge: one fix'); git(fx.work, 'push', '-q', 'origin', 'main');
    // A pre-receive hook rejects the first push only: main "moved" once.
    const hook = path.join(fx.bare, 'hooks', 'pre-receive');
    const flag = path.join(fx.d, 'rejected-once');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${flag}" ]; then touch "${flag}"; echo moved >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
    const r = cutRelease({ remoteUrl: fx.bare, token: FAKE_TOKEN });
    assert.deepEqual(r, { version: 'v5.0.1', pushed: true, tries: 2 });
    fs.writeFileSync(hook, `#!/bin/sh\necho "denied ${FAKE_TOKEN}" >&2\nexit 1\n`, { mode: 0o755 });
    git(fx.work, 'fetch', '-q'); git(fx.work, 'reset', '-q', '--hard', 'origin/main');
    git(fx.work, 'checkout', '-qb', 'b2'); fs.writeFileSync(path.join(fx.work, 'g'), '1'); git(fx.work, 'add', '.'); git(fx.work, 'commit', '-qm', 'fix(y): two');
    git(fx.work, 'checkout', '-q', 'main'); git(fx.work, 'merge', '-q', '--no-ff', 'b2', '-m', 'Merge: two'); fs.rmSync(hook); git(fx.work, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(hook, `#!/bin/sh\necho "denied ${FAKE_TOKEN}" >&2\nexit 1\n`, { mode: 0o755 });
    assert.throws(() => cutRelease({ remoteUrl: fx.bare, token: FAKE_TOKEN }), (e) => e.code === 'RELEASE_PUSH_FAILED' && !e.message.includes(FAKE_TOKEN));
  } finally { fs.rmSync(fx.d, { recursive: true, force: true }); }
});
