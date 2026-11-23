// Settings > Family accounts, driven in a real browser through the real shell (R6).
// Overnight test 2026-11-22 findings, one case each (see test/family-admin.test.mjs for the API side).
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

let port, root, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

// The owner's shell with Settings open; every native dialog is recorded and answered.
async function openSettings({ viewport = { width: 1024, height: 800 }, answer = () => true } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* frames without storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message(), value: d.defaultValue() });
    const a = answer(d); if (a === false) await d.dismiss(); else await d.accept(typeof a === 'string' ? a : undefined); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#dot.ok'));
  await page.click('#settings');
  await page.waitForSelector('#addU');
  return { ctx, page, dialogs };
}
const waitDialogs = async (page, dialogs, n) => { for (let i = 0; i < 100 && dialogs.length < n; i++) await page.waitForTimeout(50); };

test('F5-1: Add member with no password shows a real one-time sign-in code', { skip, timeout: 60000 }, async () => {
  const { ctx, page, dialogs } = await openSettings();
  try {
    await page.fill('#nId', 'mia'); await page.fill('#nName', 'Mia');
    await page.click('#addU');
    await waitDialogs(page, dialogs, 1);
    assert.equal(dialogs[0].type, 'prompt');
    assert.match(dialogs[0].message, /^已添加/, '中文 first');
    assert.ok(dialogs[0].value.length >= 20, `the code is not empty: ${JSON.stringify(dialogs[0].value)}`);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: dialogs[0].value }) });
    assert.equal(login.status, 200, 'the shown code signs Mia in');
  } finally { await ctx.close(); }
});
