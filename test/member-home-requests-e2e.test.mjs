// A member's first home load makes no failing requests · 成员首页无失败请求 (F4-4, R6).
// Overnight 2026-11-23: a new member's home asked for notes/bible app pages that answered 404, and
// every load logged a 401 for /pa-sw-probe. A real browser signs a fresh member in and records every
// response: none may be a 4xx. CONTROL (R14): the owner's own load is checked the same way, and the
// member's app pages are still reachable afterwards (the fix must not hide them).
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

const base = () => `http://127.0.0.1:${port}`;
async function login(username, password) {
  return (await (await fetch(`${base()}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).json()).token;
}

async function failuresOnHome(username, password) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${base()}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', username); await page.fill('#lpin', password); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  await page.waitForTimeout(4000);   // the worker install, the probe and the offline prefetch all run after sign-in
  await page.reload(); await page.waitForTimeout(4000);   // and once more on a plain reload
  await ctx.close();
  return bad;
}

test('the node answers the worker-only probe path with an empty 204 even without a session', async () => {
  const r = await fetch(`${base()}/pa-sw-probe`);
  assert.equal(r.status, 204);
});

test('a new member\'s home and reload make no 4xx requests; the owner\'s neither', { skip, timeout: 90000 }, async () => {
  const owner = await login('owner', 'owner-pass-123');
  const add = await fetch(`${base()}/api/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` }, body: JSON.stringify({ id: 'mara', name: 'Mara', password: 'mara-first-pass-1' }) });
  assert.equal(add.status, 200, await add.text());
  const member = await failuresOnHome('mara', 'mara-first-pass-1');
  assert.deepEqual(member, [], `member: ${member.join(', ')}`);
  const own = await failuresOnHome('owner', 'owner-pass-123');
  assert.deepEqual(own, [], `owner: ${own.join(', ')}`);
});

test('CONTROL: an app the member does own is still listed for the offline prefetch, and its page loads', async () => {
  const owner = await login('owner', 'owner-pass-123');
  await fetch(`${base()}/api/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` }, body: JSON.stringify({ id: 'leo', name: 'Leo', password: 'leo-first-pass-1' }) });
  const dir = path.join(root, 'workspace-leo', 'apps', 'notes'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>n</title><p>notes');
  const leo = await login('leo', 'leo-first-pass-1');
  const c = await (await fetch(`${base()}/api/offline-config`, { headers: { authorization: `Bearer ${leo}` } })).json();
  assert.deepEqual(c.apps, ['notes']);
  assert.equal((await fetch(`${base()}/app/leo/notes/`, { headers: { authorization: `Bearer ${leo}` } })).status, 200);
});
