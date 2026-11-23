// The Bible's floating pen cluster (pen + ↶ undo + ↷ redo, web/ink-pen.inline.html) in a REAL browser (R6),
// on a throwaway web root (never the live node): Pencil strokes are PointerEvents with pointerType 'pen'.
//   1. ↶ and ↷ appear with the pen button, step the ink back and forward, and look disabled when empty;
//   2. a Pencil drag moves the cluster, a short press is still a tap (the sheet opens beside the cluster,
//      on screen), the cluster stays inside the viewport when dragged past the edge;
//   3. the spot is remembered: a reload on the same screen puts the cluster back there.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const PHONE = { width: 390, height: 844 }, IPAD = { width: 1024, height: 768 };
const SHOT = process.env.UNDO_SHOT || '';   // optional: where to save a screenshot of the cluster
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) { const s = path.join(ROOT, 'workspace', 'apps', 'bible', f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(d, f)); }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

const bibleReady = () => typeof INK_PEN === 'object' && document.querySelectorAll('.verse').length > 5;
async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(bibleReady, null, { timeout: 90000 });   // the corpus load is slow when other e2e suites run beside this one
  await frame.evaluate(() => PATips.dismiss());
  return { ctx, page, frame };
}
// A Pencil stroke across the n-th verse's English line (down on the line, moves and up on the window).
const stroke = (frame, n) => frame.evaluate((k) => {
  const v = document.querySelectorAll('#verses .verse .ven')[k], r = v.getBoundingClientRect(), y = r.top + r.height / 2;
  const ev = (t, x) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 20 + k, clientX: x, clientY: y, pressure: 0.6 });
  v.dispatchEvent(ev('pointerdown', r.left + 4)); for (const f of [0.2, 0.3, 0.4]) v.dispatchEvent(ev('pointermove', r.left + r.width * f)); v.dispatchEvent(ev('pointerup', r.left + r.width * 0.4));
}, n);
// A Pencil press on the cluster's pen button, moved by (dx, dy) in steps, then lifted.
const penDrag = (frame, dx, dy) => frame.evaluate(([ddx, ddy]) => {
  const b = document.querySelector('.pip-btn'), r = b.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
  const ev = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 77, clientX: x, clientY: y });
  b.dispatchEvent(ev('pointerdown', x0, y0)); for (let i = 1; i <= 5; i++) b.dispatchEvent(ev('pointermove', x0 + ddx * i / 5, y0 + ddy * i / 5));
  b.dispatchEvent(ev('pointerup', x0 + ddx, y0 + ddy));
}, [dx, dy]);
const rectOf = (frame, sel) => frame.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
const hist = (frame) => frame.evaluate(() => [INK.groups().length, ...['Undo', 'Redo'].map((t) => document.querySelector(`.pip-hb[title*="${t}"]`).classList.contains('off'))]);

test('Bible: ↶ ↷ beside the pen button undo and redo Pencil ink; the cluster drags anywhere, stays on screen, and is remembered', { skip, timeout: 180000 }, async () => {
  for (const viewport of [IPAD, PHONE]) {
    let { ctx, frame } = await open(viewport);
    try {
      assert.equal(await frame.evaluate(() => document.querySelector('.pip-cl.on')), null, 'hidden until a Pencil is used');
      await frame.evaluate(() => INK.clear());   // a known start on this throwaway server
      await stroke(frame, 0); await stroke(frame, 1);
      await frame.waitForFunction(() => document.querySelector('.pip-cl.on'));
      assert.deepEqual(await hist(frame), [2, false, true], 'two strokes: undo on, redo off');
      await frame.locator('.pip-hb[title*="Undo"]').click();
      assert.deepEqual(await hist(frame), [1, false, false], 'undo took the last stroke');
      await frame.locator('.pip-hb[title*="Redo"]').click();
      assert.deepEqual(await hist(frame), [2, false, true], 'redo put it back');
      const c0 = await rectOf(frame, '.pip-cl');
      assert.ok(c0.x + c0.w <= viewport.width && c0.y + c0.h <= viewport.height, 'starts on screen, bottom right');
      await penDrag(frame, -(viewport.width / 2), -(viewport.height / 2));
      const c1 = await rectOf(frame, '.pip-cl');
      assert.ok(Math.abs(c1.x - (c0.x - viewport.width / 2)) <= 1 && Math.abs(c1.y - (c0.y - viewport.height / 2)) <= 1, `moved by the drag: ${JSON.stringify([c0, c1])}`);
      // iOS sends the click after a touch drag a task LATER: it must still be eaten (fresh review 2026-11-15).
      await frame.evaluate(() => new Promise((r) => setTimeout(() => { document.querySelector('.pip-btn').click(); r(); }, 50)));
      assert.equal(await frame.evaluate(() => document.querySelector('.pip-sheet.on')), null, 'a drag is not a tap');
      await frame.locator('.pip-btn').click();
      await frame.waitForFunction(() => document.querySelector('.pip-sheet.on'));
      const s = await rectOf(frame, '.pip-sheet');
      assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= viewport.width && s.y + s.h <= viewport.height, 'the sheet is on screen');
      assert.ok(s.y + s.h <= c1.y || s.y >= c1.y + c1.h, 'beside (above or below) the cluster, not over it');
      if (SHOT && viewport === IPAD) await frame.locator('body').screenshot({ path: SHOT });
      await frame.locator('.pip-btn').click();
      await penDrag(frame, -5000, -5000);
      const c2 = await rectOf(frame, '.pip-cl');
      assert.ok(c2.x >= 12 && c2.y >= 12, `clamped inside the top-left edge: ${JSON.stringify(c2)}`);
      await penDrag(frame, 100, 120);
      const c3 = await rectOf(frame, '.pip-cl');
      await frame.evaluate(() => PAAppPrefs.whenIdle());
      await ctx.close();
      ({ ctx, frame } = await open(viewport));
      await stroke(frame, 2);
      await frame.waitForFunction(() => document.querySelector('.pip-cl.on'));
      const c4 = await rectOf(frame, '.pip-cl');
      assert.ok(Math.abs(c4.x - c3.x) <= 1 && Math.abs(c4.y - c3.y) <= 1, `a reload puts it back: ${JSON.stringify([c3, c4])}`);
      assert.deepEqual((await hist(frame)).slice(1), [false, true], 'a fresh page has only its own history');
    } finally { await ctx.close(); }
  }
});

test('Bible: the undo/redo/drag first-use tip shows beside ↶ once the cluster appears (bilingual)', { skip, timeout: 180000 }, async () => {
  let { ctx, frame } = await open(IPAD);
  try {
    // Every OTHER tip already seen on this throwaway account, so ours is next (one tip per page open).
    await frame.evaluate(() => PAAppPrefs.patch({ tipsSeen: PATips.registered().map((r) => r.id).filter((id) => id !== 'bible-pen-history') }));
    await frame.evaluate(() => PAAppPrefs.whenIdle());
    await ctx.close();
    ({ ctx, frame } = await open(IPAD));
    assert.notEqual(await frame.evaluate(() => PATips.current()), 'bible-pen-history', 'control: not before a Pencil shows the cluster');
    await stroke(frame, 0);
    await frame.waitForFunction(() => document.querySelector('.pip-cl.on'));
    await frame.waitForFunction(() => PATips.current() === 'bible-pen-history');
    const text = await frame.evaluate(() => document.querySelector('.pat-tip').textContent);
    assert.match(text, /撤销 · Undo，重做 · Redo — 拖动可移动 · drag to move/);
  } finally { await ctx.close(); }
});
