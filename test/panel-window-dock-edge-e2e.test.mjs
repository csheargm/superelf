// A DOCKED window resizes from its inner edge (owner 2026-11-25) in a real browser, for every dock: a visible bar,
// a 12px (mouse) / 44px (touch) strip, col/row-resize, a tooltip; a mouse, finger or Pencil drag resizes, the page
// reflows live, and the size is kept for the next page load.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (test/helpers-note-link.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skip, useBibleServer, open, win, drag, shot } from './helpers-panel-window.mjs';

useBibleServer();
// Each dock: its inner handle, the push variable it drives (corners push nothing), and the drag direction that grows it.
const DOCKS = [['right', 'w', 'r', [-90, 0]], ['left', 'e', 'l', [90, 0]], ['top', 's', 't', [0, 90]],
  ['bottom', 'n', 'b', [0, -90]], ['tr', 'w', '', [-90, 0]], ['br', 'w', '', [-90, 0]]];
const handle = (frame, d) => frame.evaluate((dd) => {
  const h = rail.win('chat').el.querySelector(`.paw-h[data-d=${dd}]`), b = h.getBoundingClientRect(), g = getComputedStyle(h, '::after');
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  return { thick: Math.round(dd === 'n' || dd === 's' ? b.height : b.width), len: Math.round(dd === 'n' || dd === 's' ? b.width : b.height),
    cx, cy, cursor: getComputedStyle(h).cursor, title: h.title, bar: g.content !== 'none' && Math.max(parseFloat(g.width), parseFloat(g.height)) >= 30,
    top: document.elementFromPoint(cx, cy) === h, shown: getComputedStyle(h).display !== 'none' };
}, d);
const push = (frame, e) => frame.evaluate((k) => getComputedStyle(document.documentElement).getPropertyValue('--paw-' + k).trim(), e);
const verse = (frame) => frame.evaluate(() => { const r = document.querySelector('.verse').getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y) }; });

test('every dock: a visible, grabbable inner edge; a mouse drag resizes, the page reflows live, the size is kept', { skip, timeout: 240000 }, async () => {
  const { ctx, page, frame, off } = await open();
  try {
    await frame.locator('#top-ai').click(); await frame.waitForSelector('.paw-win.on');
    for (const [where, d, e, [dx, dy]] of DOCKS) {
      await frame.evaluate((w) => rail.win('chat').dock(w), where);
      if (where === 'right') { await shot(page, 'dock-right-light'); await page.emulateMedia({ colorScheme: 'dark' }); await shot(page, 'dock-right-dark'); await page.emulateMedia({ colorScheme: 'light' }); }
      const h = await handle(frame, d), w0 = await win(frame, 'chat'), v0 = await verse(frame);
      assert.ok(h.shown && h.thick >= 12, `${where}: handle ≥ 12px thick (${h.thick})`);
      assert.ok(h.len >= Math.min(w0.w, w0.h) - 2, `${where}: handle runs the edge (${h.len})`);
      assert.equal(h.cursor, d === 'n' || d === 's' ? 'row-resize' : 'col-resize', where);
      assert.equal(h.title, '拖动边缘调整大小 · Drag the edge to resize'); assert.ok(h.bar, `${where}: bar drawn`); assert.ok(h.top, `${where}: handle is on top at its centre`);
      let mid = null;
      await drag(page, off, { x: h.cx, y: h.cy }, { x: h.cx + dx, y: h.cy + dy }, async () => { mid = { w: await win(frame, 'chat'), p: e && await push(frame, e), v: await verse(frame) }; });
      const w1 = await win(frame, 'chat'), grow = (a) => (d === 'n' || d === 's' ? a.h : a.w);
      assert.ok(grow(w1) > grow(w0) + 60, `${where}: drag grows the dock (${grow(w0)} → ${grow(w1)})`);
      assert.ok(grow(mid.w) > grow(w0) + 60, `${where}: live during the drag`);
      if (e) assert.equal(mid.p, grow(mid.w) + 'px', `${where}: the page push follows live`);
      if (where === 'right' || where === 'left') assert.ok(mid.v.w < v0.w - 40, `${where}: the page text reflows live (${v0.w} → ${mid.v.w})`);
      if (where === 'top') assert.ok(mid.v.y > v0.y + 40, `top: the page moves down live (${v0.y} → ${mid.v.y})`);
      const h2 = await handle(frame, d);   // shrink back a little from the new edge
      await drag(page, off, { x: h2.cx, y: h2.cy }, { x: h2.cx - dx / 2, y: h2.cy - dy / 2 });
      assert.ok(grow(await win(frame, 'chat')) < grow(w1) - 30, `${where}: drag shrinks the dock`);
    }
    await frame.evaluate(() => rail.win('chat').dock('right'));
    const h = await handle(frame, 'w'); await drag(page, off, { x: h.cx, y: h.cy }, { x: h.cx - 120, y: h.cy });
    const kept = (await win(frame, 'chat')).w; await page.waitForTimeout(900);
    const again = await open({ ctx });
    await again.frame.locator('#top-ai').click(); await again.frame.waitForSelector('.paw-win.on');
    await again.frame.waitForFunction((k) => Math.abs(rail.win('chat').el.getBoundingClientRect().width - k) < 4, kept);
  } finally { await ctx.close(); }
});

test('iPad 1180x820: every dock edge is a 44px strip and a finger drag grows it, a Pencil drag shrinks it', { skip, timeout: 120000 }, async () => {
  const { ctx, page, frame } = await open({ viewport: { width: 1180, height: 820 }, touch: true });
  try {
    await frame.locator('#top-ai').click(); await frame.waitForFunction(() => rail.win('chat').isVisible());
    for (const [where, d, , [dx, dy]] of DOCKS) {
      await frame.evaluate((w) => rail.win('chat').dock(w), where);
      if (where === 'right') await shot(page, 'dock-ipad-1180');
      const h = await handle(frame, d);
      assert.ok(h.thick >= 44, `${where}: touch strip ≥ 44px (${h.thick})`); assert.ok(h.top, `${where}: on top`);
      for (const kind of ['touch', 'pen']) {
        await frame.evaluate((w) => { rail.win('chat').dock(w === 'tr' || w === 'br' ? 'right' : w); rail.win('chat').dock(w); }, where);
        const r = await frame.evaluate(([dd, pt, mx, my]) => { const w = rail.win('chat'), hh = w.el.querySelector(`.paw-h[data-d=${dd}]`), b = hh.getBoundingClientRect(), r0 = w.rect();
          const x0 = b.x + 3, y0 = b.y + 3, fire = (type, x, y) => hh.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: pt, isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
          const t0 = document.elementFromPoint(x0, y0);
          fire('pointerdown', x0, y0); for (let i = 1; i <= 8; i++) fire('pointermove', x0 + mx * i / 8, y0 + my * i / 8); fire('pointerup', x0 + mx, y0 + my);
          return { r0, r1: w.rect(), ta: getComputedStyle(hh).touchAction, top: t0 === hh, at: t0 && (t0.className || t0.tagName), b: [b.x, b.y, b.width, b.height] }; }, [d, kind, kind === 'pen' ? -dx : dx, kind === 'pen' ? -dy : dy]);
        const g = (a) => (d === 'n' || d === 's' ? a.h : a.w);
        assert.equal(r.ta, 'none'); assert.ok(r.top, `${where}/${kind}: a point near the strip edge is the strip ${JSON.stringify(r)}`);
        assert.ok(kind === 'pen' ? g(r.r1) < g(r.r0) - 40 : g(r.r1) > g(r.r0) + 40, `${where}/${kind}: resized (finger grows, Pencil shrinks) ${JSON.stringify(r)}`);
      }
    }
  } finally { await ctx.close(); }
});
