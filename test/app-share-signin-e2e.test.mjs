// 分享链接的登录 · Share link sign-in in a REAL browser (R6, docs/adr/0047; owner report 2026-11-26:
// two emails to sign in, and two identical share emails). Real owner + demo web.mjs, stub Supabase.
// - A visitor already signed in on this browser opens /s/<id> and goes straight to their own copy.
// - A signed-out visitor from a share email sees Continue with Google FIRST and their email PREFILLED
//   (from the sealed ?k= token, which leaves the address bar); nothing signs them in by itself.
// - An in-app browser (Gmail's) shows 在 Safari 中打开 · Open in Safari.
// - The owner double-taps Send (and presses Enter): one request, the button then says Sent.
// PA_E2E_ENGINE=webkit runs it as an iPhone (390x844, touch), else Chromium at 1280x800.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium as engine } from './helpers-note-link.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';
import { sealPrefill } from '../lib/app-share-mail.mjs';

const PHONE = process.env.PA_E2E_ENGINE === 'webkit';
const VIEW = PHONE ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : { viewport: { width: 1280, height: 800 } };
const SECRET = 'c'.repeat(64), TO = 'friend@example.com';
const GMAIL_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
let sb, demo, owner, dRoot, oRoot, dPort, oPort, browser, share;

before(async () => {
  if (skip) return;
  sb = await startStubSupabase();
  dPort = await freePort(); oPort = await freePort();
  const shares = { demo_url: `http://127.0.0.1:${dPort}` };
  dRoot = mkWebRoot({ port: dPort, extraConfig: { users: [], share_ingest_secret: SECRET, shares,
    demo: { enabled: true, behind_cloudflare: true, new_users_per_ip_per_day: 50, sessions_per_ip_per_day: 50,
      auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'workspace.example'), path.join(dRoot, 'workspace.example'), { recursive: true });
  oRoot = mkWebRoot({ port: oPort, extraConfig: { share_ingest_secret: SECRET, shares } });
  fs.writeFileSync(path.join(oRoot, 'privacy-terms.txt'), 'Zebulonia\n');
  fs.writeFileSync(path.join(oRoot, 'workspace', 'identity-denylist.txt'), 'Quixotely\n');
  const app = path.join(oRoot, 'workspace', 'apps', 'hello');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width"><h1 id="hi">HELLO-SHARED</h1>');
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Hello Card' }));
  demo = startWeb(dRoot); owner = startWeb(oRoot);
  await waitReady(dPort); await waitReady(oPort);
  const r = await fetch(`http://127.0.0.1:${oPort}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify({ slug: 'hello' }) });
  share = await r.json();
  assert.ok(share.ok, JSON.stringify(share));
  browser = await engine.launch();
});
after(async () => { if (browser) await browser.close(); if (demo) await stopWeb(demo); if (owner) await stopWeb(owner); if (sb) sb.srv.close(); if (dRoot) rmTemp(dRoot); if (oRoot) rmTemp(oRoot); });

const tap = (page, sel) => (PHONE ? page.tap(sel) : page.click(sel));
const sbSession = (sub, email) => JSON.stringify({ a: sb.jwt({ sub, email, amr: [{ method: 'otp', timestamp: 1 }] }), r: 'refresh', e: Math.floor(Date.now() / 1000) + 3600 });
const copyOpen = (page) => waitFor(() => page.evaluate(() => document.querySelector('#ftitle')?.textContent === 'Hello Card' && getComputedStyle(document.querySelector('#frame')).display !== 'none').catch(() => false /* mid-navigation */), 'their copy opens', { timeoutMs: 20000 });

test('signed in on this browser: the link goes straight to their copy, no sign-in asked', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext(VIEW);
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('sb_session', s); } }, sbSession('member1', 'member1@example.com'));
  const page = await ctx.newPage();
  let asked = false;
  await page.exposeFunction('__asked', () => { asked = true; });
  await page.addInitScript(() => addEventListener('pa-demo-signin', () => window.__asked && window.__asked()));
  await page.goto(share.url);
  await copyOpen(page);
  await page.frameLocator('#fr').locator('#hi').waitFor();
  assert.equal(await page.locator('#demoAuth').count(), 0, 'no sign-in popover');
  assert.equal(asked, false, 'sign-in was never asked for');
  assert.equal(new URL(page.url()).search, '', 'the ?share id was taken off');
  await ctx.close();
});

test('signed out, from a share email: Google first, the email prefilled, nothing signed in; the token leaves the address bar', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext(VIEW);
  const page = await ctx.newPage();
  await page.goto(`${share.url}?k=${sealPrefill(SECRET, TO)}`);
  await page.waitForSelector('#shGo');
  assert.equal(new URL(page.url()).search, '', 'the prefill token is taken off the address bar');
  assert.equal(await page.locator('#shInApp').isVisible(), false, 'a normal browser: no Safari hint');
  await tap(page, '#shGo');
  await page.waitForSelector('#demoAuth #demoGoogle', { timeout: 15000 });
  assert.equal(await page.inputValue('#demoAuthEmail'), TO, 'prefilled');
  if (PHONE) assert.ok(await page.evaluate(() => { const i = document.querySelector('#demoAuthEmail'); return i.scrollWidth <= i.clientWidth && parseFloat(getComputedStyle(i).fontSize) >= 16; }), 'phone: the whole address shows, 16px+ (no zoom)');
  assert.ok(await page.evaluate(() => !!(document.querySelector('#demoGoogle').compareDocumentPosition(document.querySelector('#demoAuthEmail')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'Google comes first');
  assert.equal(await page.evaluate(() => localStorage.getItem('sb_session')), null, 'the link signed no one in');
  const g = await page.locator('#demoGoogle').boundingBox();
  assert.ok(g.height >= 44 && g.x >= 0 && g.x + g.width <= VIEW.viewport.width, 'a full tap target on screen');
  let auth = null;
  await page.route(`${sb.url}/auth/v1/authorize**`, (r) => { auth = new URL(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>google</p>' }); });
  await tap(page, '#demoGoogle');
  await waitFor(() => !!auth, 'the Google redirect');
  assert.equal(auth.searchParams.get('provider'), 'google');
  assert.equal(auth.searchParams.get('code_challenge_method'), 's256');
  assert.match(auth.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(auth.searchParams.get('redirect_to'), `http://127.0.0.1:${dPort}/`);
  await ctx.close();
});

test('an in-app browser (Gmail) shows Open in Safari', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ ...VIEW, userAgent: GMAIL_UA });
  const page = await ctx.newPage();
  await page.goto(share.url);
  await page.waitForSelector('#shInApp', { state: 'visible' });
  assert.match(await page.textContent('#shInApp'), /在 Safari 中打开 · Open in Safari/);
  await ctx.close();
});

test('the owner double-taps Send and presses Enter: one email request, then Sent', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ ...VIEW, serviceWorkers: 'block' });   // page.route sees every request (a service worker may hide some from it in WebKit)
  await ctx.addInitScript((t) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('pa_session', t); } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.route((u) => u.pathname === '/api/share', async (r) => { const res = await r.fetch(); const j = await res.json(); return r.fulfill({ response: res, json: { ...j, mail: true } }); });   // this test node has no AgentMail: the email field is shown as with one
  const keys = [];
  await page.route((u) => u.pathname === '/api/share/email', async (r) => { keys.push(JSON.parse(r.request().postData()).key); await new Promise((x) => setTimeout(x, 600)); return r.fulfill({ json: { ok: true } }); });
  await page.goto(`http://127.0.0.1:${oPort}/`);
  await waitFor(() => page.evaluate(() => typeof PAShare === 'object' && typeof UID === 'string' && !!UID).catch(() => false), 'the shell');
  await page.evaluate(() => PAShare.open('hello'));
  await page.waitForSelector('#shTo');
  await page.fill('#shTo', TO);
  await page.fill('#shNote', 'See you Friday');
  await tap(page, '#shSend'); await tap(page, '#shSend').catch(() => {}); await page.press('#shTo', 'Enter');
  await waitFor(async () => (await page.textContent('#shSend')).includes('已发送'), 'Sent').catch(async (e) => { throw new Error(e.message + ' ' + JSON.stringify(keys) + ' ' + await page.textContent('#pubSheet')); });
  await page.waitForTimeout(800);
  assert.equal(keys.length, 1, 'one tap = one email');
  assert.equal(((await page.textContent('#pubSheet')).match(/已发送/g) || []).length, 1, 'Sent shows once (on the button)');
  assert.ok(await page.locator('#shSend').isDisabled(), 'Send stays off after it worked');
  await page.fill('#shTo', 'other@example.com');
  await tap(page, '#shSend');
  await waitFor(() => keys.length === 2, 'a new address sends again');
  assert.notEqual(keys[0], keys[1], 'with a new key');
  await ctx.close();
});
