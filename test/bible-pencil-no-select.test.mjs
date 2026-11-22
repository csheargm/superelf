// Owner 2026-11-13/15: in the Bible the Apple Pencil writes; it must never select a verse, tint one, or open Ask AI.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const SRC = fs.readFileSync(new URL('../workspace/apps/bible/index.html', import.meta.url), 'utf8');
const block = SRC.slice(SRC.indexOf(';let _penPress=false;'), SRC.indexOf('loadGen(); load()'));

function run({ inkStopsPen = true } = {}) {
  const h = {}, doc = {}, win = {}; let timers = 0; const selected = [], later = [];
  const cls = new Set(), verse = { dataset: { n: '3' }, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  const wrap = { addEventListener: (t, f) => { h[t] = f; }, contains: () => true };
  const ctx = { document: { getElementById: () => wrap, addEventListener: (t, f) => { doc[t] = f; } },
    window: { addEventListener: (t, f) => { win[t] = f; } },
    setTimeout: (fn, ms) => { if (ms === 500) timers++; else later.push(fn); return 1; },
    lpCancel() {}, _lpFired: false, _lpTimer: null, _lpX: 0, _lpY: 0, LONG_PRESS_MS: 500, LONG_PRESS_SLOP: 10, longPressVerse() {} };
  vm.runInNewContext(block.replace(';let _penPress', 'var _penPress'), ctx);
  const down = (pointerType) => { const e = { target: { closest: () => verse }, pointerType, clientX: 0, clientY: 0 };
    doc.pointerdown(e); if (!(inkStopsPen && pointerType === 'pen')) h.pointerdown(e); };   // the ink layer stops a Pencil down at #verses
  const up = (pointerType) => { win.pointerup({ pointerType, target: verse });
    let stopped = false; h.click({ stopPropagation() { stopped = true; }, preventDefault() {} });
    if (!stopped) selected.push(3); later.splice(0).forEach((f) => f()); };
  return { down, up, press: (t) => { down(t); up(t); }, timers: () => timers, selected, tinted: () => cls.has('press') };
}
test('a Pencil press starts no long-press and its click never reaches the verse (ink layer stops the down)', () => {
  const r = run(); r.press('pen'); assert.equal(r.timers(), 0); assert.deepEqual(r.selected, []);
});
test('same when the down does reach the verse list', () => {
  const r = run({ inkStopsPen: false }); r.press('pen'); assert.equal(r.timers(), 0); assert.deepEqual(r.selected, []);
});
test('a Pencil press never tints the verse; a finger press tints it until lift', () => {
  const r = run(); r.down('pen'); assert.equal(r.tinted(), false); r.up('pen');
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
  const r = run(); r.press('pen'); r.press('touch'); assert.deepEqual(r.selected, [3]);
});
