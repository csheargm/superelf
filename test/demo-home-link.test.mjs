// The demo drawer's way back to the front page · 演示抽屉返回主页链接. A visitor in try.superelf.app
// had no way back to superelf.app: the left drawer's last row links there (config demo.home_url, read
// per request). Unit: the URL rule. Real browser (R6): the row is on the demo, absent on the owner node.
// Without Playwright the browser tests FAIL, unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { DEFAULT_HOME_URL, HOME_LABEL, demoHomeUrl, injectDemoBoot } from '../lib/demo-boot.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = 'https://example.org/front';   // already in URL-normal form

test('demo.home_url: default superelf.app; a set http(s) URL wins; anything else falls back', () => {
  assert.equal(DEFAULT_HOME_URL, 'https://superelf.app');
  assert.equal(demoHomeUrl({ demo: { enabled: true } }), DEFAULT_HOME_URL);
  assert.equal(demoHomeUrl({ demo: true }), DEFAULT_HOME_URL);
  assert.equal(demoHomeUrl({ demo: { home_url: ` ${HOME} ` } }), HOME);
  assert.equal(demoHomeUrl({ demo: { home_url: 'https://superelf.app' } }), 'https://superelf.app/', 'normalised by URL');
  for (const bad of ['javascript:alert(1)', 'superelf.app', 'https://example.org:99999', 'https://', 42, ''])
    assert.equal(demoHomeUrl({ demo: { home_url: bad } }), DEFAULT_HOME_URL, String(bad));
});

test('the injected row is a top-level link with the bilingual label', () => {
  const html = injectDemoBoot('<html><head></head><body></body></html>', { demo: { home_url: HOME } });
  assert.ok(html.includes(`a.href=${JSON.stringify(HOME)};a.target='_top'`));
  assert.ok(html.includes(JSON.stringify(HOME_LABEL)));
});

let demo, owner, browser;
async function node(extraConfig) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  const web = startWeb(root); await waitReady(port);
  return { port, root, web };
}
before(async () => {
  if (skip) return;
  demo = await node({ users: [], demo: { enabled: true, title: 'superelf', new_users_per_ip_per_day: 50, home_url: HOME } });
  owner = await node({});
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  for (const n of [demo, owner]) if (n) { await stopWeb(n.web); rmTemp(n.root); }
});

// The demo boot reloads the page once when it first gets a node session: wait for that reloaded page.
const settled = (page) => waitFor(() => page.evaluate(() => document.readyState === 'complete' && performance.getEntriesByType('navigation')[0].type === 'reload')
  .catch(() => false /* mid-navigation: ask again */), 'the boot reload');

test('demo: the drawer ends with "About superelf" linking to demo.home_url, top-level', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${demo.port}/`);
  await settled(page);
  await page.evaluate(() => openDrawer());
  const row = page.locator('#drawer > a#demoHome');
  await row.waitFor({ state: 'visible' });
  assert.equal(await row.textContent(), HOME_LABEL);
  assert.equal(await row.getAttribute('href'), HOME);
  assert.equal(await row.getAttribute('target'), '_top');
  const [rowBottom, drawerBottom] = await page.evaluate(() => [document.getElementById('demoHome').getBoundingClientRect().bottom, document.getElementById('drawer').getBoundingClientRect().bottom]);
  assert.ok(Math.abs(drawerBottom - rowBottom) < 2, `at the drawer's bottom (${rowBottom} vs ${drawerBottom})`);
  if (process.env.PA_SHOT) { await page.waitForTimeout(500); await page.screenshot({ path: process.env.PA_SHOT }); }
  await ctx.close();
});

// The drawer's sections scroll together inside .dscroll (548eebda); the footer rows stay pinned below it.
test('a short screen: the drawer sections scroll and the row is still reachable', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 360 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${demo.port}/`);
  await settled(page);
  await page.evaluate(() => openDrawer());
  const row = page.locator('#drawer > a#demoHome');
  await row.waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelectorAll('#dApps > *').length > 2);
  assert.ok(await page.evaluate(() => { const d = document.querySelector('#drawer > .dscroll'); return d.scrollHeight > d.clientHeight; }), 'CONTROL: the sections overflow this screen');
  assert.ok(await page.evaluate(() => document.getElementById('convos').clientHeight) >= 100, 'the chat list keeps room, not squeezed to zero');
  await row.scrollIntoViewIfNeeded();
  const [top, bottom] = await row.evaluate((e) => { const r = e.getBoundingClientRect(); return [r.top, r.bottom]; });
  assert.ok(top >= 0 && bottom <= 360, `row on screen after scrolling (${top}..${bottom})`);
  await page.evaluate(() => document.getElementById('drawerSearch').click());   // the scrolled-away button, as a tap would
  await page.locator('#chatSearch.on').waitFor();
  await page.mouse.move(150, 100); await page.mouse.wheel(0, 600); await page.waitForTimeout(200);
  const [barTop, st] = await page.evaluate(() => [document.querySelector('.cs-bar').getBoundingClientRect().top, document.getElementById('drawer').scrollTop]);
  assert.ok(barTop >= 0 && barTop < 40 && st === 0, `search bar stays on top (top ${barTop}, scrollTop ${st})`);
  await ctx.close();
});

test('CONTROL / owner node: no such row', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${owner.port}/`);
  await page.locator('#drawer').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#demoHome').count(), 0);
  assert.equal(await page.locator(`text=${HOME_LABEL}`).count(), 0);
  await ctx.close();
});
