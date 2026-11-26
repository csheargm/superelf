// Demo admin in a REAL browser (R6) · 演示管理页的真实浏览器测试 (ADR 0045)
// The real web.mjs in demo mode on a throwaway root (stub Supabase, stub Ollama), seeded through the
// real routes with a member who chats in an app and a network at the visit cap. The admin email
// opens ⋯ → 演示管理 · Demo admin, sees the member in People, the app in Apps, the trend bars, and
// taps 清零 · Reset on the blocked network; a member has no such menu row. With PA_E2E_ENGINE=webkit it
// runs as an iPhone (390x844, touch), else Chromium at 1280x800. Screenshots go to PA_SHOTS if set.
// Without Playwright the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium as engine } from './helpers-note-link.mjs';
import { startStubSupabase, listen } from './helpers-demo-sb.mjs';
import { AUTH_HEADER } from '../lib/demo-auth.mjs';
import { ADMIN_LABELS } from '../lib/demo-admin-ui.mjs';
import { SIGNIN_LABELS } from '../lib/demo-boot.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHONE = process.env.PA_E2E_ENGINE === 'webkit';
const VIEW = PHONE ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : { viewport: { width: 1280, height: 800 } };
const SHOTS = process.env.PA_SHOTS || '';
const ADMIN = 'owner@example.org', BLOCKED_IP = '203.0.113.77';
let sb, ollama, web, root, port, browser;

before(async () => {
  if (skip) return;
  sb = await startStubSupabase();
  ollama = await listen(http.createServer((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'ANSWER' }, done: true }) + '\n'); }); }));
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], ollama_url: `http://127.0.0.1:${ollama.address().port}`,
    chat_models: [{ id: 'fast', label: 'Fast', provider: 'ollama', model: 'fake' }],
    demo: { enabled: true, title: 'superelf', behind_cloudflare: true, new_users_per_ip_per_day: 50, sessions_per_ip_per_day: 4, admin_emails: [ADMIN],
      auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  // Seed through the real routes: a member who chats in the notes app and opens it, and a capped network.
  const call = (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: { 'content-type': 'application/json', 'cf-connecting-ip': o.ip || '198.51.100.5', ...(o.headers || {}) } });
  const m = await (await call('/api/demo/start', { method: 'POST', headers: { [AUTH_HEADER]: sb.jwt({ sub: 'seed-member', email: 'ruth@example.org', user_metadata: { full_name: 'Ruth Seed' } }) } })).json();
  await (await call('/api/chat', { method: 'POST', headers: { authorization: `Bearer ${m.token}` }, body: JSON.stringify({ message: 'hello', app: 'notes' }) })).text();
  await (await call(`/app/${m.uid}/notes/`)).text();
  for (let i = 0; i < 4; i++) await call('/api/demo/start', { method: 'POST', ip: BLOCKED_IP });
  browser = await engine.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (sb) sb.srv.close(); if (ollama) ollama.close(); if (root) rmTemp(root); });

async function settled(page) {
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && performance.getEntriesByType('navigation')[0].type === 'reload')
    .catch(() => false /* mid-navigation: ask again */), 'the boot reload');
}
async function signedIn(sub, email) {
  const ctx = await browser.newContext(VIEW);
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sb_session', s); } },
    JSON.stringify({ a: sb.jwt({ sub, email, amr: [{ method: 'otp', timestamp: 1 }] }), r: 'refresh', e: Math.floor(Date.now() / 1000) + 3600 }));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  await page.waitForSelector('#hmore');
  return { ctx, page };
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${PHONE ? 'iphone' : 'desktop'}-${name}.png`) }) : null);
const tap = (page, sel) => (PHONE ? page.tap(sel) : page.click(sel));

test('the admin opens ⋯ → Demo admin: people, apps, trend; Reset frees the blocked network', { skip, timeout: 90000 }, async () => {
  const { ctx, page } = await signedIn('owner-sub', ADMIN);
  await page.waitForSelector('#demoAdminItem', { state: 'attached' });
  const moreTip = page.locator('.pat-tip:is([data-tip="tip:home-more"],[data-tip="tip:main-chat-camera"]) .pat-x');   // the shell's own tips (camera, ⋯) come first on a fresh browser
  for (let i = 0; i < 4; i++) {   // a fresh browser shows the shell's own camera and ⋯ tips first; once it is closed, ours shows beside the row
    if (!(await page.locator('#demoAdminItem').isVisible())) await tap(page, '#hmore');
    await page.locator('#demoAdminItem').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);   // two frames + the tips' profile read
    if (!(await moreTip.isVisible())) break;
    await moreTip.click();
  }
  assert.equal((await page.locator('#demoAdminItem').textContent()).trim(), ADMIN_LABELS.item);
  await page.locator('.pat-tip[data-tip="tip:demo-admin"]').waitFor({ state: 'visible', timeout: 5000 })
    .catch(async () => { throw new Error('the first-use tip beside the menu row did not show: ' + await page.evaluate(() => [...document.querySelectorAll('.pat-tip')].map((t) => t.dataset.tip + ':' + t.textContent).join(' / ') + ' tipsShell=' + !!window.PATipsShell)); });
  await shot(page, 'menu-tip');
  await tap(page, '#demoAdminItem');
  await page.locator('#demoAdm .da-c').first().waitFor();
  const blocked = page.locator('#demoAdm .da-c.bad');
  assert.equal(await blocked.count(), 1, 'one network at the cap');
  await shot(page, 'today');
  await tap(page, '#demoAdm .da-c.bad button');
  await page.waitForFunction(() => !document.querySelector('#demoAdm .da-c.bad'));
  await tap(page, '#demoAdm .da-t button:nth-child(2)');
  await page.locator('#demoAdm .da-c', { hasText: 'ruth@example.org' }).waitFor();
  assert.match(await page.locator('#demoAdm .da-c', { hasText: 'ruth@example.org' }).textContent(), /Ruth Seed/);
  await shot(page, 'people');
  await tap(page, '#demoAdm .da-t button:nth-child(3)');
  await page.locator('#demoAdm .da-c', { hasText: 'notes' }).first().waitFor();
  await shot(page, 'apps');
  await tap(page, '#demoAdm .da-t button:nth-child(5)');
  await page.locator('#demoAdm svg rect').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('#demoAdm svg').count(), 4);
  await shot(page, 'trend');
  const overflow = await page.evaluate(() => { const d = document.getElementById('demoAdm'); return d.scrollWidth - d.clientWidth; });
  assert.ok(overflow <= 1, `no sideways scroll in the page (${overflow}px)`);
  assert.equal(await fetch(`http://127.0.0.1:${port}/api/demo/start`, { method: 'POST', headers: { 'cf-connecting-ip': BLOCKED_IP } }).then((r) => r.status), 200, 'the network may visit again');
  await ctx.close();
});

test('a member (not in admin_emails) gets no Demo admin row, and the sign-in popover says what is recorded', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await signedIn('plain-member', 'someone@example.org');
  await tap(page, '#hmore');
  await page.locator('#reload').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);   // the admin check has answered by now (404)
  assert.equal(await page.locator('#demoAdminItem').count(), 0);
  await ctx.close();
  const anon = await browser.newContext(VIEW); const p2 = await anon.newPage();
  await p2.goto(`http://127.0.0.1:${port}/`); await settled(p2);
  await tap(p2, 'header #demoSignin');
  assert.equal((await p2.locator('#demoAuthPriv').textContent()), SIGNIN_LABELS.privacy);
  await shot(p2, 'signin-privacy');
  await anon.close();
});
