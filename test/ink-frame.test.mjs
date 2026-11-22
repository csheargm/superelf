// Handwriting on the verses stays whole on every width (web/ink-frame.inline.html, PAInkFrame, used by
// web/ink-anchor.inline.html). SCAR (owner, Romans 7:6, 2026-11-22): a sentence handwritten on the 11"
// iPad was unreadable on the 12.9" and the iPhone — every stroke had been pinned to the word under it, so
// on another wrap the pieces of one character followed different words, and a stroke pinned to a single
// letter that then wrapped was scaled by the whole column (a thick bar across the phone).
// Runs the shipped components on the fake layout DOM (helpers-ink-dom): CW px per char, rows wrap at the
// list's width. CONTROLS: two quick underlines on two words stay pinned to their words; a block is never
// enlarged on a wider screen; old records are read, never rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT, ENG_INK } from './helpers-app.mjs';
import { CW, RH, PADL, makeDom, penStroke } from './helpers-ink-dom.mjs';

const TEXT = 'But now, having died to what bound us, we have been released from the law';   // 74 chars
// A small handwriting stroke: a 10px zigzag with its top-left at (x, y) in the list's px.
function letter(dom, x, y, id) {
  const pts = [[x, y], [x + 5, y + 10], [x + 10, y]];
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: pts[0][0], clientY: pts[0][1], pressure: 0.5 }));
  for (const [cx, cy] of pts.slice(1)) dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: cx, clientY: cy, pressure: 0.5 }));
  dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: pts[2][0], clientY: pts[2][1] }));
}
const setWidth = (dom, w) => { dom.L.width = w; dom.fire('w:resize', dom.ev('resize')); dom.flush(); };
const rel = (I) => { const p = I.placements().map((x) => x.at); return p.map((a) => [Math.round((a.ox - p[0].ox) / a.s * 100) / 100, Math.round((a.oy - p[0].oy) / a.s * 100) / 100]); };

function writeSentence(src) {
  const dom = makeDom({ width: 400, src });
  const v = dom.addVerse(6, TEXT, '但我们既然在捆我们的律法上死了');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  // a sentence written OVER the verse's first row (as the owner wrote 7:6), letters 12px apart
  for (let i = 0; i < 26; i++) letter(dom, PADL + 4 + i * 12, v.en.top + 6, 10 + i);
  return { dom, v, I };
}

test('handwriting goes on the line frame and moves as one block: same shape at every width, shrunk to fit a narrow column, never enlarged', () => {
  const { dom, v, I } = writeSentence();
  const gs = I.groups();
  assert.equal(gs.length, 26);
  assert.ok(gs.every((g) => g.frame === 'line' && g.verse === 6 && g.lang === 'en'), 'every piece of the writing is on the line frame');
  const shape = rel(I), at0 = I.placements()[0].at;
  assert.deepEqual(at0, { ox: PADL + 4, oy: v.en.top + 6, s: 1 }, 'drawn where the pen went');
  // a phone-width column (176px): the 316px-wide sentence is shrunk to fit, every piece by the same factor
  setWidth(dom, 200);
  const ps = I.placements().map((p) => p.at), s = ps[0].s;
  assert.ok(s < 1 && ps.every((a) => a.s === s), 'one scale for the whole block');
  assert.deepEqual(rel(I), shape, 'the shape of the writing is unchanged');
  const right = Math.max(...I.placements().map((p) => p.at.ox + 10 * p.at.s + p.g.strokes[0].w * p.at.s));
  assert.ok(right <= 200 - PADL + 0.01, `fits the column (right edge ${right})`);
  assert.equal(ps[0].ox, PADL + 4 * s, 'anchored at the line\'s left');
  // CONTROL: a wider screen never enlarges it
  setWidth(dom, 900);
  assert.deepEqual(I.placements()[0].at, at0, 'scale 1 and the same place on the line');
  assert.deepEqual(rel(I), shape);
});

test('REGRESSION: the same sentence on the shipped-before engine scattered across the verse when it re-wrapped', () => {
  const before = execFileSync('git', ['show', 'origin/main:web/ink-anchor.inline.html'], { cwd: ROOT, encoding: 'utf8' });
  const { dom, I } = writeSentence(before);
  const shape = rel(I);
  setWidth(dom, 200);
  assert.notDeepEqual(rel(I), shape, 'the old engine loses the shape (this is the bug the frame fixes)');
});

test('a burst that starts ON the text: the first stroke, pinned to a word, joins the writing once the second follows beside it', () => {
  const dom = makeDom({ width: 400 });
  const v = dom.addVerse(6, TEXT, '中文');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  letter(dom, PADL + 40, v.en.top + 6, 1);
  assert.equal(I.groups()[0].frame, undefined, 'alone, a stroke over letters is a mark on them');
  const at = I.placements()[0].at;
  letter(dom, PADL + 52, v.en.top + 6, 2);
  assert.deepEqual(I.groups().map((g) => g.frame), ['line', 'line'], 'both are writing now');
  assert.deepEqual(I.placements()[0].at, at, 'and the first did not move');
  assert.equal(I.undo(), true);
  assert.deepEqual(I.groups().map((g) => g.frame), [undefined], 'undo takes the second stroke back AND the first stroke\'s move: one step (GPT review)');
  letter(dom, PADL + 200, v.en.top + 6, 3);
  assert.equal(I.groups()[1].frame, undefined, 'the undone stroke seeds no burst: a stroke over letters far from it is a mark again');
});

test('CONTROL: two quick underlines on two words stay pinned to their words; a highlighter stroke is never writing', () => {
  const dom = makeDom({ width: 400 });
  const v = dom.addVerse(16, 'For God so loved the world', '神爱世人');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  penStroke(dom, v.en, 11, 16, 1); penStroke(dom, v.en, 21, 26, 2);
  assert.deepEqual(I.groups().map((g) => [g.frame, g.quote]), [[undefined, 'loved'], [undefined, 'world']]);
  I.setPen({ t: 'highlighter', c: '#ff0', w: 8, a: 0.3 });
  letter(dom, PADL + 4, v.en.top - 18, 3); letter(dom, PADL + 16, v.en.top - 18, 4);
  assert.ok(I.groups().slice(2).every((g) => g.frame === undefined), 'highlights stay word marks');
});

test('old records (one per stroke, pinned to words) are READ as one block: a letter-piece is measured at the width it was written at', () => {
  const dom = makeDom({ width: 400 });   // 37 columns: the width the old ink was "written" at
  const v = dom.addVerse(6, TEXT, '中文');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  const stroke = { p: [[0, 0, 0.5], [5, 10, 0.5], [10, 0, 0.5]], c: '#2f6fed', w: 2.2, t: 'pen' };
  const whole = (dx, dy) => ({ verse: 6, lang: 'en', charStart: 0, charEnd: TEXT.length, quote: TEXT, dx, dy, w: 37 * CW, strokes: [stroke] });
  // char 40 at 37 columns: row 1, column 3 → 30px in, one row down. The piece sat 2px under its top-left.
  const piece = { verse: 6, lang: 'en', charStart: 40, charEnd: 41, quote: TEXT[40], dx: 0, dy: 2, w: CW, strokes: [stroke] };
  const old = { v6: [whole(10, 20), piece, whole(45, 20)] };
  I.load(old);
  const at = () => I.placements().map((p) => p.at);
  const atWritten = at();
  assert.deepEqual([atWritten[1].ox - atWritten[0].ox, atWritten[1].oy - atWritten[0].oy], [20, 6], 'at the written width: where it was drawn');
  setWidth(dom, 200);   // 17 columns: char 40 is now on row 2, column 6
  const a = at();
  assert.ok(a.every((x) => x.s === a[0].s), 'one scale');
  assert.deepEqual([(a[1].ox - a[0].ox) / a[0].s, (a[1].oy - a[0].oy) / a[0].s], [20, 6], 'the letter-piece stays inside its writing, not on char 40\'s new row');
  assert.ok(dom.L.clonesMade >= 1, 'measured on a hidden copy of the line');
  assert.deepEqual(I.groups(), [old.v6[0], old.v6[1], old.v6[2]], 'the records are read, never rewritten');
  // erasing still finds the block where it draws now
  const p = a[0]; dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: 9, clientX: p.ox, clientY: p.oy }));
  I.setPen({ t: 'erase' }); dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: 9, clientX: p.ox, clientY: p.oy }));
  assert.equal(I.groups().length, 2, 'the eraser took the stroke under it');
});

test('pure: placeLine shares one scale and never enlarges; joinsBurst needs time, the same line, small pieces, side by side', () => {
  const Fr = makeDom().window.PAInkFrame;
  const items = [{ fx: 0, fy: 0, ext: { w: 100, h: 10 } }, { fx: 300, fy: 5, ext: { w: 100, h: 10 } }];
  assert.deepEqual(Fr.placeLine({ left: 10, top: 50 }, 200, items), [{ ox: 10, oy: 50, s: 0.5 }, { ox: 160, oy: 52.5, s: 0.5 }]);
  assert.deepEqual(Fr.placeLine({ left: 10, top: 50 }, 2000, items)[1], { ox: 310, oy: 55, s: 1 }, 'never enlarged');
  const g = { verse: 1, lang: 'en' }, ext = { w: 10, h: 10 }, box = { l: 0, t: 0, r: 10, b: 10 };
  const prev = { g, t: 1000, ext, box: { l: 12, t: 0, r: 22, b: 10 } };
  assert.equal(Fr.joinsBurst(prev, 1500, g, ext, box), true);
  assert.equal(Fr.joinsBurst(prev, 1000 + Fr.BURST_MS + 1, g, ext, box), false, 'too late');
  assert.equal(Fr.joinsBurst(prev, 1500, { verse: 2, lang: 'en' }, ext, box), false, 'another line');
  assert.equal(Fr.joinsBurst(prev, 1500, g, { w: 200, h: 10 }, box), false, 'a long stroke is a mark');
  assert.equal(Fr.joinsBurst({ ...prev, box: { l: 60, t: 0, r: 70, b: 10 } }, 1500, g, ext, box), false, 'too far from the last');
});

test('an old word mark measured on a wrapped range keeps its size: the anchor box is the one its width was measured on (GPT review)', () => {
  const dom = makeDom({ width: 150 });   // 12 columns: chars 8..18 wrap over two rows
  const v = dom.addVerse(6, TEXT, '中文');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  const u = dom.PAInkAnchor.measurer(v.en).rangeRect(8, 18);
  assert.equal(u.width, 12 * CW, 'the union box is the whole column');
  const stroke = { p: [[0, 0, 0.5], [100, 40, 0.5]], c: '#e5484d', w: 2, t: 'pen' };
  const old = { verse: 6, lang: 'en', charStart: 8, charEnd: 18, quote: TEXT.slice(8, 18), dx: 0, dy: 0, w: u.width, strokes: [stroke] };
  const hl = { verse: 6, lang: 'en', charStart: 0, charEnd: TEXT.length, quote: TEXT, dx: 5, dy: 5, w: 12 * CW, strokes: [{ ...stroke, p: [[0, 0, 0.5], [8, 8, 0.5]], t: 'highlighter', a: 0.3 }] };
  I.load([old, hl]);
  const [a, h] = I.placements().map((p) => p.at);
  assert.equal(a.s, 1, 'unchanged layout: unchanged size');
  assert.deepEqual([a.ox, a.oy], [u.left, u.top]);
  assert.equal(h.s, 1); assert.equal(I.groups()[1].frame, undefined, 'an old highlight is never read as writing');
});

test('a single big stroke over the whole verse is a mark on it, not writing (GPT review round 2)', () => {
  const dom = makeDom({ width: 400 });
  const v = dom.addVerse(6, TEXT, '中文');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  const y = v.en.top + RH * 0.9, xs = [PADL + 1, PADL + 180, PADL + 360];
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: 5, clientX: xs[0], clientY: y }));
  for (const x of xs.slice(1)) dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: 5, clientX: x, clientY: y }));
  dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: 5, clientX: xs[2], clientY: y }));
  assert.equal(I.groups()[0].frame, undefined);
});

test('an old letter-piece whose offset was taken from a wrapped union box is rebuilt from that box (GPT review round 2)', () => {
  const dom = makeDom({ width: 150 });   // 12 columns, the written width: chars 8..18 wrap, union starts at column 0
  const v = dom.addVerse(6, TEXT, '中文');
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  const st = { p: [[0, 0, 0.5], [5, 10, 0.5], [10, 0, 0.5]], c: '#2f6fed', w: 2.2, t: 'pen' };
  const whole = { verse: 6, lang: 'en', charStart: 0, charEnd: TEXT.length, quote: TEXT, dx: 0, dy: 0, w: 12 * CW, strokes: [st] };
  const piece = { verse: 6, lang: 'en', charStart: 8, charEnd: 18, quote: TEXT.slice(8, 18), dx: 3, dy: 4, w: 12 * CW, strokes: [st] };
  I.load([whole, piece]);
  const [a, b] = I.placements().map((p) => p.at);
  assert.deepEqual([b.ox - a.ox, b.oy - a.oy], [3, 4], 'the union box starts at the line\'s left, so the piece is 3,4 from it');
});
