// The stray square (owner 2026-11-24): a pale rounded box at the left edge of every PAChat page
// (an app's input, the 改这个应用 · Change-this-app greeting, an empty Chat), plus a thin edge.
// Cause: the CLOSED ☰ list's search input was width:100% + padding on a content-box input, so it
// stuck ~46px out of the off-screen list; the list's and the shell drawer's shadows leaked the edge.
// Here, in a real browser: nothing of a closed drawer may paint on screen, and the first focusable
// element of an app and the panel greeting's first character are what elementFromPoint finds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:8px">'
  + '<input id="t" placeholder="Title (Enter to add)"></body></html>';
const VIEWPORTS = [{ width: 1600, height: 900 }, { width: 1180, height: 820 }];
const LONG_PRESS_MS = 900, SETTLE_MS = 1500;

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const app = path.join(root, 'workspace', 'apps', 'todo'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), PAGE);
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Todo' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

// Every element inside a closed drawer that would paint inside the viewport (none may).
const leaks = (frame) => frame.evaluate(() => {
  const W = innerWidth, H = innerHeight, out = [];
  for (const d of document.querySelectorAll('.pac-list:not(.on),#drawer:not(.open)')) {
    // A closed drawer's own box sits just off screen, but its shadow reaches in: it must not paint at all.
    if (getComputedStyle(d).visibility !== 'hidden') out.push((d.id || d.className) + ' is not hidden');
    for (const e of [d, ...d.querySelectorAll('*')]) {
      const r = e.getBoundingClientRect();
      if (getComputedStyle(e).visibility !== 'hidden' && r.width && r.height && r.right > 0 && r.left < W && r.bottom > 0 && r.top < H) out.push(e.className + ' @' + Math.round(r.left));
    }
  }
  return out;
});
async function openApp(viewport) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  await page.click('.ecard[data-es="todo"]'); await page.frameLocator('#fr').locator('#t').waitFor();
  return { ctx, page };
}

for (const vp of VIEWPORTS) test(`no stray square over an app or the Change-this-app panel at ${vp.width}x${vp.height}`, { skip }, async () => {
  const { ctx, page } = await openApp(vp);
  try {
    const box = await page.frameLocator('#fr').locator('#t').boundingBox();
    assert.equal(await page.frame({ url: /\/app\/owner\/todo\// }).evaluate(() => document.elementFromPoint(document.getElementById('t').getBoundingClientRect().left + 3, document.getElementById('t').getBoundingClientRect().top + 5)?.id), 't', 'the app input is on top at its left padding');
    assert.ok(box.x < 60, 'the input sits at the left edge');
    assert.deepEqual(await leaks(page.mainFrame()), [], 'the closed shell drawer paints nothing');
    await page.waitForTimeout(SETTLE_MS);   // the bar slides away over a freshly opened app
    if (await page.evaluate(() => document.querySelector('#ftitle').getBoundingClientRect().top < 0)) { await page.click('#barpeek'); await page.waitForFunction(() => document.querySelector('#ftitle').getBoundingClientRect().top >= 0 && !document.querySelector('#frame .bar').getAnimations().length); }   // slid fully in: a box read mid-slide puts the press above the title
    const t = await page.locator('#ftitle').boundingBox();
    await page.mouse.move(t.x + 10, t.y + t.height / 2); await page.mouse.down(); await page.waitForTimeout(LONG_PRESS_MS); await page.mouse.up();
    await page.locator('#aePanel').waitFor();
    await page.frameLocator('#aefr').locator('.pac-m.ai').waitFor();   // srcdoc is set after an async fetch
    const fr = await (await page.$('#aefr')).contentFrame();
    assert.deepEqual(await leaks(fr), [], 'the closed ☰ list paints nothing in the panel');
    const hit = await fr.evaluate(() => { const r = document.querySelector('.pac-m.ai').getBoundingClientRect(); const e = document.elementFromPoint(r.left + 14, r.top + 16); return e && e.closest('.pac-m.ai') ? 'greeting' : (e && e.className); });
    assert.equal(hit, 'greeting', 'the greeting\'s first character is not covered');
  } finally { await ctx.close(); }
});
