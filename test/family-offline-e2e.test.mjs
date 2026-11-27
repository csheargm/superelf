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
// WebKit: once web/sw.js controls the page, Playwright's page.route no longer sees its fetches (the
// worker does not answer /api/family-apps — it passes through — but the interception is lost), so the
// "node unreachable" stub would never apply. Block the worker in these contexts: the feature under
// test is the page's own saved list, and sw.js leaves every /api/* except /api/bible untouched.
const NO_SW = { serviceWorkers: 'block' };
const family = (page) => page.evaluate(async () => { await loadFamilyApps(); return document.querySelector('#dFamily').textContent; });

test('offline: the last Family Apps list and the name, marked offline — never "None shared yet."', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ ...NO_SW, viewport: { width: 1000, height: 800 } }); const page = await ctx.newPage();
  await signIn(page, 'kid', 'kid-pass-12345');
  await page.waitForFunction(() => document.querySelector('header h1').textContent.startsWith('Kid'));
  const online = await family(page);
  assert.match(online, /Chores/); assert.doesNotMatch(online, /离线/, 'CONTROL: online has no offline mark');
  await page.route('**/api/**', (r) => r.abort());   // the node is unreachable; the shell page itself still loads
  await page.reload();
  await page.waitForFunction(() => document.querySelector('header h1').textContent.startsWith('Kid'), null, { timeout: 15000 });
  const off = await family(page);
  assert.match(off, /离线.*上次保存的列表/);
  assert.match(off, /Chores/);
  assert.doesNotMatch(off, /None shared yet/);
  await page.unroute('**/api/**');
  await ctx.close();
});

test('offline with nothing saved says it cannot load, not "None shared yet."; another account sees none of Kid\'s list', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext(NO_SW); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => { localStorage.setItem('pa_family', JSON.stringify({ uid: 'kid', name: 'Kid', apps: [{ uid: 'x', slug: 's', title: 'KIDS SECRET', desc: '', author: 'Kid' }] })); });
  await page.route('**/api/family-apps', (r) => r.abort());   // this account never had an online list
  await signIn(page, 'owner', 'owner-pass-123');
  const off = await family(page);
  assert.doesNotMatch(off, /KIDS SECRET/);
  assert.match(off, /家庭应用暂时无法加载/);
  await ctx.close();
});

// GPT review: a 401/403 is the server refusing, not offline — the saved list is dropped and never redisplayed.
test('a refused /api/family-apps (403) drops the saved list instead of showing it as offline', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext(NO_SW); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await signIn(page, 'kid', 'kid-pass-12345');
  assert.match(await family(page), /Chores/, 'CONTROL: the online list is saved');
  await page.route('**/api/family-apps', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' }));
  const denied = await family(page);
  assert.doesNotMatch(denied, /Chores/); assert.doesNotMatch(denied, /上次保存的列表/, 'no saved-list mark');
  assert.match(denied, /家庭应用暂时无法加载/);
  assert.equal(await page.evaluate(() => localStorage.getItem('pa_family')), null, 'the saved list is gone');
  await ctx.close();
});

// The real offline path, service worker ON (the Safari home-screen app): the device goes offline,
// the worker serves the shell, /api/family-apps fails, and the saved list shows with its mark.
test('service worker on, device offline: the saved Family Apps list shows, marked offline', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await signIn(page, 'kid', 'kid-pass-12345');
  assert.match(await family(page), /Chores/, 'CONTROL: online list');
  // A first load is not controlled until the worker claims it; one reload then must be (a second miss throws).
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 }); });
  await ctx.setOffline(true);
  const off = await family(page);
  assert.match(off, /离线.*上次保存的列表/);
  assert.match(off, /Chores/);
  await ctx.setOffline(false); await ctx.close();
});
