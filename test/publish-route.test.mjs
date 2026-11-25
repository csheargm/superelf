// POST/GET /api/apps/<slug>/publish on a real throwaway node (docs/adr/0039 §1): owner only on the
// server, the token-needed answer, and the token never in an answer or the node's log.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, api, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startFakeGitHub, FAKE_TOKEN } from './helpers-fake-github.mjs';

const MEMBER_TOKEN = 'test-member-token-0123456789abcdef';
const roots = []; const webs = []; let gh;
after(async () => { for (const w of webs) await stopWeb(w); for (const r of roots) rmTemp(r); if (gh) await gh.close(); });

async function node(extra) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: extra });
  const cfgFile = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.users.push({ id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'members/kid' });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const a = path.join(root, 'workspace', 'apps', 'myapp');
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'index.html'), '<h1>My App</h1>\n');
  fs.writeFileSync(path.join(a, 'meta.json'), JSON.stringify({ title: 'My App' }));
  fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n');
  fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  const web = startWeb(root); await waitReady(port);
  roots.push(root); webs.push(web);
  return { port, root, web };
}

test('no token: owner gets the token-needed steps; member and demo-less member calls get 403', async () => {
  const { port } = await node({});
  const r = await api(port, '/api/apps/myapp/publish', { method: 'POST', body: '{}' });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.code, 'TOKEN_MISSING'); assert.equal(j.steps.length, 3); assert.match(j.error, /^需要 GitHub 令牌 · GitHub token needed$/);
  const g = await (await api(port, '/api/apps/myapp/publish')).json();
  assert.equal(g.tokenSet, false);
  for (const method of ['POST', 'GET']) {
    const m = await api(port, '/api/apps/myapp/publish', { method, body: method === 'POST' ? '{}' : undefined, headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    assert.equal(m.status, 403, `member ${method}`);
  }
});

test('with a token: preview lists files, publish opens the PR; the token is in no answer and no log', async () => {
  gh = await startFakeGitHub({ versions: {} });
  gh.st.checks = 'pending';
  const { port, web } = await node({ github_publish_token: FAKE_TOKEN, github_api_url: gh.url, publish_poll_ms: 50, publish_max_polls: 2 });
  const pv = await (await api(port, '/api/apps/myapp/publish', { method: 'POST', body: '{"preview":true}' })).json();
  assert.deepEqual(pv.preview.files.map((f) => f.path), ['workspace.example/apps/myapp/index.html', 'workspace.example/apps/myapp/meta.json']);
  assert.deepEqual(pv.preview.hits, []);
  assert.equal(gh.st.requests.length, 0, 'preview sends nothing to GitHub');
  assert.match(pv.preview.hash, /^[0-9a-f]{64}$/);
  const r = await api(port, '/api/apps/myapp/publish', { method: 'POST', body: JSON.stringify({ hash: pv.preview.hash }) });
  const text = await r.text();
  assert.equal(r.status, 202, text);
  assert.equal(JSON.parse(text).status.state, 'checking');
  assert.equal(gh.st.pulls[0].title, '发布 My App · Publish My App');
  const st = await waitFor(async () => { const j = await (await api(port, '/api/apps/myapp/publish')).json(); return j.status.state === 'failed' && j; }, 'CI timeout notice');
  assert.equal(st.status.code, 'CI_TIMEOUT'); assert.equal(st.tokenSet, true);
  // The later failure reaches Settings → Activity log, not only the first 'checking' line.
  const act = await waitFor(async () => { const rows = await (await api(port, '/api/admin/activity')).json(); return rows.find((x) => x.ev === 'app-publish' && x.state === 'failed'); }, 'publish failure in the activity view');
  assert.equal(act.kind, 'failure'); assert.ok(!JSON.stringify(act).includes(FAKE_TOKEN));
  const all = [text, JSON.stringify(st), JSON.stringify(pv), await (await api(port, '/api/admin/config')).text(), web.log()].join('\n');
  assert.ok(!all.includes(FAKE_TOKEN), 'token never returned or logged');
  const m = await api(port, '/api/apps/myapp/publish', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
  assert.equal(m.status, 403);
});

test('publish needs the preview snapshot: no hash, or an app changed after the preview, is refused', async () => {
  const g2 = await startFakeGitHub({ versions: {} });
  try {
    const { port, root } = await node({ github_publish_token: FAKE_TOKEN, github_api_url: g2.url });
    const pub = (body) => api(port, '/api/apps/myapp/publish', { method: 'POST', body: JSON.stringify(body) });
    const pv = await (await pub({ preview: true })).json();
    const none = await pub({});
    assert.equal(none.status, 422); assert.equal((await none.json()).status.code, 'SNAPSHOT_CHANGED');
    fs.writeFileSync(path.join(root, 'workspace', 'apps', 'myapp', 'index.html'), '<h1>Changed</h1>\n');
    const changed = await pub({ hash: pv.preview.hash });
    assert.equal(changed.status, 422); assert.equal((await changed.json()).status.code, 'SNAPSHOT_CHANGED');
    assert.equal(g2.st.requests.length, 0, 'nothing reached GitHub');
  } finally { await g2.close(); }
});

test('a forked app is refused on the server for preview and publish (not only hidden in the UI)', async () => {
  const { port, root } = await node({ github_publish_token: FAKE_TOKEN, github_api_url: 'http://127.0.0.1:9' });
  fs.writeFileSync(path.join(root, 'workspace', 'apps', 'myapp', 'meta.json'), JSON.stringify({ title: 'My App', forkedFrom: { uid: 'kid', slug: 'theirs' } }));
  const pv = await api(port, '/api/apps/myapp/publish', { method: 'POST', body: '{"preview":true}' });
  const pj = await pv.json();
  assert.equal(pv.status, 422); assert.equal(pj.code, 'FORK_OTHER'); assert.match(pj.error, /copy of kid's app/);
  const r = await api(port, '/api/apps/myapp/publish', { method: 'POST', body: '{"hash":"x"}' });
  assert.equal(r.status, 422); assert.equal((await r.json()).status.code, 'FORK_OTHER');
  const g = await (await api(port, '/api/apps/myapp/publish')).json();
  assert.equal(g.refused.code, 'FORK_OTHER'); assert.equal(g.copyOf, null);
});

test('the confirmed hash binds the destination: a repo change after the preview refuses', async () => {
  const { startPublish, previewPublish } = await import('../lib/publish/run.mjs');
  const { root } = await node({});
  const appDir = path.join(root, 'workspace', 'apps', 'myapp');
  const o = { token: FAKE_TOKEN, repo: 'csheargm/superelf', api: 'http://127.0.0.1:9', termsRoot: root };
  const pv = previewPublish({ appDir, slug: 'myapp', options: o });
  assert.equal(pv.repo, 'csheargm/superelf');
  const { status } = await startPublish({ appDir, slug: 'myapp', options: { ...o, repo: 'someone/else' }, expectHash: pv.hash });
  assert.equal(status.code, 'SNAPSHOT_CHANGED');
  const r2 = await startPublish({ appDir, slug: 'myapp', options: { ...o, remoteUrl: 'https://elsewhere.invalid/x.git' }, expectHash: pv.hash });
  assert.equal(r2.status.code, 'SNAPSHOT_CHANGED', 'the release remote is bound too');
});
