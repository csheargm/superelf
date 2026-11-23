// First-run setup and sign-in cards are modal · 初始化和登录卡片不可绕过 (F5-13).
// Overnight 2026-11-23: on a fresh node, Escape closed the setup card and left the app chrome (chat box,
// gear) live with no account. Both cards now refuse Escape, so nothing behind them can be used until
// the person finishes. Real browser (R6); without Playwright the test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port });   // no password yet: the shell shows first-run setup
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('Escape does not close the setup card; the background stays inert', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#setup[open]');
  await page.locator('#sUser').focus();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');   // twice: Chrome lets a 2nd Escape skip cancel
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.querySelector('#setup').open), true, 'still open after Escape');
  assert.equal(await page.evaluate(() => document.querySelector('#login').open), false);
  // A modal dialog makes everything else inert: a click on the page body does not reach it.
  const hit = await page.evaluate(() => { const el = document.elementFromPoint(5, 5); return !!(el && el.closest('#setup')) || el === document.documentElement || el === document.body; });
  assert.ok(hit, 'nothing behind the card takes the click');
  await page.close();
});

test('Escape does not close the sign-in card either', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#setup[open]');
  // Same handler guards #login: dispatch the cancel the browser fires on Escape and see it refused.
  const refused = await page.evaluate(() => { const d = document.querySelector('#login'); const ev = new Event('cancel', { cancelable: true }); d.dispatchEvent(ev); return ev.defaultPrevented; });
  assert.equal(refused, true);
  await page.close();
});
