// Owner report 2026-11-25: the owner's copy of a repo app showed Publish, then refused. Now the copy publishes
// back to its source app (docs/adr/0039 addendum). Real throwaway node + fake GitHub: the PR writes the SOURCE
// folder (the repo shelf, shared-apps/<slug>/) with only index.html + meta.json (no data/, per-user meta stripped); a member's copy is still 403;
// in a real browser the sheet names the app it updates (phone and iPad).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, api, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startFakeGitHub, FAKE_TOKEN } from './helpers-fake-github.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { hashPassword } from '../lib/auth.mjs';

const MEMBER_TOKEN = 'test-member-token-0123456789abcdef';
let port, root, web, gh, browser;
const put = (dir, files) => { fs.mkdirSync(dir, { recursive: true }); for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), c); } };
before(async () => {
  gh = await startFakeGitHub({ versions: {} }); gh.st.checks = 'pending';
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { github_publish_token: FAKE_TOKEN, github_api_url: gh.url, publish_poll_ms: 50, publish_max_polls: 2 } });
  const cfgFile = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.users[0].passHash = hashPassword('owner-pass-123');
  cfg.users.push({ id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'members/kid' });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  put(path.join(root, 'workspace.example', 'apps', 'tasks'), { 'index.html': '<h1 id="t">Tasks</h1>\n', 'meta.json': JSON.stringify({ title: '待办 Tasks' }) });
  put(path.join(root, 'shared-apps', 'tasks'), { 'index.html': '<h1 id="t">Tasks shelf</h1>\n', 'meta.json': JSON.stringify({ title: '待办 Tasks', shared: true, sharedBy: 'owner', version: '1.0.0' }) });
  put(path.join(root, 'workspace', 'apps', 'tasks-mine'), { 'index.html': '<h1 id="t">Tasks, changed</h1>\n', 'data/list.json': '{"private":true}',
    'meta.json': JSON.stringify({ title: '待办 Tasks', forkedFrom: 'tasks', shared: false, gitRef: 'abc', dataSettings: { a: 1 } }) });
  put(path.join(root, 'workspace', 'apps', 'schoolwork'), { 'index.html': '<h1 id="t">School Helper</h1>\n',   // the owner's screen: a copy of another user's app
    'meta.json': JSON.stringify({ title: 'School Helper', forkedFrom: { uid: 'kid', author: 'Kid', slug: 'schoolwork' } }) });
  put(path.join(root, 'members', 'kid', 'apps', 'tasks'), { 'index.html': '<h1>kid</h1>\n', 'meta.json': JSON.stringify({ forkedFrom: 'tasks' }) });
  fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n');
  fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (gh) await gh.close(); });

test('owner copy → PR against the source folder, only index.html + meta.json; member copy still 403', async () => {
  const url = '/api/apps/tasks-mine/publish';
  const g = await (await api(port, url)).json();
  assert.deepEqual(g.copyOf, { slug: 'tasks', title: '待办 Tasks', path: 'shared-apps/tasks/' }); assert.equal(g.refused, null);
  const pv = await (await api(port, url, { method: 'POST', body: '{"preview":true}' })).json();
  assert.deepEqual(pv.preview.files.map((f) => f.path), ['shared-apps/tasks/index.html', 'shared-apps/tasks/meta.json']);
  assert.deepEqual(pv.preview.copyOf, { slug: 'tasks', title: '待办 Tasks', path: 'shared-apps/tasks/' });
  assert.equal(gh.st.requests.length, 0, 'preview sends nothing');
  const r = await api(port, url, { method: 'POST', body: JSON.stringify({ hash: pv.preview.hash }) });
  assert.equal(r.status, 202, await r.clone().text());
  const tree = [...gh.st.trees.values()][0].tree.map((t) => t.path).sort();
  assert.deepEqual(tree, ['lib/builtin-app-versions.json', 'shared-apps/tasks/index.html', 'shared-apps/tasks/meta.json']);
  const metaBlob = [...gh.st.trees.values()][0].tree.find((t) => t.path.endsWith('meta.json'));
  assert.deepEqual(JSON.parse(gh.st.blobs.get(metaBlob.sha).toString()), { title: '待办 Tasks', shared: true, sharedBy: 'owner', version: '1.0.0' }, 'per-user meta stripped; the shelf fields are the repo\'s');
  assert.match(gh.st.pulls[0].head, /^publish\/tasks-/);
  const st = await (await api(port, url)).json();
  assert.ok(st.status && st.status.pr, 'the status is read under the copy\'s own slug');
  const m = await api(port, '/api/apps/tasks/publish', { method: 'POST', body: '{"preview":true}', headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
  assert.equal(m.status, 403, 'a member\'s Publish is unchanged: owner only');
});

async function openMore(page, slug) {
  await page.click(`.ecard[data-es="${slug}"]`); await page.frameLocator('#fr').locator('#t').waitFor();
  for (let i = 0; i < 3; i++) {   // the open app's ⋯ (the bar may slide away: peek it back)
    if (!(await page.evaluate(() => document.querySelector('#ftitle').getBoundingClientRect().top >= 0))) await page.click('#barpeek');
    try { await page.click('#fmore', { timeout: 5000 }); return; } catch { /* again */ }
  }
}
for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['iPad', { width: 820, height: 1180 }]]) {
  test(`${name}: the owner's copy offers Publish and the sheet names the app it updates`, { skip, timeout: 90000 }, async () => {
    const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
    await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#login[open]'));
    await openMore(page, 'schoolwork');   // School Helper (owner report): another user's app — a plain line, no Publish
    await page.locator('#frameMenu #pubFork').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#frameMenu #pubItem').count(), 0);
    assert.match(await page.locator('#pubFork').textContent(), /^这是 Kid 的应用的副本.*copy of Kid's app.*Make an app/);
    if (process.env.PA_SHOTS) await page.screenshot({ path: path.join(process.env.PA_SHOTS, `copy-other-${name}.png`) });
    await page.keyboard.press('Escape'); await page.mouse.click(5, vp.height - 5);
    await page.evaluate(() => document.querySelector('#back').click());
    await openMore(page, 'tasks-mine');
    const state = page.locator('#pubItem #pubState');
    await page.waitForFunction(() => /Updates the shared app/.test((document.querySelector('#pubItem #pubState') || {}).textContent || ''), null, { timeout: 15000 });
    assert.match(await state.textContent(), /^更新共享应用 待办 Tasks · Updates the shared app 待办 Tasks/);
    assert.equal(await page.locator('#pubFork').count(), 0);
    await page.click('#frameMenu #pubItem');
    const copy = page.locator('#pubSheet #pubCopy'); await copy.waitFor({ timeout: 15000 });
    assert.equal(await copy.textContent(), '更新共享应用 待办 Tasks · Updates the shared app 待办 Tasks');
    assert.match(await page.locator('#pubFiles').textContent(), /shared-apps\/tasks\/index\.html/);
    if (process.env.PA_SHOTS) await page.screenshot({ path: path.join(process.env.PA_SHOTS, `copy-back-${name}.png`) });
    await ctx.close();
  });
}
