// PAWin — the panel windows' pure geometry, snap targets, persistence migration · 面板窗口的几何与布局
// The drag / dock / resize / minimise flows run in a real browser: test/panel-window-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'web', 'panel-window.inline.html'), 'utf8');
const JS = /<script id="paw-script">([\s\S]*?)<\/script>/.exec(SRC)[1];
function load() {
  const win = { innerWidth: 1230, innerHeight: 1056, addEventListener() {} };
  new Function('window', 'document', JS)(win, { documentElement: {} });
  return win.PAWin;
}
const W = load(), G = W.geo;
const st = (o) => ({ key: 'k', open: true, min: false, max: false, mode: 'dock', where: 'right', size: { right: 0.34, left: 0.34, top: 0.5, bottom: 0.5 }, rect: null, ...o });

test('R14 control: the component loads and its geometry can fail', () => {
  assert.equal(typeof G.layout, 'function');
  assert.notDeepEqual(G.layout([st()], 1000, 800).rects.k, { x: 0, y: 0, w: 1000, h: 800 });
});

test('snap targets: corners (48px) win over edges (32px); the middle is no target', () => {
  const vw = 1230, vh = 1056;
  assert.equal(G.snapAt(vw - 10, 10, vw, vh), 'tr');
  assert.equal(G.snapAt(vw - 10, vh - 10, vw, vh), 'br');
  assert.equal(G.snapAt(vw - 20, 500, vw, vh), 'right');
  assert.equal(G.snapAt(10, 500, vw, vh), 'left');
  assert.equal(G.snapAt(600, 10, vw, vh), 'top');
  assert.equal(G.snapAt(600, vh - 10, vw, vh), 'bottom');
  assert.equal(G.snapAt(600, 500, vw, vh), null);
  assert.equal(G.snapAt(vw - G.EDGE - 1, 500, vw, vh), null, 'just outside the edge band');
});

test('docked sides push the page and take the full height; top/bottom span between them', () => {
  const { rects, push } = G.layout([st({ key: 'a' }), st({ key: 'b', where: 'bottom' })], 1000, 800);
  assert.deepEqual(rects.a, { x: 660, y: 0, w: 340, h: 800 });
  assert.equal(push.right, 340); assert.equal(push.bottom, 400);
  assert.deepEqual(rects.b, { x: 0, y: 400, w: 660, h: 400 }, 'the bottom dock stops at the right dock');
});

test('two windows on one edge share it; corners and floats push nothing', () => {
  const { rects, push } = G.layout([st({ key: 'a' }), st({ key: 'b' }), st({ key: 'c', where: 'tr' }), st({ key: 'd', mode: 'float', rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.4 } })], 1000, 800);
  assert.equal(rects.a.h, 400); assert.equal(rects.b.y, 400);
  assert.deepEqual(rects.c, { x: 660, y: 0, w: 340, h: 400 });
  assert.deepEqual(rects.d, { x: 100, y: 80, w: 300, h: 320 });
  assert.equal(push.right, 340, 'only the docked pair pushes');
});

test('minimised and closed windows take no space; maximised fills the viewport and pushes nothing', () => {
  const { rects, push } = G.layout([st({ key: 'a', min: true }), st({ key: 'b', open: false }), st({ key: 'c', max: true })], 1000, 800);
  assert.equal(rects.a, undefined); assert.equal(rects.b, undefined);
  assert.deepEqual(rects.c, { x: 0, y: 0, w: 1000, h: 800 });
  assert.deepEqual(push, { right: 0, left: 0, top: 0, bottom: 0 });
});

test('sizes are clamped: sides 0.24–0.60, top/bottom 0.25–0.75; floats keep 280x200 and stay on screen', () => {
  assert.equal(G.clampSize('right', 0.9), 0.6); assert.equal(G.clampSize('left', 0.1), 0.24);
  assert.equal(G.clampSize('top', 0.9), 0.75); assert.equal(G.clampSize('bottom', 'x'), 0.5);
  assert.deepEqual(G.clampRect({ x: -50, y: 900, w: 100, h: 50 }, 1000, 800), { x: 0, y: 600, w: 280, h: 200 });
  assert.deepEqual(G.clampRect({ x: 900, y: 0, w: 2000, h: 300 }, 1000, 800), { x: 0, y: 0, w: 1000, h: 300 });
});

test('a float stored as ratios refits after rotation', () => {
  const s = st({ mode: 'float', rect: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 } });
  const land = G.layout([s], 1180, 820).rects.k, port = G.layout([s], 820, 1180).rects.k;
  assert.ok(land.x + land.w <= 1180 && port.x + port.w <= 820 && port.y + port.h <= 1180);
});

test('device class: phone under 600px short side, tablet for a coarse pointer, else desktop', () => {
  assert.equal(G.deviceClass(390, 844, true), 'phone');
  assert.equal(G.deviceClass(1180, 820, true), 'tablet');
  assert.equal(G.deviceClass(1230, 1056, false), 'desktop');
});

test('the old account-wide paneLayout migrates once into the current device class', () => {
  const out = G.migrate({ chat: { mode: 'floating', rect: { x: 100, y: 80, w: 400, h: 400 } }, note: { mode: 'max' }, x: null }, 'desktop', 1000, 800);
  assert.deepEqual(out.desktop.chat, { mode: 'float', rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 } });
  assert.deepEqual(out.desktop.note, { mode: 'dock', max: true });
  assert.deepEqual(G.migrate(null, 'desktop', 1, 1), {});
});

test('every control is labelled 中文 first, then English, for a newcomer', () => {
  for (const k of ['min', 'max', 'restore', 'close', 'tip']) assert.match(W.LABELS[k], /^[一-鿿].* · [A-Z]/, `${k}: ${W.LABELS[k]}`);
  assert.doesNotMatch(SRC, /[⤓⤒⤢⧉⇲]/, 'the old confusing glyphs are gone');
});

test('no client-side storage — it throws at the app frame\'s opaque origin', () => {
  assert.doesNotMatch(JS, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});
