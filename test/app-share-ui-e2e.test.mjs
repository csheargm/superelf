// 分享 · Share by link in a REAL browser (R6, docs/adr/0047): an owner node and a demo node (real
// web.mjs each, stub Supabase). The owner opens an app → ⋯ → 分享 · Share (the one-time tip beside it)
// → the link + 复制 · Copy. A stranger opens the link page, taps Sign in and get it, lands signed out
// (the sign-in popover opens), signs in, and the shell opens THEIR OWN copy. A demo user shares (Copy
// only, said plainly); a privacy hit is refused in plain words; the admin takes a link down in the
// Shares tab. PA_E2E_ENGINE=webkit runs it as an iPhone (390x844, touch), else Chromium at 1280x800.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium as engine } from './helpers-note-link.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';
import { SHARE_PAGE_LABELS } from '../lib/app-share-routes.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHONE = process.env.PA_E2E_ENGINE === 'webkit';
const VIEW = PHONE ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : { viewport: { width: 1280, height: 800 } };
const SHOTS = process.env.PA_SHOTS || '';
const SECRET = 'c'.repeat(64), ADMIN = 'owner@example.org';
let sb, demo, owner, dRoot, oRoot, dPort, oPort, browser, link;

before(async () => {
  if (skip) return;
  sb = await startStubSupabase();
  dPort = await freePort(); oPort = await freePort();
  const shares = { demo_url: `http://127.0.0.1:${dPort}` };
  dRoot = mkWebRoot({ port: dPort, extraConfig: { users: [], share_ingest_secret: SECRET, shares,
    demo: { enabled: true, behind_cloudflare: true, new_users_per_ip_per_day: 50, sessions_per_ip_per_day: 50, admin_emails: [ADMIN],
      auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(dRoot, 'workspace.example'), { recursive: true });
  oRoot = mkWebRoot({ port: oPort, extraConfig: { share_ingest_secret: SECRET, shares } });
  fs.writeFileSync(path.join(oRoot, 'privacy-terms.txt'), 'Zebulonia\n');
  fs.writeFileSync(path.join(oRoot, 'workspace', 'identity-denylist.txt'), 'Quixotely\n');
  const app = path.join(oRoot, 'workspace', 'apps', 'hello');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width"><h1 id="hi">HELLO-SHARED</h1>');
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Hello Card', desc: 'A tiny greeting app' }));
  demo = startWeb(dRoot); owner = startWeb(oRoot);
  await waitReady(dPort); await waitReady(oPort);
  browser = await engine.launch();
});
after(async () => { if (browser) await browser.close(); if (demo) await stopWeb(demo); if (owner) await stopWeb(owner); if (sb) sb.srv.close(); if (dRoot) rmTemp(dRoot); if (oRoot) rmTemp(oRoot); });

const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `share-${PHONE ? 'iphone' : 'desktop'}-${name}.png`) }) : null);
const tap = (page, sel) => (PHONE ? page.tap(sel) : page.click(sel));
const sbSession = (sub, email) => JSON.stringify({ a: sb.jwt({ sub, email, amr: [{ method: 'otp', timestamp: 1 }] }), r: 'refresh', e: Math.floor(Date.now() / 1000) + 3600 });
async function ready(page) { await waitFor(() => page.evaluate(() => typeof openApp === 'function' && typeof UID === 'string' && !!UID && !!localStorage.getItem('pa_session')).catch(() => false /* mid-navigation */), 'the session', { timeoutMs: 15000 }); }
async function openMore(page) {
  for (let i = 0; i < 3; i++) {
    const top = await page.evaluate(() => document.querySelector('#ftitle').getBoundingClientRect().top);
    if (top < 0) await page.click('#barpeek');
    try { await page.click('#fmore', { timeout: 4000 }); await page.waitForSelector('#shItem', { timeout: 2000 }); return; } catch { /* the bar slid away: show it again */ }
  }
  throw new Error('no ⋯ menu');
}
// The shell's own tips (home ⋯ and others) may sit over ours on a fresh browser: closed until ours shows.
async function shareTipThenTap(page) {
  await openMore(page);
  const mine = page.locator('.pat-tip[data-tip="tip:share"]');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(700);   // two frames + the tips' profile read
    if (process.env.DBG) console.log('TIPS', i, await page.evaluate(() => JSON.stringify([[...document.querySelectorAll('.pat-tip')].map((t) => [t.dataset.tip, t.textContent.slice(0, 20)]), !!document.querySelector('#shItem'), document.querySelector('#frameMenu')?.innerText])));
    if (await mine.isVisible()) break;
    const other = page.locator('.pat-tip:not([data-tip="tip:share"])').first();   // the menu's other tips come first, one at a time
    if (await other.count()) { await page.keyboard.press('Escape'); await page.evaluate(() => PATips.whenIdle()); }   // as publish-e2e: one tip at a time, Escape closes it
    await page.waitForTimeout(300);
    if (!(await page.locator('#shItem').isVisible())) await openMore(page);
  }
  assert.ok(await page.locator('.pat-tip[data-tip="tip:share"]').isVisible(), 'the one-time tip beside Share');
  await shot(page, 'menu-tip');
  await page.locator('#shItem').click();
}

test('owner shares → a stranger opens the link, signs in and gets their own copy', { skip, timeout: 120000 }, async () => {
  const octx = await browser.newContext(VIEW);
  await octx.addInitScript((t) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('pa_session', t); } }, OWNER_TOKEN);
  const op = await octx.newPage();
  await op.goto(`http://127.0.0.1:${oPort}/`); await ready(op);
  await op.evaluate(() => openApp(UID, 'hello', 'Hello Card'));
  await op.frameLocator('#fr').locator('#hi').waitFor();
  await shareTipThenTap(op);
  await op.waitForSelector('#shUrl');
  link = await op.inputValue('#shUrl');
  assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${dPort}/s/[A-Za-z0-9_-]{22}$`));
  const ub = await op.locator('#shUrl').boundingBox();
  assert.ok(ub && ub.width >= 120, 'the link itself is visible beside Copy');
  assert.equal(await op.locator('#shTo').count(), 0, 'no AgentMail on this node: no email field');
  const box = await op.locator('#pubSheet').boundingBox(), vw = VIEW.viewport.width;
  assert.ok(box.x >= 0 && box.x + box.width <= vw, 'the sheet fits the screen');
  await shot(op, 'owner-link');
  await octx.close();

  const ctx = await browser.newContext(VIEW);
  const page = await ctx.newPage();
  if (process.env.DBG) { page.on('console', (m) => console.log('PAGE', m.text().slice(0, 200))); page.on('pageerror', (e) => console.log('PERR', e.message)); page.on('response', (r) => { if (r.status() >= 400) console.log('BAD', r.status(), r.url()); }); page.on('request', (r) => { if (/api\/(share|demo)/.test(r.url())) console.log('REQ', r.method(), r.url()); }); page.on('response', async (r) => { if (/api\/(share|demo)/.test(r.url())) console.log('RES', r.status(), r.url()); }); }
  await page.goto(link);
  assert.equal(await page.textContent('#shName'), 'Hello Card');
  assert.equal(await page.textContent('#shDesc'), 'A tiny greeting app');
  assert.equal((await page.textContent('#shGo')).trim(), SHARE_PAGE_LABELS.get);
  await shot(page, 'link-page');
  await tap(page, '#shGo');
  await page.waitForSelector('#demoAuth input[type=email]', { timeout: 15000 });   // signed out: the sign-in popover opens by itself
  await shot(page, 'signin');
  await page.evaluate((s) => localStorage.setItem('sb_session', s), sbSession('stranger', 'stranger@example.org'));   // the email link's result (stub Supabase)
  await page.reload();
  await waitFor(() => page.evaluate(() => document.querySelector('#ftitle') && document.querySelector('#ftitle').textContent === 'Hello Card' && getComputedStyle(document.querySelector('#frame')).display !== 'none').catch(() => false), 'their copy opens', { timeoutMs: 20000 });
  await page.frameLocator('#fr').locator('#hi').waitFor();
  const uid = await page.evaluate(() => UID);
  assert.ok(fs.existsSync(path.join(dRoot, `workspace-${uid}`, 'apps', 'hello', 'index.html')), 'their own copy, in their own workspace');
  await shot(page, 'own-copy');
  await ctx.close();
});

test('a demo user shares (Copy only, said plainly); a privacy hit is refused; the admin takes a link down', { skip, timeout: 120000 }, async () => {
  const ctx = await browser.newContext(VIEW);
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('sb_session', s); } }, sbSession('maker', ADMIN));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${dPort}/`); await ready(page);
  await page.evaluate(() => openApp(UID, 'tasks', 'Tasks'));
  await page.waitForSelector('#fr');
  await shareTipThenTap(page);
  await page.waitForSelector('#shUrl');
  assert.match(await page.textContent('#shDemoNote'), /演示版只能复制链接/);
  await shot(page, 'demo-link');
  const uid = await page.evaluate(() => UID);
  fs.writeFileSync(path.join(dRoot, `workspace-${uid}`, 'apps', 'notes', 'index.html'), '<p>call (415) 555-0134</p>');
  await page.evaluate(() => { document.querySelector('#pubSheet')?.remove(); PAShare.open('notes'); });
  await page.waitForSelector('#shFail');
  assert.match(await page.textContent('#shFail'), /个人信息/);
  assert.ok(!(await page.textContent('#pubSheet')).includes('555-0134'), 'never the matched text');
  await shot(page, 'refused');
  await page.evaluate(() => { document.querySelector('#pubSheet')?.remove(); goHome(); });
  await page.waitForSelector('#demoAdminItem', { state: 'attached' });
  for (let i = 0; ; i++) {   // under load the ⋯ menu may close again (a tip, a reload): open it and tap, a few times
    if (!(await page.locator('#demoAdminItem').isVisible())) { await page.click('#hmore'); await page.waitForTimeout(400); }
    const x = page.locator('.pat-tip .pat-x').first(); if (await x.isVisible()) { await x.click(); continue; }
    try { await page.locator('#demoAdminItem').click({ timeout: 3000 }); break; } catch (e) { if (i > 4) throw e; }
  }
  await page.locator('#demoAdm .da-t button', { hasText: '分享 · Shares' }).click();
  await page.waitForSelector('#demoAdm .da-down');
  await shot(page, 'admin-shares');
  page.once('dialog', (d) => d.accept());
  const n = await page.locator('#demoAdm .da-down').count();
  await page.locator('#demoAdm .da-down').first().click();
  await waitFor(async () => (await page.locator('#demoAdm .da-down').count()) === n - 1, 'one link down');
  await ctx.close();
});
