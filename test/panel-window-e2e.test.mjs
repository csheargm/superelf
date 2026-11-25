// Panel windows in a REAL browser (R6) · 面板窗口（真实浏览器）: the real web.mjs on a throwaway root, the real shell
// and the shipped Bible in its sandboxed iframe, John 3. Ask AI / Note as independent windows: open, tear off,
// move, resize from edge and corner, minimise → pill → restore, maximise → restore, all six snap targets with
// their preview, the layout kept per device across a reload, a finger / Pencil drag that never flips or inks
// (iPad), and the phone's full-screen sheet. PA_E2E_ENGINE=webkit runs it in iPad Safari's engine.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

let port, web, browser, root;
const SHOTS = process.env.PA_PANEL_SHOTS || '';   // a folder: screenshots for the owner's screen check
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'shared-apps', 'bible', f), path.join(d, f));
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

const DESK = { width: 1230, height: 1056 };
async function open({ viewport = DESK, touch = false, ctx = null } = {}) {
  ctx = ctx || await browser.newContext({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 600 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(() => document.querySelectorAll('.verse').length > 5);
  await frame.evaluate(() => goChapter(42, 3));   // John 3
  await frame.waitForFunction(() => chapter === 3 && document.querySelectorAll('.verse').length > 30);
  await frame.evaluate(() => { if (window.PATips && PATips.current()) PATips.dismiss(PATips.current()); });
  const off = await (await frame.frameElement()).boundingBox();
  return { ctx, page, frame, off };
}
// Window state by title key ('chat' | 'note'), read from the page.
const win = (frame, key) => frame.evaluate((k) => { const w = rail && rail.win(k); if (!w) return null;
  const el = w.el, r = el.getBoundingClientRect(); return { ...w.state(), on: el.classList.contains('on'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, key);
const vis = (frame) => frame.evaluate(() => [...document.querySelectorAll('.paw-win.on .paw-t')].map((t) => t.textContent));
// A mouse drag in page coordinates; `mid` runs while still pressed (preview checks).
async function drag(page, off, from, to, mid) {
  await page.mouse.move(off.x + from.x, off.y + from.y); await page.mouse.down();
  await page.mouse.move(off.x + from.x + 10, off.y + from.y + 10, { steps: 2 });
  await page.mouse.move(off.x + to.x, off.y + to.y, { steps: 8 });
  if (mid) await mid();
  await page.mouse.up();
}
const barOf = async (frame, key) => frame.evaluate((k) => { const r = rail.win(k).el.querySelector('.paw-t').getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; }, key);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

// Runs FIRST: tipsSeen lives on this server, and any later test's first tap would dismiss it.
test('first-use tip: 拖动标题栏可移动或停靠 · Drag the title bar to move or dock, beside a window title', { skip, timeout: 240000 }, async () => {
  const ctx = await browser.newContext({ viewport: DESK });
  try {
    let got = null;
    // Tips show one per page open, in registration order: earlier unseen tips are dismissed open by open.
    for (let i = 0; i < 10 && !got; i++) {
      const { page, frame } = await open({ ctx });
      await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
      await frame.waitForTimeout(800);
      const cur = await frame.evaluate(() => PATips.current());
      if (cur === 'panel-window-drag') {
        got = await frame.evaluate(() => { const t = document.querySelector('.pat-tip'), b = rail.win('chat').el.querySelector('.paw-bar').getBoundingClientRect(), r = t.getBoundingClientRect();
          return { text: t.textContent, near: Math.abs(r.top - b.bottom) < 60 || Math.abs(r.bottom - b.top) < 60 }; });
        await page.screenshot({ path: SHOTS ? path.join(SHOTS, 'after-desktop-tip.png') : path.join(root, 'tip.png') });
      } else if (cur) { await frame.evaluate((c) => PATips.dismiss(c), cur); await frame.evaluate(() => PATips.whenIdle()); }
      await page.close();
    }
    assert.ok(got, 'the panel tip showed');
    assert.match(got.text, /拖动标题栏可移动或停靠 · Drag the title bar to move or dock/);
    assert.ok(got.near, 'beside the title bar');
  } finally { await ctx.close(); }
});

test('Ask AI opens ONLY Ask AI; Note opens its own window; each ✕ closes only itself; labels are 中文 first', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame } = await open();
  try {
    await frame.locator('#top-ai').click();
    await frame.waitForSelector('.paw-win.on');
    assert.deepEqual(await vis(frame), ['问一问 · Ask AI'], 'no Note strip with Ask AI');
    await shot(page, 'after-desktop-1230-askai');
    const labels = await frame.evaluate(() => [...document.querySelectorAll('.paw-win.on .paw-btn')].map((b) => [b.textContent, b.title, b.getAttribute('aria-label')]));
    assert.deepEqual(labels, [['—', '最小化 · Minimize', '最小化 · Minimize'], ['□', '最大化 · Maximize', '最大化 · Maximize'], ['✕', '关闭 · Close', '关闭 · Close']]);
    assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.paw-win.on .pac-top .pac-close')).display), 'none', 'one ✕ per window, not two');
    await frame.locator('#top-note').click();
    await frame.waitForFunction(() => document.querySelectorAll('.paw-win.on').length === 2);
    assert.equal((await vis(frame)).length, 2);
    await shot(page, 'after-desktop-both'); await frame.locator('.paw-win.on .paw-close').first().click({ timeout: 5000 });   // Ask AI's
    await frame.waitForFunction(() => document.querySelectorAll('.paw-win.on').length === 1);
    assert.equal((await win(frame, 'note')).on, true, 'the note stays open');
    assert.equal(await frame.evaluate(() => TOP.chat.getAttribute('aria-pressed')), 'false', 'the top button follows');
  } finally { await ctx.close(); }
});

test('drag the title bar: a docked window tears off, floats, moves over the page (the body never steals the drag)', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame, off } = await open();
  try {
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    assert.equal((await win(frame, 'chat')).where, 'right');
    const b = await barOf(frame, 'chat');
    await drag(page, off, b, { x: 400, y: 300 }, async () => {
      assert.ok(await frame.evaluate(() => document.documentElement.classList.contains('paw-moving')), 'moving while held');
    });
    const a = await win(frame, 'chat');
    assert.equal(a.mode, 'float'); assert.ok(Math.abs(a.y - 280) < 40, `follows the pointer (y ${a.y})`);
    // Across the reading column and back: pointer capture keeps the drag.
    const b2 = await barOf(frame, 'chat');
    await drag(page, off, b2, { x: b2.x + 200, y: b2.y + 150 });
    const c = await win(frame, 'chat');
    assert.ok(Math.abs(c.x - a.x - 190) < 30 && Math.abs(c.y - a.y - 140) < 30, `moved again (${a.x},${a.y} → ${c.x},${c.y})`);
    assert.equal(await frame.evaluate(() => document.documentElement.classList.contains('paw-pr')), false, 'a float pushes nothing');
    await shot(page, 'after-desktop-floating');
  } finally { await ctx.close(); }
});

test('resize a floating window from an edge and a corner; a docked one from its inner edge', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame, off } = await open();
  try {
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    const d0 = await win(frame, 'chat');
    await drag(page, off, { x: d0.x + 1, y: 500 }, { x: d0.x - 120, y: 500 });
    const d1 = await win(frame, 'chat');
    assert.ok(d1.w > d0.w + 90, `the docked inner edge widens it (${d0.w} → ${d1.w})`);
    await frame.evaluate(() => rail.win('chat').float({ x: 300, y: 200, w: 420, h: 480 }));
    const f0 = await win(frame, 'chat');
    await drag(page, off, { x: f0.x + f0.w + 1, y: f0.y + 200 }, { x: f0.x + f0.w + 101, y: f0.y + 200 });
    const f1 = await win(frame, 'chat');
    assert.ok(Math.abs(f1.w - f0.w - 100) < 15 && f1.h === f0.h, `east edge: width only (${f0.w}x${f0.h} → ${f1.w}x${f1.h})`);
    await drag(page, off, { x: f1.x + f1.w + 2, y: f1.y + f1.h + 2 }, { x: f1.x + f1.w + 62, y: f1.y + f1.h + 82 });
    const f2 = await win(frame, 'chat');
    assert.ok(f2.w > f1.w + 40 && f2.h > f1.h + 60, `corner: both (${f1.w}x${f1.h} → ${f2.w}x${f2.h})`);
    await drag(page, off, { x: f2.x + 30, y: f2.y + 30 + 200 }, { x: f2.x + 30, y: f2.y + 30 + 200 });   // no-op control: inside the body
    assert.deepEqual(await win(frame, 'chat'), f2, 'a press inside the body moves nothing');
  } finally { await ctx.close(); }
});

test('minimise → a pill → restore at the same size; maximise → fills the screen → restore to before', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame } = await open();
  try {
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    await frame.evaluate(() => rail.win('chat').float({ x: 200, y: 150, w: 500, h: 520 }));
    const r0 = await win(frame, 'chat');
    await frame.locator('.paw-win.on .paw-min').click();
    await frame.waitForSelector('.paw-pill');
    assert.equal((await win(frame, 'chat')).on, false);
    assert.equal(await frame.locator('.paw-pill').getAttribute('title'), '恢复 · Restore 问一问 · Ask AI');
    await shot(page, 'after-desktop-minimized-pill');
    await frame.locator('.paw-pill').click();
    const r1 = await win(frame, 'chat');
    assert.deepEqual([r1.x, r1.y, r1.w, r1.h], [r0.x, r0.y, r0.w, r0.h], 'restored at the same place and size');
    await frame.locator('.paw-win.on .paw-maxb').click();
    const m = await win(frame, 'chat'); const vp = await frame.evaluate(() => [innerWidth, innerHeight]);
    assert.deepEqual([m.x, m.y, m.w, m.h], [0, 0, vp[0], vp[1]]);
    assert.equal(await frame.locator('.paw-win.on .paw-maxb').getAttribute('title'), '还原 · Restore');
    await frame.locator('.paw-win.on .paw-maxb').click();
    const r2 = await win(frame, 'chat');
    assert.deepEqual([r2.x, r2.y, r2.w, r2.h], [r0.x, r0.y, r0.w, r0.h], 'restore returns to the size before');
    await frame.dispatchEvent('.paw-win.on .paw-t', 'dblclick');
    assert.equal((await win(frame, 'chat')).max, true, 'double-click on the title maximises');
  } finally { await ctx.close(); }
});

test('every snap target shows its preview while dragging and docks on release', { skip, timeout: 120000 }, async () => {
  const { ctx, page, frame, off } = await open();
  try {
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    const vp = await frame.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const at = { left: { x: 8, y: vp.h / 2 }, top: { x: vp.w / 2, y: 6 }, bottom: { x: vp.w / 2, y: vp.h - 6 }, tr: { x: vp.w - 8, y: 8 }, br: { x: vp.w - 8, y: vp.h - 8 }, right: { x: vp.w - 8, y: vp.h / 2 } };
    for (const [where, p] of Object.entries(at)) {
      const b = await barOf(frame, 'chat');
      let seen = null;
      await drag(page, off, b, p, async () => { seen = await frame.evaluate(() => ({ on: document.querySelector('.paw-snap').classList.contains('on'),
        hit: (document.querySelector('.paw-tgt.hit') || {}).dataset?.w, r: document.querySelector('.paw-snap').getBoundingClientRect().toJSON() })); });
      assert.ok(seen.on, `${where}: preview shown`); assert.equal(seen.hit, where, `${where}: its target lit`);
      const s = await win(frame, 'chat');
      assert.equal(s.mode, 'dock', where); assert.equal(s.where, where);
      assert.ok(Math.abs(s.x - seen.r.x) < 2 && Math.abs(s.w - seen.r.width) < 2, `${where}: docks where the preview said`);
      if (where === 'left') assert.ok(await frame.evaluate(() => document.getElementById('verses').getBoundingClientRect().left >= rail.win('chat').el.getBoundingClientRect().right - 1), 'left dock pushes the text');
      if (where === 'top') await shot(page, 'after-desktop-dock-top');
      if (where === 'tr') await shot(page, 'after-desktop-dock-topright');
    }
    // Esc cancels a drag: the window goes back.
    const before = await win(frame, 'chat'); const b = await barOf(frame, 'chat');
    await page.mouse.move(off.x + b.x, off.y + b.y); await page.mouse.down(); await page.mouse.move(off.x + 300, off.y + 300, { steps: 6 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await win(frame, 'chat'), before, 'Esc cancels');
  } finally { await ctx.close(); }
});

test('the layout is remembered per device: a reload brings back the same dock, size and float', { skip, timeout: 120000 }, async () => {
  const ctx = await browser.newContext({ viewport: DESK });
  try {
    let { page, frame } = await open({ ctx });
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    await frame.evaluate(() => rail.win('chat').float({ x: 260, y: 180, w: 460, h: 500 }));
    await frame.locator('#top-note').click(); await frame.waitForFunction(() => rail.win('note').isVisible());
    await frame.evaluate(() => rail.win('note').dock('left'));
    await frame.waitForTimeout(500); await frame.evaluate(() => PAAppPrefs.whenIdle());
    const c0 = await win(frame, 'chat'), n0 = await win(frame, 'note');
    await page.close();
    ({ page, frame } = await open({ ctx }));
    await frame.evaluate(() => PAAppPrefs.whenIdle());
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    await frame.locator('#top-note').click(); await frame.waitForFunction(() => rail.win('note').isVisible());
    const c1 = await win(frame, 'chat'), n1 = await win(frame, 'note');
    assert.deepEqual([c1.mode, c1.x, c1.y, c1.w, c1.h], [c0.mode, c0.x, c0.y, c0.w, c0.h], 'Ask AI floats where it was');
    assert.deepEqual([n1.where, n1.w], [n0.where, n0.w], 'Note is docked left at the same width');
    const stored = await frame.evaluate(() => PAAppPrefs.get().paneLayout2);
    assert.ok(stored.desktop && stored.desktop.chat && !stored.tablet, 'kept under this device class only');
  } finally { await ctx.close(); }
});

test('iPad 1180x820: a finger or Pencil drag on the title moves the window — never a page flip, never ink', { skip, timeout: 120000 }, async () => {
  const { ctx, page, frame } = await open({ viewport: { width: 1180, height: 820 }, touch: true });
  try {
    await frame.locator('#top-note').click(); await frame.waitForFunction(() => rail.win('note').isVisible());
    await frame.locator('#top-ai').click(); await frame.waitForFunction(() => rail.win('chat').isVisible());
    await shot(page, 'after-ipad-1180-both');
    for (const kind of ['touch', 'pen']) {
      const r = await frame.evaluate(async (pt) => {
        const ch0 = chapter; let padHits = 0; const pad = document.querySelector('.pan-panel'); const hit = () => { padHits++; };
        for (const ty of ['pointerdown', 'pointermove', 'touchstart']) pad.addEventListener(ty, hit, true);
        const t = rail.win('note').el.querySelector('.paw-t'), b = t.getBoundingClientRect(), x0 = b.x + 200, y0 = b.y + b.height / 2;
        const fire = (type, x, y) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: pt, isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
        const tfire = (type, x, y) => { try { const touch = new Touch({ identifier: 7, target: t, clientX: x, clientY: y });
          t.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch], changedTouches: [touch] })); } catch (_) { /* no Touch constructor: pointer events only */ } };
        const before = rail.win('note').rect();
        const top = document.elementFromPoint(x0, y0); const onBar = !!(top && top.closest('.paw-bar'));
        tfire('touchstart', x0, y0); fire('pointerdown', x0, y0);
        for (let i = 1; i <= 10; i++) { tfire('touchmove', x0 + 20 * i, y0 - 25 * i); fire('pointermove', x0 + 20 * i, y0 - 25 * i); }
        fire('pointerup', x0 + 200, y0 - 250); tfire('touchend', x0 + 200, y0 - 250);
        await new Promise((z) => setTimeout(z, 400));
        return { moved: rail.win('note').rect(), before, ch: chapter, ch0, padHits, onBar, mode: rail.win('note').state().mode };
      }, kind);
      assert.equal(r.mode, 'float', `${kind}: the window tore off ${JSON.stringify(r)}`);
      assert.ok(r.moved.y < r.before.y - 150, `${kind}: it moved (${JSON.stringify(r.before)} → ${JSON.stringify(r.moved)})`);
      assert.equal(r.ch, r.ch0, `${kind}: no page flip`);
      assert.ok(r.onBar, `${kind}: the press lands on the title bar, not the pad`);
      assert.equal(r.padHits, 0, `${kind}: the pad (ink stage) never sees the drag`);
      await frame.evaluate(() => rail.win('note').dock('bottom'));
    }
    assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.paw-bar')).touchAction), 'none');
  } finally { await ctx.close(); }
});

test('GPT review: one pointer owns a drag, a lost pointer never sticks, a cancelled resize is undone, pills sit above a bottom dock, keyboard keeps a dock docked', { skip, timeout: 120000 }, async () => {
  const { ctx, frame } = await open();
  try {
    await frame.locator('#top-ai').click(); await frame.waitForFunction(() => rail.win('chat').isVisible());
    const r = await frame.evaluate(async () => {
      rail.win('chat').dock('right');
      const w = rail.win('chat'), t = w.el.querySelector('.paw-t'), b = t.getBoundingClientRect(), x0 = b.x + 30, y0 = b.y + b.height / 2;
      const fire = (el, type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: id === 1 ? 'pen' : 'touch', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
      const out = {};
      // Pencil (id 1) drags; a finger (id 2) touches and lifts mid-drag — the Pencil's drag goes on.
      fire(t, 'pointerdown', 1, x0, y0); fire(t, 'pointermove', 1, x0 - 100, y0 + 200);
      fire(t, 'pointerdown', 2, x0 + 5, y0); fire(t, 'pointermove', 2, x0 + 400, y0 + 400); fire(t, 'pointerup', 2, x0 + 400, y0 + 400);
      out.stillMoving = document.documentElement.classList.contains('paw-moving');
      fire(t, 'pointermove', 1, x0 - 300, y0 + 250); const mid = w.rect();
      fire(t, 'pointerup', 1, x0 - 300, y0 + 250);
      out.followedPen = Math.abs(mid.x - (w.rect().x)) < 2 && w.state().mode === 'float' ? true : JSON.stringify([mid, w.rect(), w.state()]);
      // A lost pointer (capture lost, no pointerup) ends the drag: nothing stays unclickable.
      const b2 = t.getBoundingClientRect();
      fire(t, 'pointerdown', 3, b2.x + 30, b2.y + 10); fire(t, 'pointermove', 3, b2.x + 80, b2.y + 60);
      out.movingBefore = document.documentElement.classList.contains('paw-moving');
      t.closest('.paw-bar').dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 3 }));
      out.movingAfterLost = document.documentElement.classList.contains('paw-moving');
      fire(t, 'pointerdown', 4, b2.x + 30, b2.y + 10); fire(t, 'pointermove', 4, b2.x + 80, b2.y + 60);
      document.querySelector('.paw-bar').dispatchEvent(new FocusEvent('blur')); out.movingAfterElBlur = document.documentElement.classList.contains('paw-moving');
      window.dispatchEvent(new Event('blur')); out.movingAfterBlur = document.documentElement.classList.contains('paw-moving');
      // A resize cancelled by Esc is undone (and not saved).
      w.float({ x: 200, y: 200, w: 400, h: 400 });
      const r0 = w.rect(), h = w.el.querySelector('.paw-h[data-d=se]'), hb = h.getBoundingClientRect();
      fire(h, 'pointerdown', 5, hb.x + 5, hb.y + 5); fire(h, 'pointermove', 5, hb.x + 120, hb.y + 90);
      out.grew = w.rect().w > r0.w;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.undone = JSON.stringify(w.rect()) === JSON.stringify(r0);
      // A minimised window's pill paints above a bottom-docked Note.
      await new Promise((z) => setTimeout(z, 50));
      return out;
    });
    assert.deepEqual(r, { stillMoving: true, followedPen: true, movingBefore: true, movingAfterLost: false, movingAfterElBlur: true, movingAfterBlur: false, grew: true, undone: true });
    await frame.locator('#top-note').click(); await frame.waitForFunction(() => rail.win('note').isVisible());
    await frame.evaluate(() => { rail.win('note').dock('bottom'); rail.win('chat').minimize(); });
    const pillTop = await frame.evaluate(() => { const p = document.querySelector('.paw-pill').getBoundingClientRect(), e = document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2); return !!(e && e.closest('.paw-pill')); });
    assert.ok(pillTop, 'the pill is the top element at its centre, over the bottom dock');
    const k = await frame.evaluate(() => { const w = rail.win('note'), bar = w.el.querySelector('.paw-bar'), ev = (key, shift) => bar.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
      const h0 = w.rect().h; ev('ArrowUp', true); const h1 = w.rect().h; ev('ArrowLeft', false); return { grew: h1 > h0, mode: w.state().mode, where: w.state().where }; });
    assert.deepEqual(k, { grew: true, mode: 'dock', where: 'left' }, 'Alt+Shift+Up grows the bottom dock; Alt+Left docks it left — never a float');
  } finally { await ctx.close(); }
});

test('iPad portrait 820x1180 keeps windows; iPhone 390: Ask AI is a full-screen sheet with ✕, no windows', { skip, timeout: 120000 }, async () => {
  let { ctx, page, frame } = await open({ viewport: { width: 820, height: 1180 }, touch: true });
  try {
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    await shot(page, 'after-ipad-820-askai');
  } finally { await ctx.close(); }
  ({ ctx, page, frame } = await open({ viewport: { width: 390, height: 844 }, touch: true }));
  try {
    await frame.locator('#top-ai').click();
    await frame.waitForFunction(() => { const f = document.querySelector('.pac-fs'); return f && getComputedStyle(f).display !== 'none'; });
    assert.equal(await frame.locator('.paw-win.on').count(), 0, 'no floating windows on a phone');
    assert.ok(await frame.evaluate(() => { const x = document.querySelector('.pac-fs .pac-top .pac-close'); return x && getComputedStyle(x).display !== 'none'; }), 'the sheet has its ✕');
    await shot(page, 'after-iphone-390-askai');
  } finally { await ctx.close(); }
});
