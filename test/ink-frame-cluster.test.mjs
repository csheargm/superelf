// A word that crosses onto another verse line stays one word on another width (PAInkFrame.clusterOf /
// shiftClusters, web/ink-frame.inline.html). SCAR (owner, 2026-11-22): written on the iPad in landscape,
// the dot of an "i" fell on the next line; turned to portrait the two lines moved apart and so did the
// word. The first fix (fc2940c, reverted by 7fe85a8) regrouped ink at read time and CHANGED how the
// original landscape writing looked. So the invariants here, each tested against the 7fe85a8 engine:
//   1. at the width the ink was written, every placement and every drawn point equals 7fe85a8's;
//   2. stored records are never rewritten; new records only ADD {bid, rel, ww};
//   3. only on another width may strokes move, and the strokes of one word move together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT, ENG_INK } from './helpers-app.mjs';
import { PADL, makeDom, penStroke } from './helpers-ink-dom.mjs';

const REF = '7fe85a8';   // the engine the owner accepted for landscape writing
const gitShow = (rev, p) => execFileSync('git', ['show', `${rev}:${p}`], { cwd: ROOT, encoding: 'utf8' });
const REF_SRC = gitShow(REF, 'web/ink-anchor.inline.html'), REF_FRAME = gitShow(REF, 'web/ink-frame.inline.html');
const TEXT = 'But now, having died to what bound us, we have been released from the law';
const ZH = '但我们既然在捆我们的律法上死了';
const W0 = 1024;   // the landscape width the ink is written at: colW = W0 - 2*PADL

function open(width, ref) {
  const log = [];
  const ink = { ...ENG_INK, drawStroke: (ctx, pts, c, w, t, a) => log.push({ pts: pts.map((p) => [p.x, p.y]), c, w, t, a }) };
  const dom = makeDom({ width, ...(ref ? { src: REF_SRC, frame: REF_FRAME } : {}) });
  const v = dom.addVerse(6, TEXT, ZH);
  dom.addVerse(7, 'For we know that the law is spiritual', '我们原晓得律法是属乎灵的');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink });
  return { dom, v, I, log, Frame: dom.window.PAInkFrame };
}
function letter(dom, x, y, id) {
  const pts = [[x, y], [x + 5, y + 10], [x + 10, y]];
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: pts[0][0], clientY: pts[0][1], pressure: 0.5 }));
  for (const [cx, cy] of pts.slice(1)) dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: cx, clientY: cy, pressure: 0.5 }));
  dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: pts[2][0], clientY: pts[2][1] }));
}
const setWidth = (dom, w) => { dom.L.width = w; dom.fire('w:resize', dom.ev('resize')); dom.flush(); };
// What a reader sees: every placement and every drawn stroke (points, width), from the drawing stub.
function view(o) {
  o.log.length = 0; o.I.reflow();
  const at = o.I.placements().map((p) => p.at);
  assert.ok(at.length > 0 && at.every((a) => a), 'something is placed and nothing is lost');
  assert.ok(o.log.length > 0, 'something is drawn');
  return { at, drawn: o.log.slice() };
}
// F3: a word across two lines — two letters over the end of v6 en (past its text), then the dot of its
// "i" just under them, on v6 zh. Then two more letters on v6 zh after the dot (the word continues there).
function writeF3(dom, v) {
  letter(dom, PADL + 790, v.en.top + 6, 1); letter(dom, PADL + 802, v.en.top + 6, 2);
  letter(dom, PADL + 804, v.zh.top + 1, 3); letter(dom, PADL + 816, v.zh.top + 1, 4);
}
// F4: the same strokes but the piece on v6 zh is far from the last (not one word).
function writeF4(dom, v) { letter(dom, PADL + 790, v.en.top + 6, 1); letter(dom, PADL + 900, v.zh.top + 1, 2); }
// F2: an old line-frame note, written on the 7fe85a8 engine (no bid/rel/ww).
function oldLineNote() {
  const o = open(W0, true);
  for (let i = 0; i < 12; i++) letter(o.dom, PADL + 790 + i * 12, o.v.en.top + 6, 10 + i);
  letter(o.dom, PADL + 804, o.v.zh.top + 1, 40);   // the old split case: the dot on the next line
  return o.I.groups();
}
// F1: an old word-pinned note: underlines on words and a letter-piece record.
function oldWordNote() {
  const o = open(W0, true);
  penStroke(o.dom, o.v.en, 9, 15, 1); penStroke(o.dom, o.v.en, 52, 60, 2);
  const st = { p: [[0, 0, 0.5], [5, 10, 0.5], [10, 0, 0.5]], c: '#2f6fed', w: 2.2, t: 'pen' };
  return o.I.groups().concat([{ verse: 6, lang: 'en', charStart: 40, charEnd: 41, quote: TEXT[40], dx: 0, dy: 2, w: 10, strokes: [st] }]);
}
const written = (fn) => { const o = open(W0); fn(o.dom, o.v); return o.I.groups(); };
const both = (recs, w) => [false, true].map((ref) => { const o = open(w, ref); o.I.load(recs); return view(o); });
const strip = (g) => { const { bid, rel, ww, ...r } = g; return r; };

test('identity at the written width: old and new notes draw exactly as on 7fe85a8 (placements and every point)', () => {
  const F3 = written(writeF3), F4 = written(writeF4);
  assert.ok(F3.some((g) => g.rel), 'F3 really is a tagged cross-line word (else this test proves nothing)');
  for (const [name, recs] of [['F1', oldWordNote()], ['F2', oldLineNote()], ['F3', F3], ['F4', F4]]) {
    const [now, ref] = both(recs, W0);
    assert.deepStrictEqual(now, ref, name);
  }
});

test('old notes (no bid/rel/ww) draw exactly as on 7fe85a8 at every width', () => {
  for (const recs of [oldWordNote(), oldLineNote()]) for (const w of [600, 768, 834, 1024]) {
    const [now, ref] = both(recs, w);
    assert.deepStrictEqual(now, ref, `width ${w}`);
  }
});

test('portrait: the strokes of the cross-line word keep their written offsets from the anchor', () => {
  const F3 = written(writeF3), o = open(600); o.I.load(F3);
  const pl = o.I.placements(), a = pl.find((p) => p.g.bid != null && !p.g.rel);
  const members = pl.filter((p) => p.g.rel);
  assert.equal(members.length, 2, 'the dot and the letter after it are on the anchor\'s word');
  for (const m of members) {
    const [rx, ry, rk] = m.g.rel;
    assert.ok(Math.abs((m.at.ox - a.at.ox) - rx * a.at.s) <= 0.5 && Math.abs((m.at.oy - a.at.oy) - ry * a.at.s) <= 0.5, 'offset kept');
    assert.equal(m.at.s, a.at.s * rk);
  }
  // CONTROL (R14): the 7fe85a8 engine at 600 really splits this word (the bug), by more than 10px.
  const r = open(600, true); r.I.load(F3);
  const rp = r.I.placements(), ra = rp.find((p) => p.g === a.g).at;
  const off = rp.filter((p) => p.g.rel).map((p) => Math.hypot(p.at.ox - (ra.ox + p.g.rel[0] * ra.s), p.at.oy - (ra.oy + p.g.rel[1] * ra.s)));
  assert.ok(off.every((d) => d > 10), `the old engine splits the word (${off.map((d) => d.toFixed(1))})`);
});

test('no false merge: separate writing on adjacent lines is not tagged and draws as on 7fe85a8 at 600', () => {
  const F4 = written(writeF4);
  assert.ok(F4.every((g) => g.bid == null && g.rel == null), 'not one word');
  const [now, ref] = both(F4, 600);
  assert.deepStrictEqual(now, ref);
});

test('save is additive: the same pen events give the 7fe85a8 records plus only {bid, rel, ww}', () => {
  for (const fn of [writeF3, writeF4]) {
    const a = open(W0), b = open(W0, true); fn(a.dom, a.v); fn(b.dom, b.v);
    assert.deepStrictEqual(a.I.groups().map(strip), b.I.groups());
    assert.ok(a.I.groups().every((g) => g.ww === W0 - 2 * PADL), 'every new pen record carries its written column');
  }
  const F3 = written(writeF3);
  assert.deepStrictEqual(F3.map((g) => [g.verse + g.lang, g.bid != null, !!g.rel]), [['6en', false, false], ['6en', true, false], ['6zh', true, true], ['6zh', true, true]]);
});

test('no rewrite: load + reflow at five widths leaves the stored records byte-identical and saves nothing', () => {
  const recs = written(writeF3).concat(oldWordNote());
  let saves = 0;
  const dom = makeDom({ width: W0 }); dom.addVerse(6, TEXT, ZH); dom.addVerse(7, 'x', 'y');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK, onChange: () => saves++ });
  const json = JSON.stringify(dom.PAInkAnchor.pack(recs));
  I.load(JSON.parse(json));
  for (const w of [600, 834, 390, 1366, W0]) setWidth(dom, w);
  assert.equal(JSON.stringify(dom.PAInkAnchor.pack(I.groups())), json);
  assert.equal(saves, 0);
});

test('gate: within 1px of the written column the placement list comes back untouched; 2px off, the cluster is re-placed', () => {
  const F3 = written(writeF3);
  for (const w of [W0 - 1, W0 + 1]) { const [now, ref] = both(F3, w); assert.deepStrictEqual(now, ref, `width ${w}`); }
  // pure: the same array object comes back when nothing changed width
  const o = open(W0); o.I.load(F3);
  const placed = F3.map((g, i) => ({ g, at: { ox: i, oy: i, s: 1 }, orphan: false }));
  const env = (cw) => ({ lineEl: () => ({ getBoundingClientRect: () => ({}) }), local: (r) => r, colW: () => cw });
  assert.equal(o.Frame.shiftClusters(placed, env(W0 - 2 * PADL + 1)), placed);
  assert.notEqual(o.Frame.shiftClusters(placed, env(W0 - 2 * PADL + 2)), placed);
});

// ── GPT round 1 regressions (df0b443) ──
const stubEnv = (cw, left = 0) => ({ lineEl: () => ({ getBoundingClientRect: () => ({ left, top: 0 }) }), local: (r) => r, colW: () => cw });
const st1 = { p: [[0, 0, 0.5], [10, 10, 0.5]], c: '#000', w: 2, t: 'pen' };
const rec = (lang, o) => ({ verse: 6, lang, frame: 'line', fx: 0, fy: 0, fw: 1000, strokes: [st1], ww: 1000, bid: 7, ...o });

test('right edge: a cluster pushed past the narrow column moves left as one unit, offsets kept', () => {
  const o = open(W0);
  const a = { g: rec('en', {}), at: { ox: 590, oy: 0, s: 1 } }, m = { g: rec('zh', { rel: [20, 30, 1] }), at: { ox: 0, oy: 99, s: 1 } };
  const out = o.Frame.shiftClusters([a, m], stubEnv(600));
  const right = Math.max(...out.map((p) => p.at.ox + 10 * p.at.s));
  assert.ok(right <= 600, `inside the column (right edge ${right})`);
  assert.equal(out[1].at.ox - out[0].at.ox, 20); assert.equal(out[1].at.oy - out[0].at.oy, 30);
  // CONTROL: without the pull-back the member would be at 610 + 10 = 620 > 600
  assert.ok(590 + 20 + 10 > 600);
});

test('resize mid-word: the gate is the anchor\'s ww; a stroke written on another column is not a member', () => {
  const o = open(W0);
  const a = { g: rec('en', {}), at: { ox: 100, oy: 0, s: 1 } };
  const m = { g: rec('zh', { rel: [5, 30, 1], ww: 816 }), at: { ox: 852.38, oy: 40, s: 1 } };
  const placed = [a, m];
  assert.equal(o.Frame.shiftClusters(placed, stubEnv(1000)), placed, 'at the anchor\'s width nothing moves');
  const out = o.Frame.shiftClusters(placed, stubEnv(600));
  assert.deepStrictEqual(out[1].at, m.at, 'the other-column stroke keeps the 7fe85a8 placement');
  // end to end: write across a resize, back at W0 the drawing equals 7fe85a8
  const e = open(W0); letter(e.dom, PADL + 790, e.v.en.top + 6, 1); letter(e.dom, PADL + 802, e.v.en.top + 6, 2);
  setWidth(e.dom, 840); letter(e.dom, PADL + 600, e.v.zh.top + 1, 3); setWidth(e.dom, W0);
  const recs = e.I.groups();
  assert.ok(new Set(recs.map((g) => g.ww)).size > 1, 'the strokes really carry two columns');
  const [now, ref] = both(recs, W0); assert.deepStrictEqual(now, ref);
});

test('erased anchor: the member with the smallest rel stands in, the word stays together', () => {
  const o = open(W0);
  const m1 = { g: rec('zh', { rel: [10, 30, 1] }), at: { ox: 300, oy: 80, s: 1 } };
  const m2 = { g: rec('en', { rel: [25, 30, 1] }), at: { ox: 0, oy: 120, s: 1 } };
  const out = o.Frame.shiftClusters([m1, m2], stubEnv(600));
  assert.deepStrictEqual(out[0].at, m1.at, 'the stand-in keeps its place');
  assert.deepStrictEqual(out[1].at, { ox: 315, oy: 80, s: 1 }, 'the other keeps its offset from it');
  // CONTROL: with only one rel-member left nothing is re-placed (no false anchor)
  const one = [m1]; assert.equal(o.Frame.shiftClusters(one, stubEnv(600)), one);
});
