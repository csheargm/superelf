// Owner 2026-11-13/15: in the Bible the Apple Pencil writes; it must never select a verse, tint one, or open Ask AI.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const SRC = fs.readFileSync(new URL('../workspace/apps/bible/index.html', import.meta.url), 'utf8');
const block = SRC.slice(SRC.indexOf(';let _penPress=false;'), SRC.indexOf('loadGen(); load()'));

function run({ inkStopsPen = true, src = block } = {}) {
  const h = {}, doc = {}, win = {}; let timers = 0, clock = 10000, asks = 0, ranges = 0; const selected = [], later = [], lp = [];
  const cls = new Set(), verse = { dataset: { n: '3' }, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  const wrap = { addEventListener: (t, f) => { h[t] = f; }, contains: () => true };
  const sel = { get rangeCount() { return ranges; }, removeAllRanges() { ranges = 0; } };
  const ctx = { document: { getElementById: () => wrap, addEventListener: (t, f) => { doc[t] = f; } },
    window: { addEventListener: (t, f) => { const prev = win[t]; win[t] = prev ? (e) => { prev(e); f(e); } : f; }, getSelection: () => sel },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { if (ms === 500) { timers++; lp.push(fn); } else later.push(fn); return 1; },
    lpCancel() {}, _lpFired: false, _lpTimer: null, _lpX: 0, _lpY: 0, LONG_PRESS_MS: 500, LONG_PRESS_SLOP: 10, longPressVerse() { asks++; } };
  vm.runInNewContext(src.replace(';let _penPress', 'var _penPress'), ctx);
  const down = (pointerType, pointerId = 1) => { const e = { target: { closest: () => verse }, pointerType, pointerId, clientX: 0, clientY: 0 };
    doc.pointerdown(e); if (!(inkStopsPen && pointerType === 'pen')) h.pointerdown(e); };   // the ink layer stops a Pencil down at #verses
  const up = (pointerType, pointerId = 1) => { win.pointerup({ pointerType, pointerId, target: verse });
    let stopped = false; h.click({ stopPropagation() { stopped = true; }, preventDefault() {} });
    if (!stopped) selected.push(3); later.splice(0).forEach((f) => f()); };
  const hold = (ms) => { clock += ms; if (ms >= 500) lp.splice(0).forEach((f) => f()); };   // the 500 ms timer fires
  const select = () => { ranges = 1; doc.selectionchange(); return ranges; };
  const touchstart = (touches, changed) => { let prevented = false;
    h.touchstart({ touches, changedTouches: changed, preventDefault() { prevented = true; } }); return prevented; };
  const selectstart = () => { let p = false; doc.selectstart({ target: verse, preventDefault() { p = true; } }); return p; };
  return { down, up, hold, select, touchstart, selectstart, press: (t) => { down(t); up(t); }, timers: () => timers, asks: () => asks,
    selected, tinted: () => cls.has('press'), move: (e) => doc.pointermove(e), wait: (ms) => { clock += ms; } };
}
test('a Pencil press starts no long-press and its click never reaches the verse (ink layer stops the down)', () => {
  const r = run(); r.press('pen'); assert.equal(r.timers(), 0); assert.deepEqual(r.selected, []);
});
test('same when the down does reach the verse list', () => {
  const r = run({ inkStopsPen: false }); r.press('pen'); assert.equal(r.timers(), 0); assert.deepEqual(r.selected, []);
});
test('a Pencil press never tints the verse; a finger press tints it until lift', () => {
  const r = run(); r.down('pen'); assert.equal(r.tinted(), false); r.up('pen'); r.wait(700);
  r.down('touch'); assert.equal(r.tinted(), true); r.up('touch'); assert.equal(r.tinted(), false);
});
test('the tint is a JS class, never CSS :active (Safari lights :active for the Pencil before any event)', () => {
  assert.match(SRC, /\n\.verse\.press\{/);
  assert.doesNotMatch(SRC, /\.verse:active/);
});
test('a finger press still long-presses and selects', () => {
  const r = run(); r.press('touch'); assert.equal(r.timers(), 1); assert.deepEqual(r.selected, [3]);
});
test('a finger after the Pencil is not swallowed', () => {
  const r = run(); r.press('pen'); r.wait(700); r.press('touch'); assert.deepEqual(r.selected, [3]);
});

// ═══ palm rejection (owner 2026-11-22): the side of the writing hand is a FINGER to iPad ═══
test('a palm resting while the Pencil is down: no long-press, no Ask AI, no tint, its lift selects nothing', () => {
  const r = run(); r.down('pen', 9); r.down('touch', 2); r.hold(700);
  assert.equal(r.timers(), 0); assert.equal(r.asks(), 0); assert.equal(r.tinted(), false);
  r.up('touch', 2); assert.deepEqual(r.selected, []);
});
test('a palm landing just after the Pencil lifts (inside the window) is still a palm', () => {
  const r = run(); r.press('pen'); r.wait(300); r.down('touch', 2); r.hold(700);
  assert.equal(r.asks(), 0); r.up('touch', 2); assert.deepEqual(r.selected, []);
});
test('late Pencil: palm first, Pencil 200 ms later — the held palm never asks', () => {
  const r = run(); r.down('touch', 2); r.wait(200); r.down('pen', 9); r.hold(700);
  assert.equal(r.asks(), 0);
});
test('a second finger down (two-finger scroll) never long-presses', () => {
  const r = run(); r.down('touch', 2); r.down('touch', 3); r.hold(700); assert.equal(r.asks(), 0);
});
test('no Pencil for a while: a deliberate finger hold still asks AI and its selection survives', () => {
  const r = run(); r.press('pen'); r.wait(1200); r.down('touch', 2); r.hold(600);
  assert.equal(r.asks(), 1); assert.equal(r.select(), 1, 'selection kept'); assert.equal(r.selectstart(), false);
});
test('a word selection inside the palm window is blocked and cleared', () => {
  const r = run(); r.down('pen', 9); r.wait(100);
  assert.equal(r.selectstart(), true, 'selectstart cancelled'); assert.equal(r.select(), 0, 'selection cleared');
  r.up('pen', 9); r.wait(300); assert.equal(r.select(), 0, 'still inside the window after lift');
});
test('touchstart: a finger joining a stylus is cancelled; a lone finger (link tap, scroll, swipe) is not', () => {
  const r = run(); const pen = { touchType: 'stylus' }, finger = { touchType: 'direct' };
  assert.equal(r.touchstart([pen, finger], [finger]), true);
  assert.equal(r.touchstart([finger], [finger]), false);
  assert.equal(r.touchstart([pen], [pen]), false, 'the Pencil itself is left to the ink layer');
});
test('mutation control (R14): without the palm guard the resting palm asks AI', () => {
  const src = block.replace('const palmGuard=()=>', 'const palmGuard=()=>false, _off=()=>');
  assert.notEqual(src, block);
  const r = run({ src }); r.down('pen', 9); r.up('pen', 9); r.wait(100); r.down('touch', 2); r.hold(700); assert.equal(r.asks(), 1);
});

// GPT review blocking 1: palm FIRST, Pencil second (the common writing posture).
test('palm first, then Pencil: the resting palm loses its tint, its selection, and its lift-click', () => {
  const r = run(); r.wait(2000); r.down('touch', 2); assert.equal(r.tinted(), true);
  r.wait(500); r.down('pen', 9);
  assert.equal(r.tinted(), false, 'tint removed'); assert.equal(r.select(), 0, 'selection cleared');
  r.up('pen', 9); r.wait(2000);
  assert.equal(r.select(), 0, 'palm still held after the window: still cleared');
  r.up('touch', 2); assert.deepEqual(r.selected, [], 'palm lift-click swallowed');
});
// GPT review blocking 2: Pencil hover must not lock out finger taps.
test('Pencil hover (no contact) does not swallow a finger tap or a deliberate hold', () => {
  const r = run(); r.wait(2000); r.move({ pointerType: 'pen', buttons: 0, pressure: 0 });
  r.down('touch', 2); r.hold(600); assert.equal(r.asks(), 1);
  r.up('touch', 2); assert.deepEqual(r.selected, [3]);
});
test('Pencil drag ON the glass still refreshes the palm window', () => {
  const r = run(); r.wait(2000); r.move({ pointerType: 'pen', buttons: 1, pressure: 0.5 });
  r.down('touch', 2); r.hold(700); assert.equal(r.asks(), 0);
});
