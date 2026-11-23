// Family Apps and the header name offline · 离线时的家庭应用与名字 (F5-7, R6, real browser).
// Overnight 2026-11-23: offline, the drawer said "None shared yet." and the header lost the name.
// Now the last online list and name are kept per account and shown with an offline mark.
// CONTROL (R14): online, no offline mark; another account on the same browser never sees the list.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Mom', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
    { id: 'kid', name: 'Kid', role: 'member', token: 'kid-token-0123456789abcdefghij', workspace: 'workspace-kid', passHash: hashPassword('kid-pass-12345') }] } });
  const app = path.join(root, 'workspace', 'apps', 'chores'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>c</title><p>chores');
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Chores', desc: 'who does what', shared: true }));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function signIn(page, u, p) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', u); await page.fill('#lpin', p); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
}
const family = (page) => page.evaluate(async () => { await loadFamilyApps(); return document.querySelector('#dFamily').textContent; });

test('offline: the last Family Apps list and the name, marked offline — never "None shared yet."', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } }); const page = await ctx.newPage();
  await signIn(page, 'kid', 'kid-pass-12345');
  await page.waitForFunction(() => document.querySelector('header h1').textContent.startsWith('Kid'));
  const online = await family(page);
  assert.match(online, /Chores/); assert.doesNotMatch(online, /离线 · Offline/, 'CONTROL: online has no offline mark');
  await page.route('**/api/**', (r) => r.abort());   // the node is unreachable; the shell page itself still loads
  await page.reload();
  await page.waitForFunction(() => document.querySelector('header h1').textContent.startsWith('Kid'), null, { timeout: 15000 });
  const off = await family(page);
  assert.match(off, /离线 · Offline — 上次保存的列表 · the last saved list/);
  assert.match(off, /Chores/);
  assert.doesNotMatch(off, /None shared yet/);
  await page.unroute('**/api/**');
  await ctx.close();
});

test('offline with nothing saved says it cannot load, not "None shared yet."; another account sees none of Kid\'s list', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => { localStorage.setItem('pa_family', JSON.stringify({ uid: 'kid', name: 'Kid', apps: [{ uid: 'x', slug: 's', title: 'KIDS SECRET', desc: '', author: 'Kid' }] })); });
  await page.route('**/api/family-apps', (r) => r.abort());   // this account never had an online list
  await signIn(page, 'owner', 'owner-pass-123');
  const off = await family(page);
  assert.doesNotMatch(off, /KIDS SECRET/);
  assert.match(off, /家庭应用暂时无法加载 · Family Apps cannot load right now/);
  await ctx.close();
});
