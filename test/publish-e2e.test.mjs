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
let browser, gh; const roots = [], webs = [];

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

async function openMenu(port, token) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* no storage */ } }, token);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#dot.ok'));
  await page.click('#menu');
  await page.click('#dApps [data-appmenu="myapp"]');
  await page.waitForSelector('#appMenu');
  return { ctx, page };
}

before(async () => { if (skip) return; browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); for (const w of webs) await stopWeb(w); for (const r of roots) rmTemp(r); if (gh) await gh.close(); });

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
    await page.click('#pubGo');
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
