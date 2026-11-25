// 菜单随应用栏收起 · Menus close with the app bar (owner 2026-11-24, R6). The open app's ⋯ menu stayed
// over the app after the bar slid away, with no visible way to close it. Now every shell ⋯ popover
// (web/popover.js) closes on Escape, an outside click, a tap inside the app frame, and its anchor going
// away (the bar retracting, the drawer closing, the app changing); the bar does not leave on its clock
// while one of its menus is open. Table-driven over the inventory, on a desktop (mouse), an iPhone and an
// iPad (touch). REAL web.mjs on a throwaway root, never the live node. PA_E2E_ENGINE=webkit for Safari.
// Without Playwright it FAILS unless PA_E2E_SKIP=1. PA_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const ENGINE = process.env.PA_E2E_ENGINE || 'chromium';
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh"><h1 id="t">Todo</h1></body></html>';
const IDLE_PAST_MS = 3500;   // past the shell bar's BAR_IDLE_MS (2.5 s)
const DEVICES = [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, touch: false },
  { name: 'iphone', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'ipad', viewport: { width: 820, height: 1180 }, touch: true },
];

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const app = path.join(root, 'workspace', 'apps', 'todo'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), PAGE);
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Todo' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function signIn(dev) {
  const ctx = await browser.newContext({ viewport: dev.viewport, hasTouch: dev.touch });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  return { ctx, page };
}
const press = (page, dev, sel) => (dev.touch ? page.tap(sel) : page.click(sel));
async function openApp(page) {
  if (!(await page.evaluate(() => frameOpen()))) {
    await page.click('.ecard[data-es="todo"]');
    await page.frameLocator('#fr').locator('#t').waitFor();
  }
}
async function openFrameMenu(page, dev) {
  await openApp(page);
  if (!(await page.evaluate(() => document.querySelector('#frame').classList.contains('barin')))) await press(page, dev, '#barpeek');
  await page.waitForFunction(() => document.querySelector('#fmore').getBoundingClientRect().top >= 0);
  await press(page, dev, '#fmore');
  await page.locator('#frameMenu').waitFor();
}
async function openAppRowMenu(page, dev) {
  await page.evaluate(() => { if (frameOpen()) goHome(); openDrawer(); });
  if ((await page.getAttribute('#secApps .dsec-head', 'aria-expanded')) !== 'true') await page.click('#secApps .dsec-head');   // closed by default
  await page.locator('[data-appmenu="todo"]').waitFor();
  await press(page, dev, '[data-appmenu="todo"]');
  await page.locator('#appMenu').waitFor();
}
async function openHomeMenu(page, dev) {
  await page.evaluate(() => { if (frameOpen()) goHome(); closeDrawer(); });
  await press(page, dev, '#hmore');
  await page.waitForFunction(() => !document.querySelector('#hmenu').hidden);
}
async function openBarAa(page, dev) {
  await openApp(page);
  if (!(await page.evaluate(() => document.querySelector('#frame').classList.contains('barin')))) await press(page, dev, '#barpeek');
  await page.waitForFunction(() => document.querySelector('#frame .aa-btn').getBoundingClientRect().top >= 0);
  await press(page, dev, '#frame .aa-btn');
  await page.locator('#frame .aa.open').waitFor();
}
async function openPubSheet(page, dev) {
  await openFrameMenu(page, dev);
  await page.locator('#frameMenu [data-a="publish"]').click();
  await page.locator('#pubSheet').waitFor();
}
const isGone = (sel) => (sel === '#hmenu' ? document.querySelector('#hmenu').hidden : !document.querySelector(sel));   // #hmenu is hidden, not removed
const waitGone = (page, sel, opt) => page.waitForFunction(isGone, sel, opt);

// The inventory: each popover, how it opens, and the close paths it must honour.
const INVENTORY = [
  { menu: '#frameMenu', open: openFrameMenu, paths: ['escape', 'outside', 'frame-tap', 'bar-retract', 'app-change'] },
  { menu: '#appMenu', open: openAppRowMenu, paths: ['escape', 'outside', 'anchor-hidden'] },
  { menu: '#frame .aa.open', open: openBarAa, paths: ['escape', 'outside', 'frame-tap', 'bar-retract', 'app-change'] },
  { menu: '#hmenu', open: openHomeMenu, paths: ['escape', 'outside'] },
  { menu: '#pubSheet', open: openPubSheet, paths: ['close', 'escape', 'app-change'] },
];
async function closeBy(page, dev, how) {
  if (how === 'escape') return page.keyboard.press('Escape');
  // Outside, in the SHELL: over an app that is its bar's title (all else is the app frame); at Home, the page foot.
  if (how === 'outside') {
    if (await page.evaluate(() => frameOpen())) return press(page, dev, '#ftitle');
    const x = dev.viewport.width / 2, y = dev.viewport.height - 20;
    return dev.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
  }
  // Inside the app frame, at a corner the menu does not cover.
  if (how === 'frame-tap') { const x = 8, y = dev.viewport.height - 8; return dev.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y); }
  if (how === 'bar-retract') return page.evaluate(() => barHide());
  if (how === 'app-change') return page.evaluate(() => goHome());
  if (how === 'anchor-hidden') return page.evaluate(() => closeDrawer());
  if (how === 'close') return press(page, dev, '#pubClose');
  throw new Error('unknown close path ' + how);
}

for (const dev of DEVICES) {
  test(`${dev.name}: the app's ⋯ menu holds the bar, and leaves with it`, { skip }, async () => {
    const { ctx, page } = await signIn(dev);
    try {
      await openFrameMenu(page, dev);
      await page.waitForTimeout(IDLE_PAST_MS);
      assert.ok(await page.evaluate(() => document.querySelector('#frame').classList.contains('barin')), 'the bar stays while its menu is open');
      assert.equal(await page.locator('#frameMenu').count(), 1, 'and the menu with it');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `frame-menu-held-${dev.name}-${ENGINE}.png`) });
      await page.evaluate(() => barHide());   // the bar retracts (frame focus, window blur, or its clock)
      await waitGone(page, '#frameMenu');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `frame-menu-gone-${dev.name}-${ENGINE}.png`) });
      await openBarAa(page, dev);   // the bar's Aa holds it the same way
      await page.waitForTimeout(IDLE_PAST_MS);
      assert.ok(await page.evaluate(() => document.querySelector('#frame').classList.contains('barin')), 'the bar stays while its Aa is open');
    } finally { await ctx.close(); }
  });
  test(`${dev.name}: every popover closes by each of its close paths`, { skip }, async () => {
    const { ctx, page } = await signIn(dev);
    try {
      for (const row of INVENTORY) for (const how of row.paths) {
        await row.open(page, dev);
        await closeBy(page, dev, how);
        await waitGone(page, row.menu, { timeout: 3000 })
          .catch(() => assert.fail(`${row.menu} did not close by ${how} on ${dev.name}`));
      }
    } finally { await ctx.close(); }
  });
}
