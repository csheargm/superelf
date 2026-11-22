// The author's UNSHARED app still opens through the real shell and its sandboxed iframe (ADR 0037):
// the iframe navigation carries no Authorization header, only the Path=/app/ cookie that /api/ping set.
// CONTROL (R14): another member's shell, opening the same page in the same way, gets the 404.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const TOK_A = 'alice-token-0123456789abcdefghij', TOK_B = 'bob-token-0123456789abcdefghijkl';
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'alice', name: 'Alice', role: 'member', token: TOK_A, workspace: 'workspace-alice', status: 'active' },
    { id: 'bob', name: 'Bob', role: 'member', token: TOK_B, workspace: 'workspace-bob', status: 'active' },
  ] } });
  const d = path.join(root, 'workspace-alice', 'apps', 'diary'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>diary</title><p id="m">diary-body</p>');
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ title: 'Diary', shared: false }));
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function shellOpens(token) {
  const ctx = await browser.newContext();
  try {
    await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, token);
    const page = await ctx.newPage();
    const statuses = [];
    page.on('response', (r) => { if (r.url().includes('/app/alice/diary/')) statuses.push(r.status()); });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
    await page.evaluate(() => openApp('alice', 'diary', 'Diary'));
    for (let i = 0; i < 200 && !statuses.length; i++) await page.waitForTimeout(50);
    const frame = page.frames().find((f) => f.url().includes('/app/alice/diary/'));
    const body = frame ? await frame.evaluate(() => document.body ? document.body.innerText : '') : '';
    // the srcdoc route (web/sw-client.js fetchText) fetches the same page with credentials:'same-origin'
    const viaFetch = await page.evaluate(() => fetch('/app/alice/diary/', { credentials: 'same-origin' }).then((r) => r.status));
    return { statuses, body, viaFetch };
  } finally { await ctx.close(); }
}

test('the author opens her unshared app in the shell iframe; another member gets 404', { skip, timeout: 90000 }, async () => {
  const a = await shellOpens(TOK_A);
  assert.equal(a.statuses[0], 200, 'author: the iframe navigation is allowed');
  assert.match(a.body, /diary-body/);
  assert.equal(a.viaFetch, 200, 'author: the srcdoc-route fetch is allowed too');
  const b = await shellOpens(TOK_B);
  assert.equal(b.statuses[0], 404, 'other member: refused, as if missing');
  assert.doesNotMatch(b.body, /diary-body/);
  assert.equal(b.viaFetch, 404);
});
