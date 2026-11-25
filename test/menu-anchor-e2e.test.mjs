// 菜单贴着 ⋯ 打开 · Every ⋯ menu opens at its ⋯ (owner 2026-11-25: "the menu is too far away from the 3 dots").
// At 1680 wide the home ⋯ sat at the right of the centred page column while its menu was pinned to the
// window's right edge, ~300px away. Invariant over the inventory of anchored menus (web/popover.js placeMenu):
// the menu's top is within ANCHOR_SLACK below its ⋯, and its right edge within ANCHOR_SLACK of the ⋯'s
// right edge, unless it is clamped inside the window (MENU_EDGE). REAL web.mjs on a throwaway root.
// Without Playwright it FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const ANCHOR_SLACK = 12;
const MENU_EDGE = 8;   // = web/popover.js MENU_EDGE
const VIEWPORTS = [{ width: 1680, height: 967 }, { width: 390, height: 844 }];

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const app = path.join(root, 'workspace', 'apps', 'todo'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><h1 id="t">Todo</h1>');
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Todo' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function openHome(page) {
  await page.click('#hmore'); await page.waitForFunction(() => !document.querySelector('#hmenu').hidden);
}
async function openRow(page) {
  await page.evaluate(() => openDrawer());
  if ((await page.getAttribute('#secApps .dsec-head', 'aria-expanded')) !== 'true') await page.click('#secApps .dsec-head');
  await page.click('[data-appmenu="todo"]'); await page.locator('#appMenu').waitFor();
}
async function openFrame(page) {
  await page.click('.ecard[data-es="todo"]'); await page.frameLocator('#fr').locator('#t').waitFor();
  if (!(await page.evaluate(() => document.querySelector('#frame').classList.contains('barin')))) await page.click('#barpeek');
  await page.waitForFunction(() => document.querySelector('#fmore').getBoundingClientRect().top >= 0);
  await page.click('#fmore'); await page.locator('#frameMenu').waitFor();
}
const INVENTORY = [
  { name: 'home ⋯', btn: '#hmore', menu: '#hmenu', open: openHome, done: (p) => p.keyboard.press('Escape') },
  { name: 'drawer row ⋯', btn: '[data-appmenu="todo"]', menu: '#appMenu', open: openRow, done: (p) => p.evaluate(() => { closeMenuPop(); closeDrawer(); }) },
  { name: 'app bar ⋯', btn: '#fmore', menu: '#frameMenu', open: openFrame, done: (p) => p.evaluate(() => goHome()) },
];
const rects = (page, b, m) => page.evaluate(([b, m]) => {
  const r = (s) => { const q = document.querySelector(s).getBoundingClientRect(); return { top: q.top, bottom: q.bottom, left: q.left, right: q.right }; };
  return { b: r(b), m: r(m), w: innerWidth };
}, [b, m]);

for (const vp of VIEWPORTS) {
  test(`${vp.width}px: every ⋯ menu opens at its ⋯`, { skip }, async () => {
    const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#login[open]');
      await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
      await page.waitForFunction(() => !document.querySelector('#login[open]'));
      for (const row of INVENTORY) {
        await row.open(page);
        const { b, m, w } = await rects(page, row.btn, row.menu);
        const dTop = m.top - b.bottom;
        assert.ok(dTop >= 0 && dTop <= ANCHOR_SLACK, `${row.name}: top ${dTop}px below its ⋯`);
        const clamped = Math.round(m.left) === MENU_EDGE || Math.round(w - m.right) === MENU_EDGE;
        assert.ok(Math.abs(m.right - b.right) <= ANCHOR_SLACK || clamped, `${row.name}: right edge ${m.right - b.right}px off its ⋯, not clamped`);
        assert.ok(m.left >= MENU_EDGE - 1 && m.right <= w - MENU_EDGE + 1, `${row.name}: inside the window`);
        await row.done(page);
      }
    } finally { await ctx.close(); }
  });
}
