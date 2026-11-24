// Publish in a real browser (docs/adr/0039 §1, §8): owner ⋯ → Publish → confirm sheet → notice;
// the token-needed screen; a member never sees the item. Throwaway node + FAKE GitHub + a local
// bare repo for the release push; never a real token. Runs in the engine PA_E2E_ENGINE names
// (chromium default, webkit = iPad Safari). Without Playwright it FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startFakeGitHub, FAKE_TOKEN } from './helpers-fake-github.mjs';

const MEMBER_TOKEN = 'test-member-token-0123456789abcdef';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let browser, gh, gh2; const roots = [], webs = [];
const SHOTS = process.env.PUB_SHOT_DIR || '';   // optional: where to save the sheet screenshots

function remote(root) {
  const work = path.join(root, 'pubwork'); fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'package.json'), '{"version":"5.0.0"}\n');
  fs.writeFileSync(path.join(work, 'version-notes.json'), '{"v5.0.0":{"date":"2026-10-12","features":[],"fixes":[]}}\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'base'); git(work, 'tag', 'v5.0.0');
  const bare = path.join(root, 'pubremote.git'); git(root, 'clone', '-q', '--bare', work, bare); git(work, 'remote', 'add', 'origin', bare);
  const merge = (pr) => { git(work, 'checkout', '-qb', 'p'); fs.writeFileSync(path.join(work, 'a'), 'a'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'feat(apps): publish');
    git(work, 'checkout', '-q', 'main'); git(work, 'merge', '-q', '--no-ff', 'p', '-m', pr.mergeTitle); git(work, 'push', '-q', 'origin', 'main'); };
  return { bare, merge };
}

async function node(extra, { terms = true } = {}) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: extra });
  const f = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  cfg.users.push({ id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'members/kid' });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  for (const ws of ['workspace', 'members/kid']) {
    const a = path.join(root, ws, 'apps', 'myapp'); fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(path.join(a, 'index.html'), '<h1>My App</h1>\n'); fs.writeFileSync(path.join(a, 'meta.json'), '{"title":"My App"}');
  }
  if (terms) { fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n'); fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n'); }
  const web = startWeb(root); await waitReady(port); roots.push(root); webs.push(web);
  return { port, root };
}

async function openMenu(port, token, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...ctxOpts });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* no storage */ } }, token);
  const page = await ctx.newPage();
  await reopenMenu(page, port);
  return { ctx, page };
}

async function reopenMenu(page, port, reload = true) {
  if (reload) { await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => document.querySelector('#dot.ok')); }
  await page.click('#hmore'); await page.click('#menu');
  // My Apps starts closed (web/drawer-sections.js); open it only when it is, the state is remembered.
  await page.waitForSelector('#dApps [data-appmenu="myapp"]', { state: 'attached' });   // rendered after the profile's saved sections apply
  if (await page.getAttribute('#secApps .dsec-head', 'aria-expanded') === 'false') await page.click('#secApps .dsec-head');
  await page.click('#dApps [data-appmenu="myapp"]');
  await page.waitForSelector('#appMenu');
}

before(async () => { if (skip) return; browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); for (const w of webs) await stopWeb(w); for (const r of roots) rmTemp(r); if (gh) await gh.close(); if (gh2) await gh2.close(); });

test('owner: ⋯ → Publish (with its one-time tip) → files sheet → Publish → "已发布 v5.1.0 · Published"', { skip, timeout: 90000 }, async () => {
  let rem;
  gh = await startFakeGitHub({ onMerge: (pr) => rem.merge(pr) });
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pub-e2e-')); roots.push(tmpRoot);
  rem = remote(tmpRoot);
  const { port } = await node({ github_publish_token: FAKE_TOKEN, github_api_url: gh.url, publish_remote_url: rem.bare, publish_poll_ms: 50 });
  const { ctx, page } = await openMenu(port, OWNER_TOKEN);
  try {
    const item = page.locator('#pubItem');
    assert.match(await item.innerText(), /^发布到公开仓库 · Publish/);
    assert.match(await item.innerText(), /新：.* · New:/, 'one-time bilingual tip line');
    assert.equal(await item.evaluate((b) => b.classList.contains('pa-new')), true);
    await item.click();
    await page.waitForSelector('#pubFiles');
    assert.match(await page.locator('#pubFiles').innerText(), /workspace\.example\/apps\/myapp\/index\.html/);
    // Regression: a second preview on the open sheet must not stack a second Publish handler.
    const starts = []; page.on('request', (r) => { if (r.method() === 'POST' && /\/publish$/.test(r.url()) && !/preview/.test(r.postData() || '')) starts.push(r.url()); });
    await page.evaluate(() => PAPublish.open('myapp')); await page.waitForSelector('#pubGo');
    await page.click('#pubGo');
    await page.waitForTimeout(300);
    assert.equal(starts.length, 1, 'one tap = one publish request');
    await page.waitForSelector('#pubDone', { timeout: 30000 });
    assert.match(await page.locator('#pubDone').innerText(), /^已发布 v5\.1\.0 · Published PR$/);
    assert.equal(gh.st.pulls[0].merged, true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
  } finally { await ctx.close(); }
});

test('owner without a token sees the token-needed steps', { skip, timeout: 60000 }, async () => {
  const { port } = await node({});
  const { ctx, page } = await openMenu(port, OWNER_TOKEN);
  try {
    await page.click('#pubItem');
    await page.waitForSelector('#pubToken');
    assert.equal(await page.locator('#pubToken').innerText(), '需要 GitHub 令牌 · GitHub token needed');
    assert.equal(await page.locator('#pubSheet ol li').count(), 3);
  } finally { await ctx.close(); }
});

test('a member never sees Publish in the ⋯ menu', { skip, timeout: 60000 }, async () => {
  const { port } = await node({ github_publish_token: FAKE_TOKEN });
  const { ctx, page } = await openMenu(port, MEMBER_TOKEN);
  try {
    assert.equal(await page.locator('#appMenu [data-a="publish"]').count(), 0);
    assert.ok(await page.locator('#appMenu [data-a="delete"]').count(), 'the menu itself is there');
  } finally { await ctx.close(); }
});

// Owner feedback: Publish / Close must look like buttons, and the wait sheet must say the owner may
// close it. The result still reaches them after Close (the watcher keeps polling) and after they
// left the page (the next ⋯ open shows it once).
test('sheet buttons look like buttons; wait text says "you can close"; result shows after Close and after leaving', { skip, timeout: 90000 }, async () => {
  gh2 = await startFakeGitHub(); gh2.st.checks = 'pending';
  const { port } = await node({ github_publish_token: FAKE_TOKEN, github_api_url: gh2.url, publish_poll_ms: 50, publish_max_polls: 100000 });
  const { ctx, page } = await openMenu(port, OWNER_TOKEN);
  const look = (sel) => page.locator(sel).evaluate((b) => { const c = getComputedStyle(b); const w = b.closest('#pubSheet').getBoundingClientRect().width;
    return { bg: c.backgroundColor, border: c.borderTopStyle, radius: parseFloat(c.borderTopLeftRadius), narrow: b.getBoundingClientRect().width < w / 2, right: b.getBoundingClientRect().right }; });
  try {
    await page.click('#pubItem'); await page.waitForSelector('#pubGo');
    const go = await look('#pubGo'), close = await look('#pubClose');
    assert.notEqual(go.bg, 'rgba(0, 0, 0, 0)', 'Publish is a filled button');
    assert.ok(go.radius > 0 && go.narrow, 'Publish is rounded and auto width');
    assert.equal(close.border, 'solid', 'Close is an outlined secondary button');
    assert.ok(close.narrow && go.right > close.right, 'Publish sits right of Close');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'confirm-light.png') });
    await page.click('#pubGo'); await page.waitForSelector('#pubWait');
    assert.match(await page.locator('#pubWait').innerText(), /CI 约需 5–10 分钟。可以关闭.* · Publishing — CI takes about 5–10 minutes\. You can close this/);
    assert.equal(await page.locator('#pubGo').count(), 0, 'no second Publish on the wait sheet');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'waiting-light.png') });
    await page.click('#pubClose'); assert.equal(await page.locator('#pubSheet').count(), 0);
    gh2.st.checks = 'failure';
    await page.waitForSelector('#pubFail', { timeout: 30000 });     // after Close: the watcher still tells
    assert.match(await page.locator('#pubFail').innerText(), /CI is red/);
    await reopenMenu(page, port);                                   // already seen: not shown again
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#pubSheet').count(), 0, 'a seen result is not shown again');
  } finally { await ctx.close(); }
});

test('a result that finished while the owner was away shows on the next ⋯ open (dark)', { skip, timeout: 90000 }, async () => {
  const g = await startFakeGitHub(); g.st.checks = 'pending';
  try {
    const { port } = await node({ github_publish_token: FAKE_TOKEN, github_api_url: g.url, publish_poll_ms: 50, publish_max_polls: 100000 });
    const { ctx, page } = await openMenu(port, OWNER_TOKEN, { colorScheme: 'dark' });
    try {
      await page.click('#pubItem'); await page.waitForSelector('#pubGo');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'confirm-dark.png') });
      await page.click('#pubGo'); await page.waitForSelector('#pubWait');
      await page.goto('about:blank');                               // the owner leaves the app
      g.st.checks = 'failure';
      const api = `http://127.0.0.1:${port}/api/apps/myapp/publish`;
      for (let i = 0; i < 200; i++) { const r = await fetch(api, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } }); const j = await r.json(); if (j.status?.state === 'failed') break; await new Promise((r2) => setTimeout(r2, 50)); }
      await reopenMenu(page, port);
      await page.waitForSelector('#pubFail', { timeout: 10000 });
    } finally { await ctx.close(); }
  } finally { await g.close(); }
});

// Owner: "I have not changed this app, but it still lets me Publish — what does publish mean?"
// The item's second line says what Publish would do; an app equal to the repo copy is greyed out.
test('⋯ Publish line: not in repo / up to date (disabled) / N changes; the sheet says what happens', { skip, timeout: 90000 }, async () => {
  const { port, root } = await node({ github_publish_token: FAKE_TOKEN });
  const { ctx, page } = await openMenu(port, OWNER_TOKEN, { viewport: { width: 1180, height: 820 } });
  const line = async () => { await page.waitForFunction(() => document.querySelector('#pubState')?.textContent); return page.locator('#pubState').innerText(); };
  const shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, n) });
  try {
    assert.equal(await line(), '分享为公开应用（所有人可见） · Share as a public app (everyone can see it)');
    assert.equal(await page.locator('#pubItem').isDisabled(), false);
    await shot('menu-not-in-repo.png');
    await page.click('#pubItem'); await page.waitForSelector('#pubWhat');
    assert.match(await page.locator('#pubWhat').innerText(), /^发布会先检查隐私.*pull request on GitHub.*CI checks pass it merges.*everyone.*demo after the next deploy/);
    const repo = path.join(root, 'workspace.example', 'apps', 'myapp'); fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'index.html'), '<h1>My App</h1>\n'); fs.writeFileSync(path.join(repo, 'meta.json'), JSON.stringify({ title: 'My App' }, null, 2) + '\n');
    await page.waitForTimeout(10100);                                // past the status cache
    await reopenMenu(page, port);
    assert.equal(await line(), '已是最新 · Already up to date');
    assert.equal(await page.locator('#pubItem').isDisabled(), true, 'nothing to publish: greyed out');
    await page.locator('#pubState').click({ force: true }); await page.waitForTimeout(300);
    assert.equal(await page.locator('#pubSheet').count(), 0, 'a tap on the greyed line opens nothing');
    await shot('menu-up-to-date.png');
    fs.writeFileSync(path.join(repo, 'index.html'), '<h1>Old</h1>\n');
    await page.waitForTimeout(10100);
    await reopenMenu(page, port);
    assert.equal(await line(), '有 1 处改动未发布 · 1 change not yet published');
    assert.equal(await page.locator('#pubItem').isDisabled(), false);
    await shot('menu-changed.png');
  } finally { await ctx.close(); }
});
