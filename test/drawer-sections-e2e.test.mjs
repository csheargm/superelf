// The ☰ drawer's sections (R6, real browser) · 侧栏分组. Owner 2026-11-24: the headers did not stand out
// from the rows, everything opened at once, and "主页 · Home" wrapped beside a big "新建 · New" pill.
// Now: first open = every section closed but 对话记录, which shows today's/yesterday's chats only with
// 更多 · More; a tap is remembered ON THE ACCOUNT (survives a reload AND a fresh device); headers are
// buttons with aria-expanded, Enter/Space toggle; the header row stays one line at 390 and 1180.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const DAY = 864e5;
const DEFAULTS = { secApps: false, secFamily: false, secBriefs: false, secChats: true };   // = PADrawerSections.DEFAULT_OPEN spelled out
let port, root, web, browser;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port });
  // 3 chats from today, 1 from yesterday-ish (within the closed-up window) and 6 older ones.
  const dir = path.join(root, 'workspace', 'conversations'); fs.mkdirSync(dir, { recursive: true });
  const now = Date.now(), y = new Date(); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
  const at = [now - 1000, now - 2000, now - 3000, y.getTime(), ...[3, 4, 5, 6, 7, 8].map((d) => now - d * DAY)];
  at.forEach((t, i) => fs.writeFileSync(path.join(dir, `chat${String(i).padStart(4, '0')}.json`), JSON.stringify({ id: `chat${String(i).padStart(4, '0')}`, title: 'chat ' + i, updated: t, messages: [] })));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function session() { return (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).json()).token; }
async function openDrawerIn(width, height, opts = {}) {
  const sess = await session();
  const c = await browser.newContext({ viewport: { width, height }, ...opts });
  await c.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, sess);
  const page = await c.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#hStart .st');
  await page.click('#hmore'); await page.click('#menu');
  await page.waitForFunction(() => document.querySelectorAll('#convos .convo').length > 0 && document.querySelector('#secChats .dsec-n').textContent);
  return { c, page };
}
const states = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#drawer .dsec')].map((s) => [s.id,
  { open: s.classList.contains('open'), aria: s.querySelector('.dsec-head').getAttribute('aria-expanded'), shown: getComputedStyle(s.querySelector('.dsec-body')).display !== 'none' }])));

test('first open: all closed but Chats; Chats shows only today/yesterday + More; counts on the headers', { skip, timeout: 60000 }, async () => {
  const { c, page } = await openDrawerIn(390, 844);
  const st = await states(page);
  for (const id of ['secApps', 'secFamily', 'secBriefs']) assert.deepEqual(st[id], { open: false, aria: 'false', shown: false }, id);
  assert.deepEqual(st.secChats, { open: true, aria: 'true', shown: true });
  // The page's own clock decides "yesterday" (a run across midnight sees 3, not 4): ask it, then pin the range.
  const want = await page.evaluate(() => PAHomeLook.recentCount(allConvos, new Date()));
  assert.ok(want === 4 || want === 3, `today + yesterday: ${want}`);
  assert.equal(await page.locator('#convos .convo').count(), want, 'only the recent chats, not all 10');
  assert.match(await page.textContent('#convos .more-chats'), new RegExp(`^更多（${10 - want}）$`));
  assert.equal(await page.textContent('#secChats .dsec-n'), '10', 'the pill counts every chat');
  assert.match(await page.textContent('#secApps .dsec-head'), /我的应用\s*My Apps/, '中文 first');
  assert.equal(await page.$eval('#secApps .dsec-head b', (e) => getComputedStyle(e).fontWeight), '800', 'the label is bold');
  assert.ok(await page.$('#secApps .dsec-ic svg') && await page.$('#secApps .dsec-chev svg'), 'line icon + chevron');
  await c.close();
});

test('a tap is remembered on the account: reload AND a fresh device open the same way', { skip, timeout: 60000 }, async () => {
  const { c, page } = await openDrawerIn(1180, 820);
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/profile') && r.request().method() === 'PUT');
  await page.click('#secApps .dsec-head');
  assert.equal((await saved).ok(), true);
  const saved2 = page.waitForResponse((r) => r.url().endsWith('/api/profile') && r.request().method() === 'PUT');
  await page.click('#secChats .dsec-head'); await saved2;
  await page.reload(); await page.waitForSelector('#hStart .st'); await page.click('#hmore'); await page.click('#menu');
  await page.waitForFunction(() => document.querySelector('#secApps').classList.contains('open'));
  let st = await states(page);
  assert.equal(st.secApps.aria, 'true'); assert.equal(st.secChats.open, false, 'Chats closed stays closed');
  await c.close();
  // A NEW context = none of the first one's localStorage: only the account can carry it.
  const sess = await session(); const c2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c2.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, sess);
  const p2 = await c2.newPage(); await p2.goto(`http://127.0.0.1:${port}/`); await p2.waitForSelector('#hStart .st');
  await p2.waitForFunction(() => document.querySelector('#secApps').classList.contains('open'));
  st = await states(p2); assert.equal(st.secChats.open, false, 'the other device: Chats closed too'); await c2.close();
  // Put the defaults back for the other tests (only taps are stored).
  await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await session() }, body: JSON.stringify({ drawerOpen: DEFAULTS }) });
});

test('keyboard: headers are buttons; Enter and Space toggle and aria-expanded follows', { skip, timeout: 60000 }, async () => {
  const { c, page } = await openDrawerIn(1180, 820);
  assert.equal(await page.$eval('#secBriefs .dsec-head', (e) => e.tagName), 'BUTTON');
  assert.equal(await page.$eval('#secBriefs .dsec-head', (e) => document.getElementById(e.getAttribute('aria-controls')) === e.nextElementSibling), true);
  await page.focus('#secBriefs .dsec-head'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#secBriefs .dsec-head').getAttribute('aria-expanded') === 'true');
  await page.keyboard.press(' ');
  await page.waitForFunction(() => document.querySelector('#secBriefs .dsec-head').getAttribute('aria-expanded') === 'false');
  await page.waitForTimeout(300);   // the last save lands before the reset
  await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await session() }, body: JSON.stringify({ drawerOpen: DEFAULTS }) });
  await c.close();
});

for (const [w, h, scheme] of [[390, 844, 'light'], [1180, 820, 'light'], [390, 844, 'dark']]) {
  test(`header one line at ${w} (${scheme}): 主页 · Home whole, 新对话 a light secondary button`, { skip, timeout: 60000 }, async () => {
    const { c, page } = await openDrawerIn(w, h, { colorScheme: scheme });
    const m = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
      const home = document.querySelector('#goHome'), nc = document.querySelector('#newChat');
      return { homeH: r('#goHome').height, cut: home.scrollWidth > home.clientWidth, top: [r('#goHome').top, r('#drawerSearch').top, r('#newChat').top].map((t) => Math.round(t)),
        ncBg: getComputedStyle(nc).backgroundColor, ncText: nc.textContent, ncLabel: nc.getAttribute('aria-label'), ncH: r('#newChat').height }; });
    assert.equal(m.cut, false, `主页`);
    assert.ok(m.homeH < 50, `one line: ${m.homeH}`);
    assert.ok(Math.max(...m.top) - Math.min(...m.top) < 8, `one row: ${m.top}`);
    assert.match(m.ncText, /新对话/); assert.equal(m.ncLabel, '新对话');
    assert.match(m.ncBg, /rgba\(0, 0, 0, 0\)|transparent/, 'not a filled pill');
    assert.ok(m.ncH < 44, `${m.ncH}`);
    if (process.env.PA_SHOT_DIR) await page.waitForTimeout(600), await page.screenshot({ path: path.join(process.env.PA_SHOT_DIR, `after-${w}-${scheme}.png`) });
    await c.close();
  });
}

test('profile route keeps only known section ids with boolean values (lib/webutil.mjs drawerOpenOf)', async () => {
  const { drawerOpenOf } = await import('../lib/webutil.mjs');
  assert.deepEqual(drawerOpenOf({ secApps: true, secChats: false, evil: true, secBriefs: 'yes' }), { secApps: true, secChats: false });
  for (const bad of [null, [], 'x', 3, undefined]) assert.deepEqual(drawerOpenOf(bad), {});
});

test('the route MERGES taps: two devices tapping different sections both stick', { timeout: 30000 }, async () => {
  const put = async (d) => (await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await session() }, body: JSON.stringify({ drawerOpen: d }) })).status;
  assert.equal(await put({ secBriefs: true }), 200); assert.equal(await put({ secFamily: true }), 200);
  const got = await (await fetch(`http://127.0.0.1:${port}/api/profile`, { headers: { authorization: 'Bearer ' + await session() } })).json();
  assert.equal(got.drawerOpen.secBriefs, true); assert.equal(got.drawerOpen.secFamily, true);
  await put(DEFAULTS);
});

test('everything open on a short screen: the sections scroll together, Chats and its More stay reachable', { skip, timeout: 60000 }, async () => {
  const { c, page } = await openDrawerIn(390, 420);
  for (const id of ['secApps', 'secFamily', 'secBriefs']) await page.click(`#${id} .dsec-head`);
  await page.click('#convos .more-chats');   // all 10 chats now: taller than the screen
  const m = await page.evaluate(() => { const d = document.querySelector('.dscroll'); return { over: d.scrollHeight > d.clientHeight, bodyH: document.querySelector('#secChats .dsec-body').getBoundingClientRect().height }; });
  assert.equal(m.over, true, 'it overflows, so it must scroll');
  assert.ok(m.bodyH > 300, `the chats list is not squeezed: ${m.bodyH}`);
  await page.locator('#convos .convo').last().scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#convos .convo').last().isVisible(), true);
  await page.click('#convos .convo >> nth=9', { trial: true });   // reachable to a tap
  await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await session() }, body: JSON.stringify({ drawerOpen: DEFAULTS }) });
  await c.close();
});
