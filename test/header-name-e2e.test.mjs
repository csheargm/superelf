// The header name on a phone, and folder names in replies (F4-8, R6, real browser).
// Overnight 2026-11-23: at 390 px the header read "M…" for "Mara’s 管家", and replies said
// "workspace-mara". Now the product word goes first (the name stays whole), the full title
// returns on a wide window (CONTROL), and replies show "your workspace".
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Mara', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('phone: the header shows the whole name, not "M…"; a wide window shows "Mara’s agent" in English and "Mara的管家" in 中文, never mixed; replies say "your workspace"', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' }); const page = await ctx.newPage();   // English by the device; 中文 is chosen below
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]') && document.querySelector('header h1').dataset.full);
  const h1 = () => page.evaluate(() => { const h = document.querySelector('header h1'); return { text: h.textContent, cut: h.scrollWidth > h.clientWidth }; });
  const phone = await h1();
  assert.equal(phone.cut, false, `not truncated: ${JSON.stringify(phone)}`);
  assert.ok(phone.text.startsWith('Mara'), phone.text);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForFunction(() => document.querySelector('header h1').textContent === 'Mara’s agent');
  await page.evaluate(() => PALang.set('zh'));   // the chosen language, not "Mara’s 管家" mixed (owner 2026-11-27)
  await page.waitForFunction(() => document.querySelector('header h1').textContent === 'Mara的管家');
  await page.evaluate(() => PALang.set('en'));
  await page.waitForFunction(() => document.querySelector('header h1').textContent === 'Mara’s agent');
  await page.setViewportSize({ width: 320, height: 700 });   // the home header keeps only avatar + More: the whole name fits at 320
  await page.waitForFunction(() => { const h = document.querySelector('header h1'); return h.textContent.startsWith('Mara') && h.scrollWidth <= h.clientWidth; });
  await page.setViewportSize({ width: 200, height: 700 });   // too narrow for "Mara’s agent": the short name, never "M…"
  await page.waitForFunction(() => document.querySelector('header h1').textContent === 'Mara');
  const html = await page.evaluate(() => renderMd('Saved to /Users/x/superelf/workspace-mara/apps/notes and `workspace-mara/memory`.'));
  assert.ok(!/workspace-mara/.test(html), html);
  assert.match(html, /your workspace\/apps\/notes/);
  assert.match(await page.evaluate(() => renderMd('my workspace folder')), /my workspace folder/, 'CONTROL: ordinary words are untouched');
  await ctx.close();
});
