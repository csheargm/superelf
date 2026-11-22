// lib/note-emphasis.mjs — what the owner marked important on a page (docs/plans/note-features.md F):
// highlighter boxes, closed pen loops (circles), PANote's T-mode text highlight. Synthetic strokes
// only; the typed-highlight markup is pinned against the shipped engine source, never guessed.
// R11 — searched: "highlighter", "circle", "emphasis", "background-color", "hiliteColor" — the engine
// draws and sanitizes highlights but nothing read them back before this.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlightBox, circleBox, emphasisRegions, boxEmphasised, importantInkLines, typedHighlights,
  CIRCLE_CLOSE_FRAC, CIRCLE_MIN_SIDE, CIRCLE_LEN_MIN, CIRCLE_LEN_MAX, CIRCLE_MIN_POINTS, HIGHLIGHT_COVER, HIGHLIGHTER } from '../lib/note-emphasis.mjs';
import { buildFileRecords, applyOcr } from '../lib/note-index.mjs';
import { INK_MIN_H } from '../lib/note-boxes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');

// A loop around (cx, cy) of radius r, `turns` times round, `n` samples per turn, ending `gap` short of closing.
const loop = (cx, cy, r, { turns = 1, n = 32, gap = 0, t = 'pen' } = {}) => {
  const p = [];
  const total = Math.round(n * turns);
  for (let i = 0; i <= total; i++) { const a = (i / n) * 2 * Math.PI; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0.5]); }
  if (gap) p[p.length - 1] = [cx + r * Math.cos(gap), cy + r * Math.sin(gap), 0.5];
  return { c: '#141414', w: 0.002, t, p };
};
const hl = (x, y, w, h) => ({ c: '#facc15', w: 0.02, t: HIGHLIGHTER, p: [[x, y + h / 2, 0.5], [x + w, y + h / 2, 0.5], [x, y, 0.5], [x + w, y + h, 0.5]] });
const near = (a, b, msg) => { assert.equal(a.length, b.length, msg); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-3, `${msg}: [${a}] vs [${b}]`)); };

test('the rules are pinned constants (each named, each a fraction of the stroke\'s own box)', () => {
  assert.deepEqual([CIRCLE_CLOSE_FRAC, CIRCLE_MIN_SIDE, CIRCLE_LEN_MIN, CIRCLE_LEN_MAX, CIRCLE_MIN_POINTS, HIGHLIGHT_COVER], [0.10, 0.03, 2.0, 5.0, 8, 0.5]);
  assert.ok(CIRCLE_LEN_MIN < Math.PI / Math.SQRT2, 'a true circle (π/√2 ≈ 2.22 × its diagonal) must pass the lower bound');
  assert.equal(HIGHLIGHTER, 'highlighter');
  assert.match(ENGINE, /t==='highlighter'/, 'the engine spells the highlighter stroke type the same way');
});

test('a highlighter stroke is a region by its bounding box; a pen stroke never is', () => {
  near(highlightBox(hl(0.1, 0.2, 0.5, 0.04)), [0.1, 0.2, 0.5, 0.04], 'the box of every point');
  assert.equal(highlightBox({ ...hl(0.1, 0.2, 0.5, 0.04), t: 'pen' }), null);
  assert.equal(highlightBox({ t: HIGHLIGHTER, p: [] }), null, 'no points, no box');
  assert.equal(highlightBox({ t: HIGHLIGHTER, p: [[NaN, 1]] }), null, 'a malformed point is skipped, not a NaN box');
});

test('a circle: a closed pen loop around something — a real circle, an oval and a double trace pass', () => {
  near(circleBox(loop(0.3, 0.3, 0.05)), [0.25, 0.25, 0.1, 0.1], 'a true circle');
  const oval = loop(0.5, 0.5, 0.1); oval.p = oval.p.map(([x, y, pr]) => [x, 0.5 + (y - 0.5) * 0.5, pr]);
  near(circleBox(oval), [0.4, 0.45, 0.2, 0.1], 'an oval (ratio ≈ 2.17)');
  near(circleBox(loop(0.3, 0.3, 0.05, { turns: 2, gap: 0 })), [0.25, 0.25, 0.1, 0.1], 'circled twice (≈ 4.4 × diag) is still a circle');
  near(circleBox(loop(0.3, 0.3, 0.05, { t: 'marker' })), [0.25, 0.25, 0.1, 0.1], 'the marker circles too');
});

test('not a circle: the near-circle that fails the length rule, an open arc, a letter-sized loop, a tick, a scribble, a highlighter loop', () => {
  assert.equal(circleBox(loop(0.3, 0.3, 0.05, { turns: 3 })), null, 'traced three times: 6.7 × diag is a blot, over CIRCLE_LEN_MAX');
  assert.equal(circleBox(loop(0.3, 0.3, 0.05, { gap: Math.PI })), null, 'ends half a turn from the start: an open arc');
  assert.equal(circleBox(loop(0.3, 0.3, 0.01)), null, 'a 0.02-wide loop is an `o`, under CIRCLE_MIN_SIDE');
  assert.equal(circleBox({ t: 'pen', p: [[0.1, 0.1, 1], [0.12, 0.14, 1], [0.2, 0.05, 1]] }), null, 'a tick: too few points, open');
  const zig = { t: 'pen', p: Array.from({ length: 40 }, (_, i) => [0.1 + i * 0.01, i % 2 ? 0.1 : 0.2, 0.5]) };
  assert.equal(circleBox(zig), null, 'a scribble: open, and far longer than its diagonal');
  const closedZig = { t: 'pen', p: [...zig.p, ...zig.p.slice().reverse()] };
  assert.equal(circleBox(closedZig), null, 'a scribble that happens to end where it began fails the length rule (>5 × diag)');
  assert.equal(circleBox(loop(0.3, 0.3, 0.05, { t: HIGHLIGHTER })), null, 'the highlighter never circles (it is a highlight region instead)');
  const line = { t: 'pen', p: Array.from({ length: 20 }, (_, i) => [0.1 + (i < 10 ? i : 19 - i) * 0.01, 0.1, 0.5]) };
  assert.equal(circleBox(line), null, 'a line drawn there and back closes but has no height: a strike, not a circle');
});

test('emphasisRegions sorts a page\'s strokes into highlights and circles; an OCR line is important under enough highlight or centred in a circle', () => {
  const e = emphasisRegions([hl(0.1, 0.1, 0.5, 0.04), loop(0.3, 0.5, 0.1), { t: 'pen', p: [[0.9, 0.9, 1], [0.91, 0.91, 1]] }]);
  assert.equal(e.hl.length, 1); assert.equal(e.circ.length, 1);
  assert.deepEqual(emphasisRegions([]), { hl: [], circ: [] }); assert.deepEqual(emphasisRegions(null), { hl: [], circ: [] });
  assert.equal(boxEmphasised([0.1, 0.1, 0.5, 0.04], e), true, 'fully under the highlight');
  assert.equal(boxEmphasised([0.3, 0.1, 0.5, 0.04], e), true, '60% under it (≥ HIGHLIGHT_COVER)');
  assert.equal(boxEmphasised([0.4, 0.1, 0.5, 0.04], e), false, '40% under it: not highlighted');
  assert.equal(boxEmphasised([0.25, 0.48, 0.1, 0.04], e), true, 'its centre (0.3, 0.5) is inside the circle box');
  assert.equal(boxEmphasised([0.0, 0.48, 0.1, 0.04], e), false, 'centre outside the circle');
  assert.equal(boxEmphasised([0.1, 0.1, 0.5, 0.04], { hl: [], circ: [] }), false, 'no regions, nothing important');
  assert.equal(boxEmphasised(null, e), false);
  // Coverage is the UNION of the highlights over the line, not their sum: the same 30% stroked twice is still 30%.
  const line = [0.0, 0.3, 0.5, 0.04];
  const twice = emphasisRegions([hl(0.0, 0.3, 0.15, 0.04), hl(0.0, 0.3, 0.15, 0.04)]);
  assert.equal(twice.hl.length, 2); assert.equal(boxEmphasised(line, twice), false, 'two identical strokes over 30%: not important');
  assert.equal(boxEmphasised(line, emphasisRegions([hl(0.0, 0.3, 0.3, 0.04)])), true, 'one stroke over 60%: important');
  assert.equal(boxEmphasised(line, emphasisRegions([hl(0.0, 0.3, 0.2, 0.04), hl(0.1, 0.3, 0.2, 0.04)])), true, 'two overlapping strokes covering 0..0.3 together (60%)');
  assert.equal(boxEmphasised(line, emphasisRegions([hl(0.0, 0.5, 0.5, 0.04)])), false, 'a full-width stroke on another line counts nothing');
});

test('importantInkLines maps OCR boxes through the page geometry: the fake tool\'s line 0 under a highlighter stroke, line 1 not', () => {
  // The OCR box is normalised against the ink bitmap (H = INK_MIN_H × W here); pageBox scales y and h by geo.ink.
  const lines = [{ t: 'Saturday pollen moderate', box: [0.1, 0.1, 0.6, 0.1] }, { t: 'shared', box: [0.1, 0.3, 0.6, 0.1] }];
  const geo = { ink: INK_MIN_H, imgs: [] };
  const e = emphasisRegions([hl(0.05, 0.02, 0.7, 0.05)]);   // page y 0.02..0.07 covers line 0 (page y 0.03..0.06), not line 1 (0.09..0.12)
  assert.deepEqual(importantInkLines(lines, geo, e), [0]);
  assert.deepEqual(importantInkLines(lines, null, e), [], 'no geometry (an index from before phase 3): nothing placed, nothing claimed');
  assert.deepEqual(importantInkLines(lines, geo, { hl: [], circ: [] }), []);
});

test('typed highlights: the exact markup PANote\'s T-mode highlight writes, pinned against the engine', () => {
  // fmtHighlight: execCommand('styleWithCSS',true) then hiliteColor (backColor fallback) with rgbaOf(colour, HL_TEXT_ALPHA).
  assert.match(ENGINE, /document\.execCommand\('styleWithCSS',false,true\);\s*\n\s*if\(!document\.execCommand\('hiliteColor',false,val\)\) document\.execCommand\('backColor',false,val\);/);
  assert.match(ENGINE, /const HL_TEXT_ALPHA=0\.4;/);
  assert.match(ENGINE, /fmtHighlight\(v==='none'\?'transparent':rgbaOf\(v,HL_TEXT_ALPHA\)\)/, 'None writes transparent');
  assert.match(ENGINE, /'background-color':SAFE_COLOR, 'background':SAFE_COLOR,/, 'the sanitizer keeps exactly these two props as colours');
  const browser = '<div>Call the <span style="background-color: rgba(250, 204, 21, 0.4);">landlord <b>today</b></span> about it</div>';
  assert.deepEqual(typedHighlights(browser), ['landlord today'], 'as a browser serializes it (spaces, trailing semicolon)');
  assert.deepEqual(typedHighlights('<span style="background-color:rgba(250,204,21,0.4)">roof</span>'), ['roof'], 'as rgbaOf spells it');
  assert.deepEqual(typedHighlights('<span style="background: #fde047">x</span> and <span style="color:#fff;background-color:#facc15">y</span>'), ['x', 'y'], 'the shorthand, and a second prop before it');
  assert.deepEqual(typedHighlights('<span style="background-color: transparent;">cleared</span>'), [], 'the None chip');
  assert.deepEqual(typedHighlights('<span style="background-color: rgba(0, 0, 0, 0);">cleared</span>'), [], 'an alpha-0 colour is no highlight');
  assert.deepEqual(typedHighlights('<span style="color: rgb(0,0,0);">plain</span>'), [], 'a text colour is not a highlight');
  assert.deepEqual(typedHighlights('<span style="background-color:#facc15">outer <span style="background-color:#fde047">inner</span> end</span>'), ['outer inner end'], 'nested highlights fold into the outer run');
  assert.deepEqual(typedHighlights('<div><span style="background-color:#facc15">a<br>b</span></div><div><span style="background-color:#facc15">  </span></div>'), ['a b'], 'a break inside is a space; an empty run is dropped');
  assert.deepEqual(typedHighlights(''), []); assert.deepEqual(typedHighlights(null), []);
});

test('a record carries emph and imp from build time; an OCR result re-derives imp.ink; a plain page has both empty', () => {
  const html = '<div>Keep <span style="background-color: rgba(250, 204, 21, 0.4);">this one</span></div>';
  // The loop reaches y 0.7, so the ink bitmap is 0.75 page widths tall and OCR line 0 sits at page y 0.075..0.15 — under this highlighter stroke.
  const recs = buildFileRecords('e.json', { pages: [{ strokes: [hl(0.05, 0.06, 0.7, 0.1), loop(0.3, 0.6, 0.1)], pageHtml: html, images: [] }, { strokes: [{ t: 'pen', p: [[0.1, 0.1, 1], [0.2, 0.1, 1]] }], pageHtml: '<div>plain</div>', images: [] }] }, 5);
  assert.equal(recs[0].emph.hl.length, 1); assert.equal(recs[0].emph.circ.length, 1);
  assert.deepEqual(recs[0].imp, { ink: [], typed: ['this one'] }, 'typed highlight known at build time; no OCR lines yet');
  applyOcr(recs[0], 'ink', recs[0].need.ink, { ok: true, text: 'a\nb', lines: [{ t: 'a', box: [0.1, 0.1, 0.6, 0.1] }, { t: 'b', box: [0.1, 0.3, 0.6, 0.1] }] });
  assert.deepEqual(recs[0].imp, { ink: [0], typed: ['this one'] }, 'the landed OCR line under the highlighter is important');
  assert.deepEqual(recs[1].emph, { hl: [], circ: [] }); assert.deepEqual(recs[1].imp, { ink: [], typed: [] });
});
