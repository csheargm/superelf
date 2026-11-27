// Every tip can be closed · 提示都能关掉 (owner 2026-11-24: first-use tips stayed stuck, no way to close them).
// A real browser (R6), chromium AND webkit, iPhone 390x844 and iPad 820x1180: every tip that shows — the shell's
// (home ⋯) and the apps' (Notes, Bible; one per open, so each app is re-opened until none is left) — closes by its
// ✕, by Escape and by a tap outside it; stays closed after a reload and on a second device (the account copy);
// closes when localStorage is blocked and the account write is refused; and covers no control (bounding boxes).
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1. PA_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium, localed } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skipIf } from './helpers-skip.mjs';
import { engineFiltered } from './helpers-e2e-gate.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const PW = process.env.PA_PLAYWRIGHT ? await import(process.env.PA_PLAYWRIGHT).catch(() => null) : null;
const wkType = PW && (PW.webkit || (PW.default && PW.default.webkit));
const wkOff = engineFiltered(wkType);   // PA_E2E_ONLY=chromium: never launch WebKit (CI's Linux job has none)
const webkit = wkOff ? null : localed(wkType);
const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DEVICES = {
  iphone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA_IOS },
  ipad: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA_IOS.replace('iPhone; CPU iPhone OS', 'iPad; CPU OS') },
};
const HOME = '.pat-tip[data-tip="tip:home-more"]';
const TIP_WAIT_MS = 6000, OPENS_MAX = 8;
let port, root, web;
const browsers = {};
before(async () => {
  port = await freePort(); root = mkWebRoot({ port });
  fs.cpSync(path.join(ROOT, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  for (const slug of ['notes', 'bible']) fs.cpSync(path.join(ROOT, 'workspace.example', 'apps', slug), path.join(root, 'workspace', 'apps', slug), { recursive: true });
  web = startWeb(root); await waitReady(port);
  if (!skip) { browsers.chromium = await chromium.launch(); if (webkit) browsers.webkit = await webkit.launch(); }
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

const put = (body) => fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify(body) });
const CAM_TIP = 'tip:main-chat-camera';   // web/shell-cam.js: a priority tip, so on a first visit it shows ahead of the ⋯ tip under test here
const fresh = async () => { await put({ tipsSeen: [], appPrefs: {} }); await put({ tipsSeen: [CAM_TIP] }); };   // a first visit past the camera tip: only a literal [] clears (web.mjs unions), so clear, then add it
async function context(engine, dev, { blockLocal = false } = {}) {
  const ctx = await browsers[engine].newContext(DEVICES[dev]);
  await ctx.addInitScript(({ t, block }) => {
    try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ }
    if (block) { const S = Storage.prototype, g = S.getItem, s = S.setItem;   // the tips' device copies are blocked (private mode)
      S.getItem = function (k) { if (this === window.localStorage && /seen/.test(k)) throw new DOMException('blocked', 'SecurityError'); return g.call(this, k); };
      S.setItem = function (k, v) { if (this === window.localStorage && /seen/.test(k)) throw new DOMException('blocked', 'SecurityError'); return s.call(this, k, v); }; }
  }, { t: OWNER_TOKEN, block: blockLocal });
  return ctx;
}
async function shell(ctx) {
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  return { page, errors };
}
// In the given frame: the tip's box against every visible control outside it (its own anchor included).
const overlapsIn = (f) => f.evaluate(() => {
  const t = document.querySelector('.pat-tip'); if (!t) return null; const r = t.getBoundingClientRect(), out = [];
  for (const c of document.querySelectorAll('button,a[href],input,select,textarea,summary,[role=button]')) {
    if (t.contains(c) || c.closest('[inert],[hidden]')) continue; const s = getComputedStyle(c); if (s.visibility === 'hidden' || s.display === 'none') continue;
    const b = c.getBoundingClientRect(); if (!b.width || !b.height) continue;
    if (r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom) out.push(c.id || c.className || c.tagName); }
  const v = { w: innerWidth, h: innerHeight }; if (r.left < 0 || r.top < 0 || r.right > v.w || r.bottom > v.h) out.push('off-viewport');
  return out; });
const tipIn = (f) => f.waitForSelector('.pat-tip', { timeout: TIP_WAIT_MS }).then(async () => {
  await f.waitForTimeout(250);   // the fade, and a re-place after a slide
  return f.evaluate(() => { const t = document.querySelector('.pat-tip'); const x = t.querySelector('.pat-x').getBoundingClientRect();
    return { id: t.dataset.tip, text: t.querySelector('span').textContent, xw: x.width, xh: x.height, label: t.querySelector('.pat-x').getAttribute('aria-label') }; }); }, () => null);
// A page point (in frame coordinates) that is on no control and not on the tip.
const emptyPoint = (f) => f.evaluate(() => { const t = document.querySelector('.pat-tip');
  for (let y = innerHeight - 20; y > 20; y -= 37) for (let x = 20; x < innerWidth - 20; x += 41) { const e = document.elementFromPoint(x, y);
    if (e && !t.contains(e) && !e.closest('button,a,input,select,textarea,summary,[role=button],label,.verse,iframe')) return { x, y }; }
  return null; });
async function close(page, f, how, frameEl) {
  if (how === 'x') { await f.locator('.pat-tip .pat-x').click(); return; }
  if (how === 'esc') { await page.keyboard.press('Escape'); return; }   // focus wherever it is: the shell forwards it to the app
  const p = await emptyPoint(f); assert.ok(p, 'an empty spot to tap');
  const o = frameEl ? await page.locator(frameEl).boundingBox() : { x: 0, y: 0 };
  await page.touchscreen.tap(o.x + p.x, o.y + p.y);
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png') }) : null);
const gone = (f) => f.waitForFunction(() => !document.querySelector('.pat-tip'), null, { timeout: 3000 }).then(() => true, () => false);

async function openApp(page, slug) {
  await page.evaluate((s) => openApp('owner', s, s), slug);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((x) => x.url().includes(`/app/owner/${slug}/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, `${slug} frame loaded`); await frame.waitForFunction(() => !!window.PATips);
  return frame;
}

const HOWS = ['x', 'esc', 'out'];
for (const engine of ['chromium', 'webkit']) for (const dev of ['iphone', 'ipad']) {
  test(`${engine} ${dev}: the home tip closes by ✕, Escape and an outside tap; stays closed on reload and on a second device`, { skip: skip || skipIf(engine === 'webkit' && wkOff, 'other-engine', wkOff) || skipIf(engine === 'webkit' && !webkit, 'no-browser', 'this Playwright has no WebKit'), timeout: 180000 }, async () => {
    for (const how of HOWS) {
      await fresh();
      const ctx = await context(engine, dev); const { page, errors } = await shell(ctx);
      const t = await tipIn(page); assert.ok(t, 'the home tip shows'); assert.equal(t.id, 'tip:home-more');
      assert.equal(t.label, '关闭提示'); assert.ok(t.xw >= 44 && t.xh >= 44, `✕ is a 44px target (${t.xw}x${t.xh})`);
      assert.deepEqual(await overlapsIn(page), [], 'the tip covers no control');
      if (how === 'x') await shot(page, `after-${engine}-${dev}-home`);
      await close(page, page, how); assert.equal(await gone(page), true, `closed by ${how}`);
      await page.evaluate(() => window.PATips.whenIdle());
      await page.reload(); await page.waitForFunction(() => document.querySelector('#dot.ok'));
      await page.waitForTimeout(1500); assert.equal(await page.locator(HOME).count(), 0, 'stays closed after reload');
      const ctx2 = await context(engine, dev); const s2 = await shell(ctx2);   // a second device: no device copy
      await s2.page.waitForTimeout(1500); assert.equal(await s2.page.locator(HOME).count(), 0, 'stays closed on a second device (the account)');
      assert.deepEqual([...errors, ...s2.errors], []);
      await ctx2.close(); await ctx.close();
    }
  });
}

test('chromium iphone: blocked localStorage AND a refused account write — the tip still closes and stays closed this session', { skip, timeout: 120000 }, async () => {
  await fresh();
  const ctx = await context('chromium', 'iphone', { blockLocal: true });
  await ctx.route('**/api/profile', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, body: '{"error":"refused"}' }) : r.continue()));
  const { page, errors } = await shell(ctx);
  assert.ok(await tipIn(page), 'the tip shows (the account read worked)');
  await close(page, page, 'x'); assert.equal(await gone(page), true, 'closed although nothing could be stored on the device or the account');
  await page.evaluate(() => window.PATips.whenIdle());
  await page.reload(); await page.waitForFunction(() => document.querySelector('#dot.ok')); await page.waitForTimeout(1500);
  assert.equal(await page.locator(HOME).count(), 0, 'not shown again this session (the tab copy)');
  assert.deepEqual(errors, [], 'blocked storage stops no shell script');
  await ctx.close();
});

// Regression (CI 2026-11-26, under load): an app opened before the shell's boot profile fetch settled got its
// settings from an empty ME, so its dismissed tip showed again. Here that fetch is held back on purpose.
test('chromium iphone: an app opened while the profile is still loading keeps its dismissed tip closed', { skip, timeout: 120000 }, async () => {
  await fresh(); await put({ tipsSeen: ['tip:home-more'], appPrefs: { notes: { tipsSeen: ['app-own-bar'] } } });
  const ctx = await context('chromium', 'iphone');
  let hold = true;
  await ctx.route('**/api/profile', async (r) => { if (r.request().method() === 'GET' && hold) await new Promise((res) => setTimeout(res, 2500)); return r.continue(); });
  const { page } = await shell(ctx);
  const f = await openApp(page, 'notes'); hold = false;
  const t = await tipIn(f);
  assert.notEqual(t && t.id, 'app-own-bar', 'the dismissed tip stays closed while the profile loads');
  assert.ok(t, 'CONTROL: a tip not yet dismissed still shows (R14)');
  await ctx.close();
});

for (const engine of ['chromium', 'webkit']) for (const dev of ['iphone', 'ipad']) {
  test(`${engine} ${dev}: every app tip (Notes, Bible) closes, covers no control, and stays closed on a second device`, { skip: skip || skipIf(engine === 'webkit' && wkOff, 'other-engine', wkOff) || skipIf(engine === 'webkit' && !webkit, 'no-browser', 'this Playwright has no WebKit'), timeout: 300000 }, async () => {
    await fresh(); await put({ tipsSeen: ['tip:home-more', CAM_TIP] });   // the shell's own tip is tested above
    const found = [];
    for (const slug of ['notes', 'bible']) {
      for (let i = 0; i < OPENS_MAX; i++) {
        const ctx = await context(engine, dev); const { page } = await shell(ctx); const f = await openApp(page, slug);
        const t = await tipIn(f); if (!t) { await ctx.close(); break; }
        assert.ok(!found.some((x) => x.id === t.id && x.slug === slug), `${t.id} came back after it was closed`);   // seen is per app (appPrefs[slug])
        assert.ok(t.xw >= 44 && t.xh >= 44, `${t.id}: ✕ is a 44px target`);
        assert.deepEqual(await overlapsIn(f), [], `${t.id}: covers no control`);
        if (engine === 'chromium') await shot(page, `after-${engine}-${dev}-${t.id}`);
        const how = HOWS[found.length % HOWS.length]; found.push({ ...t, slug, how });
        await close(page, f, how, '#fr'); assert.equal(await gone(f), true, `${t.id} closed by ${how}`);
        await f.evaluate(() => window.PATips.whenIdle());
        await ctx.close();
      }
    }
    assert.ok(found.length >= 3, `tips were found and closed: ${found.map((x) => x.id)}`);
    const ctx = await context(engine, dev); const { page } = await shell(ctx);   // a second device
    for (const slug of ['notes', 'bible']) { const f = await openApp(page, slug); await f.waitForTimeout(1500);
      const id = await f.evaluate(() => document.querySelector('.pat-tip')?.dataset.tip || null);
      assert.ok(!found.some((x) => x.id === id && x.slug === slug), `${id} stays closed on a second device`); }
    await ctx.close();
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `tips-${engine}-${dev}.json`), JSON.stringify(found, null, 1));
  });
}
