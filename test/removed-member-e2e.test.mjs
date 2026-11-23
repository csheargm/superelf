// A removed family member's sign-in screen · 被移除成员的登录页.
// Overnight 2026-11-23: a member the owner removed saw only a bare Sign in box. Now the server keeps a
// "removed" mark on that member's own sessions (lib/auth.mjs) until they expire, and the shell says
// "你的账号已被移除 · Your account was removed" — only to a browser holding one of those sessions, so it
// never tells anyone whether some other username exists. Real browser (R6); without Playwright the
// browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { Sessions, ACCOUNT_REMOVED_CODE, hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const SHELL = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const REMOVED_TEXT = '你的账号已被移除 · Your account was removed';

test('Sessions.removeUser: the sessions stop working but say "removed" until they expire; logout forgets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sess-'));
  try {
    const now = 1_000, s = new Sessions(path.join(dir, 's.json'), now);
    const a = s.create('mia', now), b = s.create('leo', now);
    s.removeUser('mia');
    assert.equal(s.resolve(a, now), null, 'a removed member is signed out');
    assert.equal(s.wasRemoved(a, now), true);
    assert.equal(s.wasRemoved(b, now), false, 'another member is untouched');
    assert.equal(s.resolve(b, now), 'leo');
    assert.equal(s.wasRemoved('never-issued', now), false, 'an unknown token says nothing');
    assert.equal(new Sessions(path.join(dir, 's.json'), now).wasRemoved(a, now), true, 'kept across a restart');
    assert.equal(s.wasRemoved(a, now + 31 * 24 * 3600 * 1000), false, 'gone once the session would have expired');
    const c = s.create('kit', now); s.removeUser('kit'); s.destroy(c);
    assert.equal(s.wasRemoved(c, now), false, 'sign-out forgets the mark');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R3: the shell\'s copy of the code matches lib/auth.mjs', () => {
  assert.ok(SHELL.includes(`ACCOUNT_REMOVED_CODE='${ACCOUNT_REMOVED_CODE}'`));
  assert.ok(SHELL.includes(`ACCOUNT_REMOVED_TEXT='${REMOVED_TEXT}'`));
});

let port, root, web, browser;
before(async () => {
  port = await freePort();   // the HTTP-only checks run in CI too; only the browser is Playwright-gated
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });   // set up: the shell shows Sign in, not first-run setup
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

let ownerSession = '';   // the owner has a password, so the API key cannot reach /api/admin: a real session
async function owner(p, opt = {}) {
  if (!ownerSession) ownerSession = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'owner-pass-123' }) })).json()).token;
  return fetch(`http://127.0.0.1:${port}${p}`, { ...opt, headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession}` } });
}

test('the server tells only the removed member\'s own session that it was removed', async () => {
  await owner('/api/admin/users', { method: 'POST', body: JSON.stringify({ id: 'nia', name: 'Nia', password: 'nia-first-pass-1' }) });
  const login = await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nia', password: 'nia-first-pass-1' }) })).json();
  assert.equal((await owner('/api/admin/users/nia', { method: 'DELETE' })).status, 200);
  const ping = (t) => fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { authorization: `Bearer ${t}` } });
  const r = await ping(login.token);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, ACCOUNT_REMOVED_CODE);
  const other = await ping('some-random-token-0123456789');
  assert.equal(other.status, 401);
  assert.equal((await other.json()).code, undefined, 'a token never issued learns nothing');
  const bad = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nia', password: 'nia-first-pass-1' }) });
  assert.equal((await bad.json()).code, undefined, 'the login route still answers the same for a removed and an unknown name');
});

test('a removed member reloads and sees "你的账号已被移除 · Your account was removed"; a stranger does not', { skip, timeout: 60000 }, async () => {
  await owner('/api/admin/users', { method: 'POST', body: JSON.stringify({ id: 'mia', name: 'Mia', password: 'mia-first-pass-1' }) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'mia'); await page.fill('#lpin', 'mia-first-pass-1'); await page.click('#loginBtn');
  await page.waitForFunction(() => document.querySelector('#dot.ok'));
  assert.equal((await owner('/api/admin/users/mia', { method: 'DELETE' })).status, 200);
  await page.reload();
  await page.waitForSelector('#login[open]');
  await page.waitForFunction((t) => document.querySelector('#loginErr').textContent === t, REMOVED_TEXT);
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('pa_session'), localStorage.getItem('pa_uid')]), [null, null], 'nothing left to reopen offline as the removed member');
  await ctx.setOffline(true); await page.reload().catch(() => { /* no worker page cached: the reload itself fails offline, which is also no way in */ });
  assert.equal(await page.evaluate(() => !!document.querySelector('#dot.ok')).catch(() => false), false, 'offline boot does not start the app as the removed member');
  await ctx.setOffline(false);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'removed-member.png') });
  await ctx.close();
  const fresh = await browser.newContext(); const p2 = await fresh.newPage();
  await p2.goto(`http://127.0.0.1:${port}/`);
  await p2.waitForSelector('#login[open]');
  await p2.waitForTimeout(500);
  assert.equal(await p2.locator('#loginErr').textContent(), '', 'a browser that never was Mia sees no message');
  await fresh.close();
});
