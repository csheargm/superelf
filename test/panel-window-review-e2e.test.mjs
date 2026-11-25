// Panel windows, review fixes in a REAL browser (R6): GPT review and R13 findings on the shipped Bible at John 3.
// Split from panel-window-e2e.test.mjs (R4). Without Playwright the file FAILS, unless PA_E2E_SKIP=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skip, useBibleServer, ctxNew, rootDir, SHOTS, DESK, open, win, vis, drag, barOf, shot } from './helpers-panel-window.mjs';

useBibleServer();
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

test('R13 review: a layout survives a phone-width gate crossing; two windows on one edge resize together; a pill sits above a maximised window; a save keeps another device class', { skip, timeout: 120000 }, async () => {
  const { ctx, page, frame } = await open();
  try {
    await frame.evaluate(() => PAAppPrefs.patch({ paneLayout2: { tablet: { chat: { mode: 'dock', where: 'left', size: { left: 0.3 } } } } }));
    await frame.evaluate(() => PAAppPrefs.whenIdle());
    await frame.locator('#top-ai').click(); await frame.waitForFunction(() => rail.win('chat').isVisible());
    await frame.evaluate(() => rail.win('chat').float({ x: 300, y: 200, w: 440, h: 480 }));
    const c0 = await win(frame, 'chat');
    // Across the phone gate the rail is destroyed and rebuilt; the session's layout comes back, not the page-load one.
    await page.setViewportSize({ width: 390, height: 844 }); await frame.waitForFunction(() => !rail);
    await page.setViewportSize(DESK); await frame.waitForFunction(() => !!rail);
    await frame.locator('#top-ai').click(); await frame.waitForFunction(() => rail.win('chat').isVisible());
    const c1 = await win(frame, 'chat');
    assert.deepEqual([c1.mode, c1.x, c1.y, c1.w, c1.h], [c0.mode, c0.x, c0.y, c0.w, c0.h], 'Ask AI floats where it was after the gate crossing');
    // Two windows docked right share the edge: dragging the inner edge outward-then-in shrinks BOTH.
    await frame.locator('#top-note').click(); await frame.waitForFunction(() => rail.win('note').isVisible());
    await frame.evaluate(() => { rail.win('chat').dock('right'); rail.win('note').dock('right'); });
    const w0 = (await win(frame, 'chat')).w;
    await frame.evaluate(() => { const w = rail.win('chat'), h = w.el.querySelector('.paw-h[data-d=w]'), b = h.getBoundingClientRect(), x = b.x + 5, y = b.y + 50;
      const f = (t, X) => h.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 9, clientX: X, clientY: y, buttons: t === 'pointerup' ? 0 : 1 }));
      f('pointerdown', x); f('pointermove', x + 40); f('pointermove', x + 80); f('pointerup', x + 80); });
    const cw = (await win(frame, 'chat')).w, nw = (await win(frame, 'note')).w;
    assert.ok(cw < w0 - 40 && cw === nw, `both right-docked windows shrank together (${w0} → chat ${cw}, note ${nw})`);
    // A pill is reachable over a maximised window.
    await frame.evaluate(() => { rail.win('note').maximize(); rail.win('chat').minimize(); });
    const pillTop = await frame.evaluate(() => { const p = document.querySelector('.paw-pill').getBoundingClientRect(), e = document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2); return !!(e && e.closest('.paw-pill')); });
    assert.ok(pillTop, 'the pill is the top element over a maximised window');
    // The saves above replaced only this device class: the seeded tablet layout is untouched (non-vacuous: it existed).
    await frame.waitForTimeout(500); await frame.evaluate(() => PAAppPrefs.whenIdle());
    const stored = await frame.evaluate(async () => { const r = await PAAppPrefs.read(); return r.prefs.paneLayout2; });
    assert.deepEqual(stored.tablet, { chat: { mode: 'dock', where: 'left', size: { left: 0.3 } } }, 'the tablet layout survived');
    assert.ok(stored.desktop && stored.desktop.note && stored.desktop.note.max, 'this class was written');
    assert.ok(!stored.phone || !stored.phone.chat || stored.phone.chat.mode !== 'float', 'nothing from the desktop leaked into the phone class');
  } finally { await ctx.close(); }
});
