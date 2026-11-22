// One handwritten word, one frame (web/ink-frame.inline.html: joinsBurst + rehost). SCAR (owner, iPad Pro
// 11", Romans 7:5-6, landscape -> portrait, 2026-11-22, after 1a654f7): a Chinese sentence written in the
// gap between v5's Chinese line and v6's English line came apart in portrait — each stroke had picked its
// own line, so a dot just inside v6en's box rode on v6en's frame while its character rode on v5zh's, and
// when v5zh gained a row the dots were left one row away, in a line of stray pieces.
// Runs the shipped components on the fake layout DOM (helpers-ink-dom) at the 11" widths 1194 and 834.
// CONTROLS: a circle around v5zh still follows v5zh alone; writing well inside v6en stays on v6en.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENG_INK } from './helpers-app.mjs';
import { RH, PADL, makeDom } from './helpers-ink-dom.mjs';

const EN5 = 'For when we lived according to the flesh, the sinful passions aroused by the law were at work in our bodies, bearing fruit for death.';
const ZH5 = '因为我们属肉体的时候，那因律法而生的恶欲就在我们肢体中发动，以致结成死亡的果子。';
const EN6 = 'But now, having died to what bound us, we have been released from the law, so that we serve in the new way of the Spirit, and not in the old way of the written code.';
const ZH6 = '但我们既然在捆我们的律法上死了，现今就脱离了律法，叫我们服事主，要按着心灵的新样，不按着仪文的旧样。';
const LANDSCAPE = 1194, PORTRAIT = 834, CHAR_W = 21;

function page(width = LANDSCAPE) {
  const dom = makeDom({ width }); dom.L.cw = CHAR_W;
  const v5 = dom.addVerse(5, EN5, ZH5), v6 = dom.addVerse(6, EN6, ZH6);
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  return { dom, v5, v6, I, clock: { now: 1e6 } };
}
function stroke(P, pts, id, dt) {
  P.clock.now += dt; const real = Date.now; Date.now = () => P.clock.now;
  try {
    const { dom } = P;
    dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: pts[0][0], clientY: pts[0][1], pressure: 0.5 }));
    for (const [x, y] of pts.slice(1)) dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: x, clientY: y, pressure: 0.5 }));
    dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: pts.at(-1)[0], clientY: pts.at(-1)[1] }));
  } finally { Date.now = real; }
}
// Six characters in the gap under v5zh, each one's top 6px inside v5zh's last row and its lower dot
// inside v6en's box: a top dash, a tall vertical, an upper dot, a lower dot (tiny strokes on a boundary).
function writeGapSentence(P, dtWithin, dtBetween) {
  const zb = P.v5.zh.top + P.v5.zh.getBoundingClientRect().height; let id = 1;
  for (let c = 0; c < 6; c++) {
    const x = PADL + 500 + c * 28, top = zb - 6;
    stroke(P, [[x, top + 4], [x + 18, top + 4]], id++, c ? dtBetween : 0);
    stroke(P, [[x + 9, top], [x + 9, top + 22]], id++, dtWithin);
    stroke(P, [[x + 3, top + 12], [x + 4, top + 13]], id++, dtWithin);
    stroke(P, [[x + 14, top + 30], [x + 15, top + 31]], id++, dtWithin);
  }
}
const at = (I) => I.placements().map((p) => p.at);
const setWidth = (P, w) => { P.dom.L.width = w; P.dom.fire('w:resize', P.dom.ev('resize')); P.dom.flush(); };
// How far apart sibling strokes drift: the spread of their moves (0 = the word moved as one block).
function drift(before, after) {
  const mv = after.map((a, i) => [a.ox - before[i].ox, a.oy - before[i].oy]);
  const span = (k) => Math.max(...mv.map((m) => m[k])) - Math.min(...mv.map((m) => m[k]));
  return { dx: span(0), dy: span(1), move: mv[0], scales: new Set(after.map((a) => a.s)).size };
}

for (const [name, within, between] of [['fast writing', 200, 600], ['written with pauses', 200, 2000], ['every stroke after a pause', 2000, 2000]]) {
  test(`landscape -> portrait: every stroke of the gap sentence moves as one block (${name})`, () => {
    const P = page(); writeGapSentence(P, within, between);
    assert.equal(P.I.groups().length, 24);
    const before = at(P.I); setWidth(P, PORTRAIT);
    const d = drift(before, at(P.I));
    assert.equal(P.v5.zh.getBoundingClientRect().height, 2 * RH, 'v5zh gained a row in portrait (the move that split the word)');
    assert.deepEqual([d.dx, d.dy, d.scales], [0, 0, 1], `siblings drift ${d.dx},${d.dy} px`);
    setWidth(P, LANDSCAPE);
    assert.deepEqual(at(P.I), before, 'and back in landscape it is where it was written');
  });
}

test('fast writing: the boundary dots are STORED on their word\'s line (one frame per word)', () => {
  const P = page(); writeGapSentence(P, 200, 600);
  assert.deepEqual([...new Set(P.I.groups().map((g) => `${g.frame}:${g.verse}${g.lang}`))], ['line:5zh']);
});

test('old notes split across two lines (as 1a654f7 stored them) are read together, never rewritten', () => {
  const P = page(); writeGapSentence(P, 200, 600);
  // the 1a654f7 shape: every lower dot on v6en's frame (fy re-expressed from v6en's top-left)
  const shift = P.v6.en.top - P.v5.zh.top;
  const old = P.I.groups().map((g, i) => (i % 4 === 3 ? { ...g, verse: 6, lang: 'en', fy: Math.round((g.fy - shift) * 100) / 100 } : g));
  const Q = page(); Q.I.load(old); const stored = JSON.stringify(Q.I.groups());
  const before = at(Q.I); setWidth(Q, PORTRAIT);
  const d = drift(before, at(Q.I));
  assert.deepEqual([d.dx, d.dy, d.scales], [0, 0, 1], `old split note drifts ${d.dx},${d.dy} px`);
  assert.equal(JSON.stringify(Q.I.groups()), stored, 'records untouched');
});

test('CONTROLS: a circle around v5zh follows v5zh; writing inside v6en stays on v6en', () => {
  const P = page(); const r = P.v5.zh.getBoundingClientRect(), e = P.v6.en.getBoundingClientRect();
  const circle = []; for (let a = 0; a <= 360; a += 30) circle.push([r.left + r.width / 2 + Math.cos(a * Math.PI / 180) * (r.width / 2 + 6), r.top + r.height / 2 + Math.sin(a * Math.PI / 180) * (r.height / 2 + 4)]);
  stroke(P, circle, 1, 0);
  for (let i = 0; i < 4; i++) stroke(P, [[PADL + 40 + i * 12, e.top + 30], [PADL + 45 + i * 12, e.top + 40], [PADL + 50 + i * 12, e.top + 30]], 2 + i, 200);
  const before = at(P.I), zhTop = P.v5.zh.top, enTop = P.v6.en.top; setWidth(P, PORTRAIT);
  const after = at(P.I);
  assert.equal(Math.round(after[0].oy - before[0].oy), P.v5.zh.top - zhTop, 'the circle moves with v5zh');
  for (let i = 1; i < 5; i++) assert.equal(Math.round(after[i].oy - before[i].oy), P.v6.en.top - enTop, 'the v6en writing moves with v6en');
  assert.notEqual(P.v5.zh.top - zhTop, P.v6.en.top - enTop, 'the two lines really moved by different amounts');
});

test('pure: rehost moves a tiny dot on a boundary onto its word\'s line by the lines\' offset at the written width', () => {
  const Fr = makeDom().window.PAInkFrame;
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  const rect = { a: { left: 0, top: 0, height: 24 }, b: { left: 0, top: 30, height: 24 }, c: { left: 0, top: 60, height: 24 } };
  const env = { lineEls: () => [a, b, c].map((el) => ({ el })), local: (r) => r, heightAt: (el, w) => (w === 500 ? 48 : rect[el.id].height) };
  for (const el of [a, b, c]) el.getBoundingClientRect = () => rect[el.id];
  const ext = { w: 10, h: 10 }, big = { w: 200, h: 30 };
  const items = [
    { el: a, k: 'a', fx: 100, fy: 40, ext, small: true, w: 500 }, { el: a, k: 'a', fx: 112, fy: 40, ext, small: true, w: 500 },
    { el: b, k: 'b', fx: 100, fy: -2, ext, small: true, w: 500 },     // 6px below the a-pieces at width 500 (a is 48 tall there + gap 6)
    { el: b, k: 'b', fx: 400, fy: 0, ext, small: true, w: 500 },      // far away: its own word
    { el: b, k: 'b', fx: 100, fy: -2, ext: big, small: false, w: 500 },   // a big mark is never moved
    { el: c, k: 'c', fx: 100, fy: -50, ext, small: true, w: 900 },    // written at another width: not linked
  ];
  Fr.rehost(items, env);
  assert.deepEqual([items[2].k, items[2].fx, items[2].fy], ['a', 100, 52], 'onto a, by a\'s height at 500 (48) + gap (6)');
  assert.deepEqual([items[3].k, items[4].k, items[5].k], ['b', 'b', 'c']);
  // the upper line hosts even when the lower holds more pieces: erasing one never flips the host (GPT review)
  const two = [{ el: a, k: 'a', fx: 100, fy: 40, ext, small: true, w: 500 }, { el: b, k: 'b', fx: 100, fy: -2, ext, small: true, w: 500 }, { el: b, k: 'b', fx: 112, fy: -2, ext, small: true, w: 500 }];
  Fr.rehost(two, env);
  assert.deepEqual(two.map((x) => x.k), ['a', 'a', 'a']);
});

test('a quick underline on English words and a mark on the Chinese words below stay two marks on their own lines (GPT review)', () => {
  const P = page(); const e = P.v5.en.getBoundingClientRect(), z = P.v5.zh.getBoundingClientRect();
  const yu = e.top + e.height - 4; stroke(P, [[PADL + 40, yu], [PADL + 70, yu], [PADL + 98, yu]], 1, 0);
  stroke(P, [[PADL + 40, z.top + 4], [PADL + 55, z.top + 10], [PADL + 70, z.top + 4]], 2, 200);
  assert.deepEqual(P.I.groups().map((g) => `${g.verse}${g.lang}`), ['5en', '5zh']);
  const zTop = P.v5.zh.top, before = at(P.I); setWidth(P, PORTRAIT);
  assert.equal(Math.round(at(P.I)[1].oy - before[1].oy), P.v5.zh.top - zTop, 'the Chinese mark follows the Chinese line');
});

test('erasing one stroke of a split word after the turn moves none of the others (GPT review)', () => {
  const P = page(); writeGapSentence(P, 200, 600);
  const shift = P.v6.en.top - P.v5.zh.top;
  const old = P.I.groups().map((g, i) => (i % 4 >= 2 ? { ...g, verse: 6, lang: 'en', fy: Math.round((g.fy - shift) * 100) / 100 } : g));   // split evenly
  const Q = page(); Q.I.load(old); setWidth(Q, PORTRAIT);
  const before = at(Q.I); Q.I.load(old.slice(1)); setWidth(Q, PORTRAIT);
  assert.deepEqual(at(Q.I), before.slice(1));
});
