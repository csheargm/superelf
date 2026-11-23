// The top-centre bar handle (web/bar-handle.css, 120x28; owner 2026-11-13 "longer and thicker, easy to tap")
// in a REAL browser (R6), on a throwaway root with every shipped workspace app:
//   1. the shell's #barpeek and PAAppBar's .paab-handle both measure 120x28, top-centre;
//   2. growing the shell's handle from 64x16 to 120x28 covers NO new app control (button / link / field,
//      sampled across the box inside the app frame) at 375px or iPad 1024px. Two apps with a full-width TAB
//      row at the very top (longevity, productivity-hub) already had their centre tab under the old 64x16;
//      that pre-existing overlap is listed, not hidden: the growth must not add to it;
//   3. a handle-shown Bible / Journal bar stays past the old 2.5 s timer, then idles away (ADR 0035);
//   4. the Bible's top-bar "笔 · Pen" opens the pen sheet, keeps the bar out while open, and a colour / size
//      choice changes the pen the verse ink draws with;
//   5. the app bar's "Home and text size" tip shows FIRST, ahead of older unseen tips.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const APPS = fs.readdirSync(path.join(ROOT, 'workspace', 'apps')).filter((d) => fs.existsSync(path.join(ROOT, 'workspace', 'apps', d, 'index.html')));
const OWNBAR = new Set(APPS.filter((d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'apps', d, 'meta.json'), 'utf8')).ownBar === true; } catch { return false; /* no meta.json: not an own-bar app */ } }));
const OLD_W = 64, OLD_H = 16;   // the handle before 2026-11-13, for the "no new overlap" comparison
const SETTLE_MS = 1500, OLD_TIMER_MS = 2500, PHONE = { width: 375, height: 812 }, IPAD = { width: 1024, height: 768 };
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  for (const slug of APPS) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', slug, 'index.html'), path.join(d, 'index.html'));
    const meta = path.join(ROOT, 'workspace', 'apps', slug, 'meta.json');
    if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(d, 'meta.json'));
  }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function open(slug, viewport, ready = () => document.readyState === 'complete') {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate((s) => openApp(UID, s, s), slug);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes(`/app/owner/${slug}/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, `${slug} frame loaded`);
  await frame.waitForFunction(ready);
  return { ctx, page, frame };
}
const box = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2 }; });

test('the shell handle is 120x28 top-centre and covers no app control at 375px or iPad width', { skip, timeout: 600000 }, async () => {
  const hits = [], preexisting = [];
  assert.deepEqual([...OWNBAR].sort(), ['bible', 'notes'], 'control: the two own-bar apps are the ones skipped');
  for (const viewport of [PHONE, IPAD]) for (const slug of APPS.filter((a) => !OWNBAR.has(a))) {
    const { ctx, page, frame } = await open(slug, viewport);
    try {
      await page.waitForTimeout(SETTLE_MS);
      const h = await box(page.locator('#barpeek'));
      assert.deepEqual([Math.round(h.w), Math.round(h.h)], [120, 28], `${slug}: the shell handle is 120x28`);
      assert.ok(Math.abs(h.cx - viewport.width / 2) <= 1, `${slug}: centred`);
      const fr = await box(page.locator('#fr'));
      const under = (b) => frame.evaluate(({ x0, y0, w, h }) => {
        const out = new Set();
        for (let x = x0; x <= x0 + w; x += 6) for (let y = Math.max(0, y0); y <= y0 + h; y += 4)
          for (const e of document.elementsFromPoint(x, y)) { const c = e.closest('button,a[href],input,select,textarea,[role="button"]'); if (c && getComputedStyle(c).visibility !== 'hidden') out.add((c.id || c.className || c.tagName) + ''); }
        return [...out];
      }, b);
      const now = await under({ x0: h.x - fr.x, y0: h.y - fr.y, w: h.w, h: h.h });
      const old = await under({ x0: h.cx - OLD_W / 2 - fr.x, y0: h.y - fr.y, w: OLD_W, h: OLD_H });
      if (old.length) preexisting.push(`${slug}@${viewport.width}`);
      const added = now.filter((x) => !old.includes(x));
      if (added.length) hits.push(`${slug}@${viewport.width}: ${added.join(', ')}`);
    } finally { await ctx.close(); }
  }
  assert.deepEqual(hits, [], 'the bigger handle covers no app control the old one did not');
  assert.deepEqual(preexisting.sort(), ['longevity@1024', 'longevity@375', 'productivity-hub@1024', 'productivity-hub@375'],
    'the known pre-existing overlap (a top tab row) — a change here means re-measuring');
});

const bibleReady = () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5;
// ADR 0035: a handle-shown bar is on the same idle clock as any shown bar — up past the old 2.5 s timer,
// gone after IDLE_MS with no action; a page touch alone no longer hides it.
test('Bible + Journal: their handle is 120x28; a handle-shown bar stays past the old 2.5 s timer and idles away after IDLE_MS', { skip, timeout: 120000 }, async () => {
  for (const [slug, sel, ready] of [['bible', '#nav', bibleReady], ['notes', '.pan-top', () => document.querySelector('.pan-top .paab-home') && window.PANote]]) {
    const { ctx, frame } = await open(slug, IPAD, ready);
    try {
      await frame.evaluate(() => { document.querySelectorAll('.pac-drawerhost.on').forEach((d) => d.classList.remove('on')); PAAppBar.hide(); });
      const h = await box(frame.locator('.paab-handle'));
      assert.deepEqual([Math.round(h.w), Math.round(h.h)], [120, 28], `${slug}: own handle 120x28`);
      await frame.locator('.paab-handle').click();
      await frame.evaluate(() => { for (const t of ['pointerdown', 'pointerup']) document.body.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerType: 'touch' })); });
      await frame.waitForTimeout(OLD_TIMER_MS + 700);
      assert.equal(await frame.evaluate((s) => document.querySelector(s).getAttribute('data-paab-hidden'), sel), '0', `${slug}: still shown after 3.2 s, a page touch did not hide it`);
      await frame.locator(`${sel} .paab-home`).waitFor();   // Home is right there, no race
      await frame.waitForFunction((s) => document.querySelector(s).getAttribute('data-paab-hidden') === '1', sel, { timeout: 4000 });
    } finally { await ctx.close(); }
  }
});

// Runs BEFORE the pen test: that one dismisses the tip, and tipsSeen lives on this throwaway server.
test('Bible: the app-bar "Home and text size" tip shows first, ahead of the older unseen tips', { skip, timeout: 60000 }, async () => {
  { const first = await open('bible', IPAD, bibleReady);   // the earlier tests' taps dismissed it for good (dismissOnUse, F2-07): start fresh
    try { await first.frame.evaluate(() => PATips.reset()); } finally { await first.ctx.close(); } }
  const { ctx, frame } = await open('bible', IPAD, bibleReady);
  try {
    assert.ok((await frame.evaluate(() => PATips.registered().map((r) => r.id))).length > 1, 'control: other tips are waiting too');
    await frame.waitForFunction(() => PATips.current());
    assert.equal(await frame.evaluate(() => PATips.current()), 'app-own-bar');
  } finally { await ctx.close(); }
});

test('Bible: the floating round pen button (shown once a Pencil touches the verses) opens the pen sheet at the bottom right; colour and size change the ink pen', { skip, timeout: 120000 }, async () => {
  for (const viewport of [PHONE, IPAD]) {
    const { ctx, frame } = await open('bible', viewport, bibleReady);
    try {
      assert.equal(await frame.evaluate(() => !!document.querySelector('#top-pen')), false, 'no Pen in the top bar');
      assert.equal(await frame.evaluate(() => document.querySelector('.pip-cl.on')), null, 'hidden until a Pencil is used');
      await frame.evaluate(() => PATips.dismiss());
      await frame.evaluate(() => { const v = document.querySelector('#verses .verse .ven'), r = v.getBoundingClientRect();
        v.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', pointerId: 9, clientX: r.left + 10, clientY: r.top + 5 }));
        v.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', pointerId: 9, clientX: r.left + 10, clientY: r.top + 5 })); });
      await frame.waitForFunction(() => document.querySelector('.pip-cl.on'));
      const pen = frame.locator('.pip-btn');
      const pb = await box(pen);
      assert.ok(pb.x + pb.w <= viewport.width + 1 && pb.x > viewport.width / 2 && pb.y > viewport.height / 2, `${viewport.width}: the round button sits at the bottom right, on screen`);
      await pen.click();
      await frame.waitForFunction(() => document.querySelector('.pip-sheet.on'));
      const sb = await box(frame.locator('.pip-sheet'));
      assert.ok(sb.x >= 0 && sb.x + sb.w <= viewport.width + 1 && sb.y >= 0, 'the sheet is on screen');
      await frame.locator('.pip-sheet .pan-tbtn[title="细 · Thin"]').click();   // a known start: the choice persists per app
      const before = await frame.evaluate(() => INK.pen());
      await frame.locator('.pip-sheet .pan-tbtn[title="粗 · Thick"]').click();
      const sw = frame.locator('.pip-sheet .pan-sw').nth(5); const c = await sw.getAttribute('data-color');
      await sw.click();
      const after_ = await frame.evaluate(() => INK.pen());
      assert.equal(after_.c, c, 'the chosen colour is the ink colour');
      assert.ok(after_.w > before.w, 'thick draws wider');
      await pen.click();   // tap again closes it
      await frame.waitForFunction(() => !document.querySelector('.pip-sheet.on'));
    } finally { await ctx.close(); }
  }
});
