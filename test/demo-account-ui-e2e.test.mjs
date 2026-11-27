// The demo's account controls in a REAL browser (R6) · 演示账户控件的真实浏览器测试
// The real web.mjs in demo mode (stub Supabase, test/helpers-demo-sb.mjs) and the real shell in
// Chromium. Signed out: ONE "Sign in" in the header and no floating box; signed in: no floating
// buttons, the ⚙ dialog's own Sign out ends the node visit AND revokes the Supabase session, and
// "Delete my account" sits under it, asks first, deletes, then signs out the same way.
// Without Playwright the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';
import { SIGNIN_LABELS } from '../lib/demo-boot.mjs';
import { DEMO_DELETE_PATH } from '../lib/demo.mjs';
import { zh } from './helpers-lang.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let sb, web, root, port, browser;

before(async () => {
  if (skip) return;
  sb = await startStubSupabase();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: { enabled: true, title: 'superelf', new_users_per_ip_per_day: 50, auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (sb) sb.srv.close(); if (root) rmTemp(root); });

// The boot reloads the page once when it first gets a node session: wait for that reloaded page.
async function settled(page) {
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && performance.getEntriesByType('navigation')[0].type === 'reload')
    .catch(() => false /* mid-navigation: ask again */), 'the boot reload');
}
// A page whose browser already holds a Supabase session for `sub` (as after the magic link).
async function signedIn(sub) {
  const ctx = await browser.newContext();
  const a = sb.jwt({ sub });
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sb_session', s); } },
    JSON.stringify({ a, r: 'refresh', e: Math.floor(Date.now() / 1000) + 3600 }));
  const page = await ctx.newPage();
  const node = [];
  page.on('request', (r) => { if (r.url().includes('/api/logout') || r.url().includes(DEMO_DELETE_PATH)) node.push(r.url()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  await page.waitForSelector('#demoDel', { state: 'attached' });
  return { ctx, page, a, node };
}
const noFloatingBox = (page) => page.evaluate(() => [...document.querySelectorAll('body *')]
  .filter((e) => getComputedStyle(e).position === 'fixed' && e.offsetParent !== null && /Sign out|Delete my account|Sign in/.test(e.textContent)).length);

test('signed out: one Sign in in the header (like its buttons), an email popover, no Sign out', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  const b = page.locator('header #demoSignin');
  await b.waitFor();
  assert.equal(await b.textContent(), zh(SIGNIN_LABELS.in));
  assert.match(await b.getAttribute('class'), /^ibtn h-signin$/, 'a header button (the Sign in pill), not a box');
  assert.equal(await page.locator('#logoutBtn').isVisible(), false);
  assert.equal(await page.locator('text=Delete my account').count(), 0);
  await b.click();
  await page.locator('#demoAuth.cmenu-pop input[type=email]').waitFor({ state: 'visible' });   // the shell popover style
  await page.mouse.click(5, 400);
  await page.locator('#demoAuth').waitFor({ state: 'detached' });   // a tap outside closes it
  await ctx.close();
});

test('signed in: no floating buttons; the Settings Sign out ends the visit and revokes Supabase', { skip }, async () => {
  const { ctx, page, a, node } = await signedIn('ui-out');
  assert.equal(await noFloatingBox(page), 0, 'no floating account box');
  assert.equal(await page.locator('#demoSignin').count(), 0);
  await page.click('#hmore'); await page.click('#settings');
  await page.locator('#demoDel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pPin').isVisible(), false, 'no PIN change on the demo');
  const before = sb.calls.length;
  await Promise.all([page.waitForEvent('load'), page.click('#logoutBtn')]);
  await waitFor(() => sb.calls.slice(before).some((c) => c.url === '/auth/v1/logout' && c.auth === `Bearer ${a}`), 'Supabase revoke');
  assert.ok(node.some((u) => u.endsWith('/api/logout')), 'the node visit ended');
  await page.locator('header #demoSignin').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sb_session')), null);
  await ctx.close();
});

test('Delete my account in Settings asks first, deletes, then signs out fully', { skip }, async () => {
  const { ctx, page, a, node } = await signedIn('ui-del');
  await page.click('#hmore'); await page.click('#settings');
  await page.locator('#demoDel').waitFor({ state: 'visible' });
  page.once('dialog', (d) => d.dismiss());
  await page.click('#demoDel');
  assert.equal(node.length, 0, 'cancel deletes nothing');
  page.once('dialog', (d) => { assert.equal(d.message(), zh(SIGNIN_LABELS.delAsk)); d.accept(); });
  await Promise.all([page.waitForEvent('load'), page.click('#demoDel')]);
  assert.ok(node[0].endsWith(DEMO_DELETE_PATH) && node.some((u) => u.endsWith('/api/logout')), node.join());
  await waitFor(() => sb.calls.some((c) => c.url === '/auth/v1/logout' && c.auth === `Bearer ${a}`), 'Supabase revoke');
  await page.locator('header #demoSignin').waitFor();
  await ctx.close();
});

test('the header is menu, title, controls: "superelf", no status or new-feature dot; a set name reads "<name>\'s superelf"', { skip }, async () => {
  const { ctx, page } = await signedIn('ui-title');
  await page.waitForFunction(() => document.querySelector('h1').textContent === 'superelf');
  assert.equal(await page.locator('#dot').isVisible(), false);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.pa-new')].filter((e) => getComputedStyle(e, '::after').display !== 'none').length), 0);
  const t = await page.evaluate(() => localStorage.getItem('pa_session'));
  const put = await page.evaluate(async (tok) => (await fetch('/api/profile', { method: 'PUT', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sam' }) })).status, t);
  assert.equal(put, 200);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('h1').textContent === 'Sam’s superelf');
  await ctx.close();
});

test('signed out, an AI request says "sign in to use AI" (not "登录已过期 · signed out") and opens the sign-in', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  await page.fill('#box', 'hello');
  await page.click('#send');
  const err = page.locator('.msg.err');
  await err.waitFor();
  assert.match(await err.textContent(), /Sign in to use AI/);
  assert.doesNotMatch(await err.textContent(), /登录已过期/);
  await page.locator('#demoAuth.cmenu-pop input[type=email]').waitFor({ state: 'visible' });
  await ctx.close();
});

test('the build pill sits below the header at phone width, also once the header grows (A+)', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } }); const page = await ctx.newPage();
  await page.route('**/api/demo/build', (r) => r.fulfill({ json: { ok: true, job: { id: 'j1', status: 'building', title: 'Pollen Diary Tracker' } } }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  await page.locator('#demoBuild').waitFor();
  const gap = () => page.evaluate(() => document.getElementById('demoBuild').getBoundingClientRect().top - document.querySelector('header').getBoundingClientRect().bottom);
  assert.ok(await gap() >= 0, `pill below the header (gap ${await gap()})`);
  const grow = await page.evaluate(() => { const h = document.querySelector('header'), b0 = h.getBoundingClientRect().bottom; h.style.paddingBottom = '40px'; return h.getBoundingClientRect().bottom - b0; });
  assert.ok(grow > 20, 'CONTROL: the header really grew past the old fixed 60px');
  await waitFor(async () => (await gap()) >= 0, 'the pill follows the header');
  for (const id of ['tip:main-chat-camera', 'tip:home-more']) {   // one tip at a time: the camera's priority tip, then the home one, then ours
    if (await page.waitForSelector(`.pat-tip[data-tip="${id}"]`, { timeout: 5000 }).then(() => true, () => false)) { await page.keyboard.press('Escape'); await page.evaluate(() => window.PATips.whenIdle()); }
  }
  await page.waitForSelector('.pat-tip[data-tip="tip:demo-build"]', { timeout: 5000 });   // the ONE tip mechanism: the next tip follows a dismissal in the shell
  const tip = await page.evaluate(() => document.querySelector('.pat-tip').getBoundingClientRect().top - document.getElementById('demoBuild').getBoundingClientRect().bottom);
  assert.ok(tip >= 0, 'the tip sits under the pill');
  await page.locator('.pat-tip .pat-x').click();   // dismissed: the app tip now raises the input bar, so the grid scrolls the card under it
  await page.getByText('花粉', { exact: true }).last().click();   // an open app: its bar (← Home, A-, A+) is a header too
  await waitFor(async () => page.evaluate(() => document.getElementById('demoBuild').getBoundingClientRect().top >= document.querySelector('#frame .bar').getBoundingClientRect().bottom), 'the pill below the app bar');
  await page.evaluate(() => { document.querySelector('header').style.paddingBottom = ''; });   // header back to size: only the slide can move the pill now
  await page.waitForTimeout(4500);   // past one poll. An invariant pin: the shell header (behind the app) is as tall as the bar, so this holds even without transitionend
  await page.evaluate(() => { const f = document.getElementById('frame'); f.classList.add('peek', 'barin'); });   // the peek bar slides in (a transform, no resize)
  await page.waitForTimeout(400);   // the .18s slide, well inside the 4s poll: placed by the slide itself, not by a later poll
  assert.ok(await page.evaluate(() => document.getElementById('demoBuild').getBoundingClientRect().top >= document.querySelector('#frame .bar').getBoundingClientRect().bottom), 'the pill below the slid-in bar');
  await ctx.close();
});

test('the drawer has no Briefings section on the demo, and asks /api/briefings nothing', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } }); const page = await ctx.newPage();
  const asked = []; page.on('request', (r) => { if (r.url().includes('/api/briefings')) asked.push(r.url()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  assert.equal(await page.locator('#secBriefs').count(), 1, 'CONTROL: the section exists in the shell');
  await page.evaluate(() => openDrawer());
  await page.locator('#drawer.open').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#secBriefs').isVisible(), false);
  assert.equal(await page.locator('text=Could not load briefings').count(), 0);
  assert.deepEqual(asked, []);
  await ctx.close();
});

test('the demo drawer keeps Family Apps with the private-hosting note, muted, and asks /api/family-apps nothing', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  const asked = []; page.on('request', (r) => { if (r.url().includes('/api/family-apps')) asked.push(r.url()); });
  // Read at DOMContentLoaded INSIDE each document: the boot reloads the page once, and a count from
  // the test process could land in the gap where the reloaded document has not parsed yet (the flake).
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { window.__noteAtParse = !!document.getElementById('dFamilyDemo'); }));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await settled(page);
  assert.equal(await page.evaluate(() => window.__noteAtParse), true, 'the note is there at parse time, before any boot fetch (GPT r2)');
  await page.evaluate(() => openDrawer());
  await page.locator('#drawer.open').waitFor();
  await page.click('#secFamily .dsec-head');   // closed by default since the drawer redesign (web/drawer-sections.js)
  const note = page.locator('#secFamily #dFamilyDemo');
  await note.waitFor({ state: 'visible' });
  assert.equal(await note.textContent(), '家庭应用仅在私有部署的 superelf 上可用');
  assert.equal(await page.locator('#secFamily >> text=None shared yet.').count(), 0);
  const [c, m] = await note.evaluate((e) => [getComputedStyle(e).color, (() => { const p = document.createElement('span'); p.style.color = 'var(--muted)'; document.body.appendChild(p); const v = getComputedStyle(p).color; p.remove(); return v; })()]);
  assert.equal(c, m, 'muted, not an error colour');
  if (process.env.PA_SHOT_DIR) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(process.env.PA_SHOT_DIR, 'demo-390-family-drawer.png') }); }   // after the drawer's slide
  assert.deepEqual(asked, []);
  await ctx.close();
});

test('the scroll-to-bottom button sits above the taller demo input bar, never on the input', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await settled(page);
  await page.locator('#emptyState').waitFor();
  await page.evaluate(() => hideEmptyState());   // the home holds the input row; measure the bar as a chat shows it
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--pill-clear') === (document.getElementById('f').offsetHeight + 12) + 'px');   // the bar's ResizeObserver ran
  const [btnBottom, formTop] = await page.evaluate(() => { const b = document.getElementById('scrollBtn'); b.style.display = 'flex';
    return [b.getBoundingClientRect().bottom, document.getElementById('f').getBoundingClientRect().top]; });
  assert.ok(btnBottom <= formTop, `button bottom ${btnBottom} above the bar top ${formTop}`);
  await ctx.close();
});
