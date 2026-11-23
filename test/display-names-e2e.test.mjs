// Names, not ids or slugs · 显示名字而非内部 id (F5-9).
// Overnight 2026-11-23: the owner chose the username "mom", but lists said "owner" (the account's
// internal id), and the shelf's Promote list showed app slugs. Now every list shows the chosen name
// and app titles. Unit + HTTP (R6 through the real server) + a real browser for the Promote list.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword, } from '../lib/auth.mjs';
import { displayName, NO_NAME } from '../lib/users.mjs';

test('displayName: profile name, else record name, else username — never the bare internal id', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dn-'));
  try {
    assert.equal(displayName({ id: 'owner', username: 'mom', name: 'owner', workspace: ws }), 'mom', 'the id-as-name is skipped for the chosen username');
    assert.equal(displayName({ id: 'owner', username: 'mom', name: 'Mother', workspace: ws }), 'Mother');
    fs.writeFileSync(path.join(ws, 'profile.json'), JSON.stringify({ name: 'Mama' }));
    assert.equal(displayName({ id: 'owner', username: 'mom', name: 'owner', workspace: ws }), 'Mama');
    assert.equal(displayName(null), NO_NAME);
    assert.equal(displayName({ id: 'kid', name: 'kid', workspace: path.join(ws, 'none') }), 'kid', 'CONTROL: a member whose username IS the id keeps it');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

let port, root, web, browser, session;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', username: 'mom', name: 'owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const app = path.join(root, 'workspace', 'apps', 'chore-chart'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>c</title><p>c');
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Chore Chart', shared: true }));
  web = startWeb(root); await waitReady(port);
  session = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mom', password: 'owner-pass-123' }) })).json()).token;
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });
const get = async (p, opt = {}) => (await fetch(`http://127.0.0.1:${port}${p}`, { ...opt, headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` } })).json();

test('server lists say "mom" and "Chore Chart", never "owner" or a slug', async () => {
  const cand = await get('/api/admin/share/candidates');
  assert.equal(cand[0].name, 'mom');
  assert.equal(cand[0].titles['chore-chart'], 'Chore Chart');
  assert.equal((await get('/api/family-apps'))[0].author, 'mom');
  assert.equal((await get('/api/admin/users'))[0].name, 'mom');
  const r = await get('/api/admin/share', { method: 'POST', body: JSON.stringify({ from: 'owner', slug: 'chore-chart' }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await get('/api/admin/shared'))[0].sharedBy, 'mom');
  assert.equal((await get('/api/apps')).find((a) => a.uid === 'shared').sharedBy, 'mom');
});

test('the Promote list in Settings shows "mom · Chore Chart"', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'mom'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  const opts = await page.evaluate(async () => { await loadShelf(); return [...document.querySelectorAll('#promoteSel option')].map((o) => o.textContent); });
  assert.ok(opts.includes('mom · Chore Chart'), JSON.stringify(opts));
  assert.ok(!opts.some((o) => /owner|chore-chart/.test(o)), JSON.stringify(opts));
  await ctx.close();
});
