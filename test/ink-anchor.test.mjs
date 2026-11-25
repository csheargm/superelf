// Anchored ink（经文上的手写）— docs/plans/annotation-anchoring.md §3 (b), phase 1, shipped as
// web/ink-anchor.inline.html (PAInkAnchor) drawing with PANote.ink (the pad's own renderer, hoisted).
// A fake DOM with a REAL layout model (chars of a fixed width wrapped at the list width) drives the
// shipped component: a Pencil stroke over a word → an anchor record {verse,lang,charStart,charEnd,
// quote,dx,dy,w} (never a page fraction) → the list narrows and the word wraps to the next row →
// the group is re-placed on the word → the font grows → the group scales with the word → twenty
// reflows at one layout move nothing. CONTROLS: a finger or a mouse never draws and is never
// stopped; a finger touch is never prevented, a stylus touch is; without PANote.ink attach throws.
// Then the shipped Bible hosts: boot mounts it, renderVerses re-appends the canvas and re-anchors.
// Phase 2: pack/unpack is the chapter-file shape; a scrub stroke erases exactly the groups it crosses
// and is itself not kept (a scrub over nothing is ink — control); a group whose quote or line is gone
// sits in the labelled orphan bucket under the last verse, never dropped; the hosts round-trip
// ANN.ink through the real broker file, reload it on load(), erase through the same save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, APP_SRC, ENG_INK, startHarness, runApp, until, scriptOf } from './helpers-app.mjs';
import { runPad } from './helpers-panote-routing.mjs';
import { COMPONENT, CW, RH, PADL, makeDom, VERSES, penStroke } from './helpers-ink-dom.mjs';

const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');

// ═══ pure geometry ═══════════════════════════════════════════════════════════════════════════
test('pickLine: the most vertical overlap, else the nearest line; pickChars: the characters under the box, else the whole line', () => {
  const { PAInkAnchor: M } = makeDom();
  const lines = [{ n: 1, lang: 'en', rect: { left: 0, top: 0, width: 100, height: 24 } }, { n: 1, lang: 'zh', rect: { left: 0, top: 30, width: 100, height: 24 } }, { n: 2, lang: 'en', rect: { left: 0, top: 80, width: 0, height: 0 } }];
  assert.equal(M.pickLine({ l: 5, t: 20, r: 50, b: 40 }, lines), lines[1], 'more of the box lies on the second line');
  assert.equal(M.pickLine({ l: 5, t: 60, r: 50, b: 70 }, lines), lines[1], 'in the gap below: the nearest line');
  assert.equal(M.pickLine({ l: 5, t: -40, r: 50, b: -30 }, lines), lines[0], 'above everything: the first line');
  assert.equal(M.pickLine({ l: 0, t: 0, r: 1, b: 1 }, [lines[2]]), null, 'an empty line is never an anchor');
  const cr = (i) => ({ left: i * 10, top: 0, width: 10, height: 24 });
  assert.deepEqual(M.pickChars({ l: 31, t: 18, r: 58, b: 20 }, 10, cr), { start: 3, end: 6 }, 'chars 3..5 touch the box');
  assert.deepEqual(M.pickChars({ l: 300, t: 0, r: 320, b: 10 }, 10, cr), { start: 0, end: 10 }, 'a margin scribble: the whole line');
  assert.deepEqual(M.pickChars({ l: 34, t: 0, r: 36, b: 10 }, 10, cr), { start: 3, end: 4 }, 'a dot inside a character takes that character');
  assert.deepEqual(M.pickChars({ l: 29, t: 0, r: 31, b: 10 }, 10, cr), { start: 0, end: 10 }, 'a 2px dot straddling a boundary covers neither enough: the whole line');
  assert.deepEqual(M.pickChars({ l: 10, t: 40, r: 50, b: 50 }, 10, cr), { start: 0, end: 10 }, 'a stroke two rows below touches no character');
  assert.deepEqual(M.trimRange('For God so loved the', { start: 10, end: 17 }), { start: 11, end: 16 }, 'whitespace trimmed off the quote');
  assert.deepEqual(M.trimRange('a  b', { start: 1, end: 3 }), { start: 1, end: 3 }, 'all-space stays as measured');
  assert.deepEqual(M.bboxOf([{ x: 3, y: 9 }, { x: 1, y: 2 }, { x: 5, y: 4 }]), { l: 1, t: 2, r: 5, b: 9 });
});

test('resolveRange: offsets, then the quote\'s new place, then the whole line flagged; place: translate + scale by the anchor width', () => {
  const { PAInkAnchor: M } = makeDom();
  const g = { charStart: 11, charEnd: 16, quote: 'loved', dx: 2, dy: 10, w: 50 };
  assert.deepEqual(M.resolveRange('For God so loved the world', g), { start: 11, end: 16, orphan: false });
  assert.deepEqual(M.resolveRange('For God loved the world so', g), { start: 8, end: 13, orphan: false }, 'a BSB wording change');
  assert.deepEqual(M.resolveRange('God cherished the world', g), { start: 0, end: 23, orphan: true }, 'unfindable: whole line, flagged');
  // REGRESSION: a repeated quote re-anchored to its FIRST copy (indexOf), moving the ink across the verse.
  const god = { charStart: 29, charEnd: 32, quote: 'God', dx: 0, dy: 0, w: 30 };
  assert.deepEqual(M.resolveRange('For God so loved the world that God gave', god), { start: 32, end: 35, orphan: false }, 'the copy nearest the stored offset, not the first');
  assert.deepEqual(M.resolveRange('God so loved the world that God gave', { ...god, charStart: 3, charEnd: 6 }), { start: 0, end: 3, orphan: false }, 'nearest can be the first copy too');
  assert.deepEqual(M.resolveRange('God loved God', { ...god, charStart: 5, charEnd: 8 }), { start: 0, end: 13, orphan: true }, 'two copies equally near: bucket, never a guess');
  assert.deepEqual(M.place(g, { left: 100, top: 200, width: 100 }), { ox: 104, oy: 220, s: 2 }, 'the word doubled: the ink doubles with it');
  assert.deepEqual(M.place(g, { left: 100, top: 200, width: 0 }), { ox: 102, oy: 210, s: 1 }, 'a zero-width anchor never divides by zero');
});

test('measurer joins the text nodes a <mark> splits and measures a Range across them', () => {
  const dom = makeDom();
  const v = dom.addVerse(16, 'For God so loved the world', '神爱世人');
  const t = v.en.childNodes[0].data;
  v.en.childNodes = [{ nodeType: 3, data: t.slice(0, 11) }, { nodeType: 1, childNodes: [{ nodeType: 3, data: t.slice(11, 16) }] }, { nodeType: 3, data: t.slice(16) }];
  const m = dom.PAInkAnchor.measurer(v.en);
  assert.equal(m.text, t);
  assert.deepEqual(m.rangeRect(9, 13), { left: PADL + 9 * CW, top: v.en.top, width: 4 * CW, height: RH }, 'a range spanning the mark boundary');
  assert.deepEqual(m.charRect(25), dom.charRect(v.en, 25), 'the last char, in the last node');
});

// ═══ the component on the fake DOM ═══════════════════════════════════════════════════════════
test('attach needs PANote.ink (never a second renderer), takes PEN only, anchors a stroke to the word under it', () => {
  const dom = makeDom({ width: 400 });
  assert.throws(() => dom.PAInkAnchor.attach({ container: dom.container }), /PANote\.ink/, 'no renderer: loud, not a silent blank overlay');
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  const changes = [];
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK, onChange: (g) => changes.push(g) });
  assert.equal(dom.container.style.position, 'relative', 'the list is the canvas\'s containing block');
  assert.equal(dom.container.children[0], I.canvas, 'the overlay sits inside the scrolling list');
  assert.equal(I.canvas.style.pointerEvents, undefined, 'pointer-events:none comes from the stylesheet, so a finger reaches the text');
  assert.match(COMPONENT, /\.pia-ink\{position:absolute;left:0;top:0;pointer-events:none/);
  assert.deepEqual([I.canvas.width, I.canvas.height], [800, 2 * dom.container.scrollHeight], 'backing store at dpr 2 over the whole content height');
  // CONTROLS: a finger and a mouse pass through — not prevented, not stopped, no stroke
  for (const pointerType of ['touch', 'mouse']) {
    dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType, pointerId: 1, clientX: 50, clientY: 50 }));
    dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: 1, clientX: 60, clientY: 60 }));
    dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: 1, clientX: 60, clientY: 60 }));
  }
  assert.deepEqual([dom.L.prevented, dom.L.stopped, I.groups(), changes], [[], 0, [], []], 'finger/mouse: the list keeps scroll, select and long-press');
  // the Pencil: an underline under "loved" (chars 11..16 of v16's English line, one row at 400px)
  assert.equal(dom.cols(), 37, 'at 400px the line does not wrap');
  penStroke(dom, v16.en, 11, 16);
  assert.ok(dom.L.prevented.includes('pointerdown') && dom.L.stopped >= 1, 'the pen is taken in the capture phase');
  assert.equal(I.groups().length, 1); assert.equal(changes.length, 1);
  const g = I.groups()[0];
  assert.deepEqual([g.verse, g.lang, g.charStart, g.charEnd, g.quote], [16, 'en', 11, 16, 'loved']);
  assert.deepEqual([g.dx, g.dy, g.w], [1, RH * 0.75, 5 * CW], 'origin from the word\'s top-left; w = the word\'s width');
  assert.deepEqual(g.strokes[0].p.map((p) => p.slice(0, 2)), [[0, 0], [24, 1], [48, 0]], 'points are px from the group origin');
  assert.deepEqual(g.strokes[0].p.map((p) => p[2]), [0.6, 0.7, 0.6], 'pressure kept');
  assert.deepEqual([g.strokes[0].c, g.strokes[0].w, g.strokes[0].t], ['#0f6355', 2.2, 'pen'], 'the default pen');
  assert.doesNotMatch(JSON.stringify(g), /0\.[0-9]{3,}/, 'no page fractions in the record');
  // the click that follows a pen-up is swallowed once, then clicks reach the verse again
  const click = dom.ev('click'); dom.fire('click:capture', click); dom.flush();
  assert.ok(dom.L.prevented.includes('click'), 'the stroke\'s click never selects the verse');
  dom.L.prevented.length = 0; dom.fire('click:capture', dom.ev('click')); assert.deepEqual(dom.L.prevented, [], 'the next click is the verse\'s own');
  // the stylus guard: a stylus touch is prevented (iOS selection would steal the Pencil), a finger is not
  dom.fire('touchstart', dom.ev('touchstart', { touches: [{ touchType: 'direct' }] }));
  assert.deepEqual(dom.L.prevented, [], 'a finger touch scrolls natively');
  dom.fire('touchstart', dom.ev('touchstart', { touches: [{ touchType: 'stylus' }] }));
  dom.fire('touchmove', dom.ev('touchmove', { touches: [{ touchType: 'stylus' }] }));
  assert.deepEqual(dom.L.prevented, ['touchstart', 'touchmove'], 'the Pencil\'s touch is');
  dom.fire('selectstart', dom.ev('selectstart')); assert.equal(dom.L.prevented.length, 2, 'no stroke in progress: selection is the user\'s');
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: 9, clientX: 50, clientY: 50 }));
  dom.fire('selectstart', dom.ev('selectstart')); assert.deepEqual(dom.L.prevented.slice(2), ['pointerdown', 'selectstart'], 'mid-stroke: no selection');
  assert.ok(I.isDrawing()); dom.fire('w:pointercancel', dom.ev('pointercancel', { pointerId: 9, clientX: 50, clientY: 50 })); assert.ok(!I.isDrawing());
  assert.equal(I.groups().length, 1, 'a cancelled pointer (palm, system gesture) anchors nothing');
});

test('a stroke with no verse line under it is kept unanchored (verse:null, box origin), shown in the orphan bucket once the list has verses, never dropped', () => {
  const dom = makeDom({ width: 400 });
  const changes = [];
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK, onChange: (g) => changes.push(g) });
  // an EMPTY list: pickLine has nothing to pick (control: the same stroke over a verse anchors, above)
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: 3, clientX: 40, clientY: 90, pressure: 0.5 }));
  dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: 3, clientX: 70, clientY: 95, pressure: 0.5 }));
  dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: 3, clientX: 70, clientY: 95 }));
  assert.equal(I.groups().length, 1, 'the ink is kept'); assert.equal(changes.length, 1, 'and the host is told to store it');
  const g = I.groups()[0];
  assert.deepEqual([g.verse, g.lang, g.charStart, g.charEnd, g.quote, g.dx, g.dy, g.w], [null, null, 0, 0, '', 40, 90, 0], 'unanchored: the box origin in list space');
  assert.deepEqual(g.strokes[0].p.map((p) => p.slice(0, 2)), [[0, 0], [30, 5]]);
  const M = dom.PAInkAnchor;
  const inBucket = () => { const b = dom.bucketEl(); const r = b.getBoundingClientRect(); return { ox: r.left + M.BUCKET_PADX, oy: r.top + M.LABEL_H + M.ROW_GAP, s: 1 }; };
  // the list has no .verse at all: not laid out yet, so nothing is placed and no bucket is shown (the group is kept)
  assert.deepEqual(I.placements().map(({ at, orphan }) => [at, orphan]), [[null, false]], 'an empty list places nothing');
  assert.equal(dom.bucketEl(), undefined, 'and shows no bucket');
  // a loaded unanchored group on a chapter that has verses: in the bucket under them, scale 1, flagged, painted
  dom.addVerse(...VERSES[0]); I.load([g]); dom.flush();
  const [{ at, orphan }] = I.placements();
  assert.deepEqual([at, orphan], [inBucket(), true], 'in the orphan bucket, scale 1, flagged');
  assert.ok(inBucket().oy > dom.verses[0].zh.top, 'under the last verse'); assert.ok(I.canvas.ctx.ops.includes('stroke'), 'and painted');
});

// REGRESSION: INK.load runs before any .verse exists ('Loading…' / 'Could not load'); every loaded group
// was bucketed under that placeholder. An empty list is "not laid out": no bucket, nothing drawn.
test('load on a list with no .verse appends no bucket and draws nothing; the verses arriving places the groups', () => {
  const dom = makeDom({ width: 400 });
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  I.load([{ verse: 16, lang: 'en', charStart: 11, charEnd: 16, quote: 'loved', dx: 1, dy: 18, w: 50, strokes: [{ p: [[0, 0], [48, 0]], c: '#000', w: 2, t: 'pen' }] }]);
  dom.flush();
  assert.equal(dom.bucketEl(), undefined, 'no bucket under the placeholder');
  assert.deepEqual(I.placements().map(({ at, orphan }) => [at, orphan]), [[null, false]], 'not an orphan, not placed');
  assert.ok(!I.canvas.ctx.ops.includes('stroke'), 'nothing painted');
  const v16 = dom.addVerse(...VERSES[0]); I.reflow();
  const r = dom.PAInkAnchor.measurer(v16.en).rangeRect(11, 16);
  assert.deepEqual(I.placements()[0].at, { ox: r.left + 1, oy: r.top + 18, s: 1 }, 'placed on "loved" once the text is in');
  assert.ok(I.canvas.ctx.ops.includes('stroke'), 'and painted');
});

test('the canvas never ratchets the scroller: a shorter chapter (or A-) shrinks the canvas back to the content height', () => {
  const dom = makeDom({ width: 400, childrenCount: true });
  const long = 'x'.repeat(37 * 40);   // 40 rows of 37 columns per line → a tall chapter
  dom.addVerse(1, long, long);
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  const tall = parseFloat(I.canvas.style.height);
  assert.ok(tall > 1900, 'the tall chapter: canvas height = its content height (' + tall + ')');
  // the host rebuilds the list with a short chapter (innerHTML='' drops the canvas; render() re-appends it)
  dom.verses.length = 0; dom.addVerse(117, 'Praise the LORD, all you nations', '万国啊，你们都当赞美耶和华');
  I.canvas.parentNode = null; dom.container.children = [];
  I.render();
  const short = parseFloat(I.canvas.style.height);
  assert.ok(short < tall / 10, `the canvas shrank with the content (${tall} → ${short})`);
  assert.equal(dom.container.scrollHeight, short, 'no phantom scroll space under the short chapter');
  // A-: the text shrinks in place (no rebuild) → the next frame shrinks the canvas too
  dom.L.cw = 5; dom.verses.length = 0; dom.addVerse(1, long, long); I.reflow(); const big = parseFloat(I.canvas.style.height);
  dom.L.cw = 2; dom.fire('w:message', { data: { pa: 'prefs', fontScale: 0.5 } }); dom.flush();
  assert.ok(parseFloat(I.canvas.style.height) < big, 'A-: the canvas followed the text down');
});

test('re-anchor: the word wraps to the next row → the ink follows; the font grows → the ink scales; repeated reflows drift nothing', () => {
  const dom = makeDom({ width: 400 });
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK });
  penStroke(dom, v16.en, 11, 16);
  const g = I.groups()[0], at0 = I.placements()[0].at;
  const wordRect = () => dom.PAInkAnchor.measurer(v16.en).rangeRect(11, 16);
  assert.deepEqual(at0, { ox: wordRect().left + 1, oy: wordRect().top + RH * 0.75, s: 1 });
  const before = JSON.stringify(I.placements());
  for (let i = 0; i < 20; i++) I.reflow();
  assert.equal(JSON.stringify(I.placements()), before, 'twenty reflows at one layout: no drift');
  assert.deepEqual(I.groups()[0], g, 'and the record is never rewritten by a reflow');
  // narrower (portrait / rail): 15 columns → "loved" (11..16) starts on row 0 and ends on row 1
  dom.L.width = 15 * CW + 2 * PADL; assert.equal(dom.cols(), 15);
  dom.fire('w:resize', dom.ev('resize')); assert.equal(dom.L.raf.length, 1, 'one frame scheduled'); assert.equal(I.canvas.width, 800, 'nothing repainted before the frame');
  dom.flush();
  let r = wordRect(), at = I.placements()[0].at;
  assert.equal(r.height, 2 * RH, 'the word now spans two rows');
  // REGRESSION (owner, Romans 7, 2026-11-22): the union box of a wrapped word is the whole column wide, and
  // scaling by it blew the stroke up (a 1-letter anchor → 50x on the iPhone). The run keeps the word's own
  // width, so the ink stays its size and sits at the word's FIRST row.
  assert.deepEqual(at, { ox: dom.charRect(v16.en, 11).left + 1, oy: r.top + RH * 0.75, s: 1 }, 'placed on the wrapped word, unscaled');
  // narrower still: 11 columns → "loved" (11..16) sits whole on row 1 — the ink moves down a row with it
  dom.L.width = 11 * CW + 2 * PADL; dom.fire('w:orientationchange', dom.ev('orientationchange')); dom.flush();
  r = wordRect(); at = I.placements()[0].at;
  assert.equal(r.top, v16.en.top + RH, 'row 1'); assert.deepEqual(at, { ox: r.left + 1, oy: r.top + RH * 0.75, s: 1 }, 'the group followed the word down, unscaled');
  assert.ok(I.canvas.height >= 2 * dom.container.scrollHeight - 1, 'the canvas grew with the content');
  // font scale A+: chars 1.5x wider → the shell's prefs message → the group scales 1.5x
  dom.L.cw = 15; dom.L.width = 400; dom.fire('w:message', { data: { pa: 'prefs', fontScale: 1.5 } }); dom.flush();
  r = wordRect(); at = I.placements()[0].at;
  assert.deepEqual(at, { ox: r.left + 1.5, oy: r.top + RH * 0.75 * 1.5, s: 1.5 }, 'scaled by the word\'s new width');
  dom.fire('w:message', { data: { pa: 'prefs', openAi: true } }); assert.equal(dom.L.raf.length, 0, 'other prefs schedule nothing');
  // back to the first layout: exactly the first placement again (round trip, no accumulated error)
  dom.L.cw = CW; dom.fire('w:resize', dom.ev('resize')); dom.flush();
  assert.deepEqual(I.placements()[0].at, at0, 'the round trip ends where it began');
  // the host rebuilt the list (innerHTML=''): render() re-appends the canvas and re-anchors by quote after a wording change
  dom.container.children.length = 0; I.canvas.parentNode = null;
  v16.en.childNodes = [{ nodeType: 3, data: 'For God loved the world so much' }];
  I.render();
  assert.equal(dom.container.children[0], I.canvas, 're-appended');
  r = dom.PAInkAnchor.measurer(v16.en).rangeRect(8, 13);
  assert.deepEqual(I.placements()[0].at, { ox: r.left + 1, oy: r.top + RH * 0.75, s: 1 }, '"loved" moved to 8..13: found by its quote');
  I.destroy(); assert.equal(dom.container.children.length, 0, 'destroy takes the canvas down');
});

// A scrub-out: `laps` passes back and forth over chars s..e of a line, at the row's middle.
function scrubStroke(dom, line, s, e, laps = 5, id = 8) {
  const a = dom.charRect(line, s), b = dom.charRect(line, e - 1), y = a.top + RH / 2, x0 = a.left + 1, x1 = b.left + CW - 1;
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: x0, clientY: y, pressure: 0.5 }));
  for (let i = 1; i <= laps * 2; i++) { const x = i % 2 ? x1 : x0; dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: x, clientY: y + (i % 2), pressure: 0.5 })); }
  dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: x0, clientY: y }));
}
const bucketAt = (dom, row = 0, rowH = 0) => { const M = dom.PAInkAnchor, r = dom.bucketEl().getBoundingClientRect(); return { ox: r.left + M.BUCKET_PADX, oy: r.top + M.LABEL_H + M.ROW_GAP + row * (rowH + M.ROW_GAP), s: 1 }; };

// ═══ phase 2: store shape, scrub eraser, orphan bucket ═══════════════════════════════════════
test('pack/unpack: one key per verse (vN, the host\'s dot key) plus the unanchored list; junk is skipped; a flat list passes through', () => {
  const { PAInkAnchor: M } = makeDom();
  const a = { verse: 16, lang: 'en', strokes: [] }, b = { verse: 16, lang: 'zh', strokes: [] }, c = { verse: 3, strokes: [] }, u = { verse: null, strokes: [] };
  const packed = M.pack([a, b, u, c]);
  assert.deepEqual(packed, { v16: [a, b], [M.UNANCHORED]: [u], v3: [c] });
  assert.deepEqual(M.unpack(packed), [a, b, u, c], 'round trip, order per key');
  assert.deepEqual(M.unpack({ v1: 'junk', v2: [null, { nope: 1 }, c], [M.UNANCHORED]: 7 }), [c], 'a damaged file never throws, keeps what is a group');
  assert.deepEqual(M.unpack([a, 0, c]), [a, c]); assert.deepEqual(M.unpack(undefined), []);
  assert.deepEqual(M.pack([]), {}, 'nothing drawn: an empty object in the chapter file');
});

test('isScrub: an underline, a circle and a "w" are ink; a back-and-forth over one spot is a scrub; the thresholds are overridable', () => {
  const { PAInkAnchor: M } = makeDom();
  const line = Array.from({ length: 12 }, (_, i) => ({ x: i * 5, y: 10 }));
  assert.equal(M.isScrub(line), false, 'an underline');
  const circle = Array.from({ length: 24 }, (_, i) => ({ x: 20 + 20 * Math.cos(i / 24 * 2 * Math.PI), y: 20 + 20 * Math.sin(i / 24 * 2 * Math.PI) }));
  assert.equal(M.isScrub(circle), false, 'a circled word');
  const w = [[0, 0], [5, 20], [10, 0], [15, 20], [20, 0]].map(([x, y]) => ({ x, y }));
  assert.equal(M.isScrub(w), false, 'a "w" (3 turns, short)');
  const scrub = []; for (let i = 0; i < 12; i++) scrub.push({ x: i % 2 ? 50 : 0, y: 10 + (i % 3) });
  assert.equal(M.isScrub(scrub), true, 'eleven reversals over a 50px box');
  assert.equal(M.isScrub(scrub, { turns: 20 }), false, 'a host may raise the bar');
  assert.equal(M.isScrub(scrub.slice(0, 6)), false, 'too few points to judge');
  assert.deepEqual(M.SCRUB, { turns: 4, density: 3, minPts: 8 }); assert.equal(M.ERASE_HIT, 12);
});

test('scrub-out over one of two groups erases exactly that group (the scrub is not kept); a scrub over nothing is ink', () => {
  const dom = makeDom({ width: 400 });
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  const changes = [];
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK, onChange: (packed, list) => changes.push({ packed, n: list.length }) });
  penStroke(dom, v16.en, 11, 16, 1);   // "loved"
  penStroke(dom, v16.en, 21, 26, 2);   // "world"
  assert.deepEqual(I.groups().map((g) => g.quote), ['loved', 'world']);
  assert.deepEqual(changes.at(-1), { packed: { v16: I.groups() }, n: 2 }, 'onChange hands the host the packed store');
  scrubStroke(dom, v16.en, 11, 16);
  assert.deepEqual(I.groups().map((g) => g.quote), ['world'], 'exactly the scrubbed group is gone; the scrub itself was not kept');
  assert.equal(changes.length, 3); assert.deepEqual(changes.at(-1).packed, { v16: I.groups() });
  // CONTROL: the same scrub where no ink lies is a stroke like any other (a dense scribble is a legitimate mark)
  scrubStroke(dom, v16.en, 0, 4);
  assert.deepEqual(I.groups().map((g) => g.quote), ['world', 'For'], 'kept as ink, anchored to the word under it');
  assert.equal(changes.length, 4);
  // a scrub across BOTH remaining groups takes both — the user scrubbed over them
  scrubStroke(dom, v16.en, 0, 26);
  assert.deepEqual(I.groups(), []); assert.deepEqual(changes.at(-1), { packed: {}, n: 0 }, 'an empty store, not a missing key');
  assert.equal(dom.container.children.filter((c) => c.className === 'pia-bucket').length, 0, 'no orphans, no bucket');
});

test('orphan bucket: a quote that vanished or a verse that is gone sits in the labelled bucket under the last verse; the text coming back empties it', () => {
  const dom = makeDom({ width: 400, childrenCount: true });
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  const M = dom.PAInkAnchor, I = M.attach({ container: dom.container, ink: ENG_INK });
  penStroke(dom, v16.en, 11, 16, 1);   // "loved"
  penStroke(dom, v16.en, 21, 26, 2);   // "world"
  assert.equal(dom.bucketEl(), undefined, 'both anchored: no bucket in the list');
  // BSB wording change keeping both words: re-anchored by quote, still no bucket
  v16.en.childNodes = [{ nodeType: 3, data: 'For God loved the world so much' }]; I.render();
  assert.equal(dom.bucketEl(), undefined); assert.deepEqual(I.placements().map((p) => p.orphan), [false, false]);
  // "world" gone → ONE row in the bucket; "loved" stays on its word
  v16.en.childNodes = [{ nodeType: 3, data: 'For God loved everyone so much' }]; I.render(); dom.flush();
  const b = dom.bucketEl();
  assert.ok(b && dom.container.children.at(-1) === b, 'the bucket is appended after the verses');
  assert.equal(b.children[0].textContent, M.BUCKET_TXT); assert.match(M.BUCKET_TXT, /^经文已改动的笔迹 · Ink whose text changed$/, '中文 then English');
  let pl = I.placements();
  assert.deepEqual(pl.map((p) => p.orphan), [false, true]);
  assert.deepEqual(pl[1].at, bucketAt(dom), 'the orphan draws at the bucket\'s first row, scale 1');
  const ext = M.extentOf(pl[1].g);
  assert.equal(b.style.height, (M.LABEL_H + ext.h + 2 * M.ROW_GAP) + 'px', 'the bucket is as tall as its rows');
  assert.ok(b.getBoundingClientRect().top >= dom.verses[1].zh.top, 'under the last verse');
  assert.equal(parseFloat(I.canvas.style.height), Math.round(dom.container.scrollHeight), 'the canvas covers the bucket');
  assert.ok(I.canvas.ctx.ops.filter((o) => o === 'stroke').length >= 2, 'both groups painted');
  // the verse itself gone (renumbering): both rows in the bucket, stacked
  dom.verses.length = 0; dom.addVerse(...VERSES[1]); I.render();
  pl = I.placements(); assert.deepEqual(pl.map((p) => p.orphan), [true, true]);
  assert.deepEqual(pl[0].at, bucketAt(dom)); assert.deepEqual(pl[1].at, bucketAt(dom, 1, M.extentOf(pl[0].g).h), 'second row under the first');
  assert.equal(I.groups().length, 2, 'never dropped');
  // the chapter re-rendered with the original text: everything back on its word, the bucket leaves the DOM
  dom.verses.length = 0; dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]); I.render();
  assert.deepEqual(I.placements().map((p) => p.orphan), [false, false]);
  assert.equal(dom.bucketEl(), undefined, 'no orphans: the bucket is removed, not hidden');
  I.destroy(); assert.equal(dom.container.children.length, 0, 'destroy takes the canvas and the bucket down');
});

// ═══ the shipped hosts ═══════════════════════════════════════════════════════════════════════
test('web.mjs registers PAInkAnchor then its pen sheet, then PAAppPrefs (only later components after it); PANote exports its renderer + guard once, and its own ink uses the guard', () => {
  const list = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('\n];', WEB.indexOf('const PA_COMPONENTS = [')));
  const files = [...list.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  const at = files.indexOf('ink-anchor.inline.html');
  assert.ok(at > 0, 'ink-anchor is registered');
  assert.equal(files[at + 1], 'ink-pen.inline.html', 'the pen sheet, appended right after it (the registry rule)');
  assert.equal(files[at + 2], 'app-prefs.inline.html', 'the page\'s one prefs chain, appended after it');
  assert.deepEqual(files.slice(-8), ['settings-rows.inline.html', 'tips.inline.html', 'panel-window.inline.html', 'app-bar.inline.html', 'bar-handle.css', 'reading-history.inline.html', 'ink-frame.inline.html', 'snap.inline.html'], 'the ⚙ tick-box rows, PATips, PAPaneChrome, PAAppBar, PAReadingHistory, PAInkFrame, then PASnap (ADR 0040), appended last since');
  assert.ok(files.indexOf('ink-frame.inline.html') > at, 'PAInkFrame after PAInkAnchor: its marker is inside ink-anchor, so the in-order loop finds it only then');
  assert.ok(files.indexOf('note-ui.inline.html') < files.indexOf('ink-anchor.inline.html'));
  assert.match(ENGINE, /ink:Object\.freeze\(\{drawStroke,drawFlat,segTo,segWidth,guardInk,MAX_CANVAS_PX,HILITE_ALPHA\}\)/, 'PANote.ink');
  for (const sym of ['function drawStroke', 'function drawFlat', 'function segTo', 'const segWidth', 'function guardInk']) assert.equal(ENGINE.split(sym).length, 2, `${sym} is defined once`);
  assert.match(ENGINE, /\n    guardInk\(ink\);/, 'the pad\'s ink surface uses the shared guard');
  // REGRESSION: guardInk is hoisted OUTSIDE the PA_POINTER_ROUTING block the routing harness runs verbatim,
  // so the harness must supply the engine's own guard — 8 routing suites threw 'guardInk is not a function'.
  const pad = runPad({ tool: 'pen' }); const t = [{ id: 20, x: 30, y: 300 }];
  assert.equal(pad.S.guardInk, ENG_INK.guardInk, 'the routing scope carries the engine\'s hoisted guard, not a retype');
  assert.ok(pad.touch(pad.ink, 'touchstart', { touches: t, changed: t }).defaultPrevented, 'the pad\'s ink still prevents a touch through the shared guard');
  assert.doesNotMatch(COMPONENT, /function\s+(drawStroke|drawFlat|segTo|segWidth)\b/, 'the component defines no renderer of its own');
  for (const app of ['bible (template)', 'bible (live)']) {
    assert.ok(APP_SRC[app].includes('<!--PA_INK_ANCHOR_UI-->'), `${app} carries the marker`);
    assert.match(APP_SRC[app], /VM\.render\(\); INK\.render\(\);/, `${app}: renderVerses re-anchors`);
    assert.match(APP_SRC[app], /ANN\.ink=migrateKeys\(o\.ink\|\|\{\}\);/, `${app}: read back on load, or the next note save deletes the ink`);
    assert.match(APP_SRC[app], /const annOk=await loadAnn\(\); if\(g!==_loadSeq\) return false;[^\n]*\n  if\(annOk\)\{ followSelection\(\); INK\.load\(ANN\.ink\); \}/, `${app}: the chapter's ink is loaded before its text`);
    assert.match(APP_SRC[app], /enabled:\(\)=>!ANN_BLOCKED&&!ANN_LOADING,\n  onChange:async packed=>\{ ANN\.ink=packed; renderDots\(\); return saveInk\(\); \}/, `${app}: the store is ANN.ink through saveInk (one coalescing save chain per chapter, over saveAnnAt); an unreadable chapter takes no ink`);
    assert.doesNotMatch(APP_SRC[app], /Ink whose text changed|经文已改动/, `${app}: the bucket label lives in the component once (R3)`);
  }
});

const CHAPTER = 'notes/43-3.json';   // John 3, the app's boot chapter
for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: a Pencil stroke lands in ANN.ink of the chapter file through the app's own save; load() reads it back; a wording change re-anchors, a lost phrase buckets, a scrub erases one group`, async () => {
    const h = await startHarness('bible');
    try {
      const dom = makeDom({ width: 400 });
      // The test's fake-DOM copy of the component, attached over the fake list (the app's #verses is a bare fakeEl with no layout).
      const PAInkAnchor = { ...dom.PAInkAnchor, attach: (o) => dom.PAInkAnchor.attach({ ...o, container: dom.container }) };
      const A = runApp(app, h.relay, ['INK', 'renderVerses', 'annotatedVerses', 'load', 'get ANN(){return ANN}'], { clampTimers: true, globals: { PAInkAnchor } });
      await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
      const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
      A.renderVerses(VERSES.map(([n, en, zh]) => ({ n, en, zh })));
      assert.deepEqual(A.INK.groups(), [], 'an absent chapter file: no ink'); assert.ok(!fs.existsSync(h.file(CHAPTER)));
      penStroke(dom, v16.en, 11, 16);
      await until(() => fs.existsSync(h.file(CHAPTER)), 'the stroke is saved');
      let file = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.equal(file.ink.v16.length, 1); assert.deepEqual([file.ink.v16[0].quote, file.ink.v16[0].charStart, file.ink.v16[0].charEnd], ['loved', 11, 16]);
      assert.deepEqual(Object.keys(file).sort(), ['chat', 'draws', 'ink', 'notes', 'pins', 'titles'], 'in the same chapter file as the notes (marks is created on first use)');
      assert.ok(A.annotatedVerses().has(16) && !A.annotatedVerses().has(17), 'the dot counts ink');
      // a fresh load of the chapter: the file comes back through the broker; the text is re-rendered with a wording change
      A.INK.clear(); await until(() => !JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).ink.v16, 'clear is an erase-all, saved');
      fs.writeFileSync(h.file(CHAPTER), JSON.stringify({ ...file, notes: { v3: 'kept' } }));
      await A.load();
      assert.equal(A.INK.groups().length, 1, 'read back from the chapter file'); assert.equal(A.ANN.notes.v3, 'kept');
      v16.en.childNodes = [{ nodeType: 3, data: 'For God loved the world so much' }];
      A.renderVerses([{ n: 16, en: 'For God loved the world so much', zh: VERSES[0][2] }]);
      const r = dom.PAInkAnchor.measurer(v16.en).rangeRect(8, 13);
      assert.deepEqual(A.INK.placements()[0].at, { ox: r.left + 1, oy: r.top + RH * 0.75, s: 1 }, '"loved" at 8..13: found by its quote');
      v16.en.childNodes = [{ nodeType: 3, data: 'God cherished the world' }];
      A.renderVerses([{ n: 16, en: 'God cherished the world', zh: VERSES[0][2] }]);
      assert.deepEqual([A.INK.placements()[0].orphan, A.INK.placements()[0].at], [true, bucketAt(dom)], 'the phrase is gone: the bucket, never dropped');
      assert.equal(JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).ink.v16.length, 1, 'a render never writes');
      // a second group, then a scrub over the first row of the bucket: exactly that group goes, through the same save
      penStroke(dom, v16.en, 0, 3);
      await until(() => JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).ink.v16.length === 2, 'two groups saved');
      const at = bucketAt(dom), ext = dom.PAInkAnchor.extentOf(A.INK.groups()[0]), id = 5, y = at.oy + ext.h / 2;
      dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: at.ox, clientY: y }));
      for (let i = 1; i <= 10; i++) dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: i % 2 ? at.ox + ext.w : at.ox, clientY: y + (i % 2) }));
      dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: at.ox, clientY: y }));
      assert.deepEqual(A.INK.groups().map((g) => g.quote), ['God'], 'the bucketed group erased, the other kept');
      await until(() => JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).ink.v16.length === 1, 'the erase is saved');
      assert.equal(JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).notes.v3, 'kept', 'the rest of the chapter file is untouched');
    } finally { await h.stop(); }
  });
}

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: boot mounts PAInkAnchor over #verses; renderVerses re-appends the canvas and re-anchors the loaded groups`, async () => {
    const h = await startHarness('bible');
    try {
      const dom = makeDom({ width: 400 }); const v16 = dom.addVerse(...VERSES[0]);
      // The test's own copy of the component, so its fake Range measures the text; the served page carries it inlined ahead of the app's script.
      const A = runApp(app, h.relay, ['INK', 'renderVerses'], { clampTimers: true, globals: { PAInkAnchor: dom.PAInkAnchor } });
      await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
      const wrap = A.els.get('verses');
      assert.ok(A.INK && A.INK.canvas, 'mounted at boot with the engine\'s renderer');
      assert.equal(wrap.style.position, 'relative');
      // the list as renderVerses builds it, with a layout the fake DOM measures
      wrap.querySelectorAll = (sel) => (sel === '.verse' ? dom.verses : []);
      wrap.getBoundingClientRect = dom.container.getBoundingClientRect;
      Object.defineProperty(wrap, 'scrollHeight', { get: () => dom.container.scrollHeight });
      const appended = []; wrap.appendChild = (c) => { c.parentNode = wrap; appended.push(c); };
      A.INK.load([{ verse: 16, lang: 'en', charStart: 11, charEnd: 16, quote: 'loved', dx: 1, dy: 18, w: 50, strokes: [{ p: [[0, 0], [48, 0]], c: '#000', w: 2, t: 'pen' }] }]);
      assert.equal(appended.pop(), A.INK.canvas, 'load re-appended the canvas the harness never held');
      A.INK.canvas.parentNode = null;
      A.renderVerses([{ n: 16, en: VERSES[0][1], zh: VERSES[0][2] }]);
      assert.equal(appended.pop(), A.INK.canvas, 'renderVerses → INK.render(): the canvas is back after innerHTML=\'\'');
      const r = dom.PAInkAnchor.measurer(v16.en).rangeRect(11, 16);
      assert.deepEqual(A.INK.placements()[0].at, { ox: r.left + 1, oy: r.top + 18, s: 1 }, 'and the group sits on "loved" in the live list');
    } finally { await h.stop(); }
  });
}

// ═══ the read window ═════════════════════════════════════════════════════════════════════════
// loadAnn() resets ANN synchronously, then awaits the broker. Before the gate, a Pencil stroke
// on the still-visible list in that window saved the EMPTY ANN over the chapter: notes and marks
// wiped on disk (reproduced through the real broker). Now the overlay is disabled while a read is
// in flight: the stroke is dropped, nothing is written, and the file keeps every key.
for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: a Pencil stroke during loadAnn's read window writes nothing — notes and marks survive on disk`, async () => {
    const h = await startHarness('bible');
    try {
      const dom = makeDom({ width: 400 });
      const PAInkAnchor = { ...dom.PAInkAnchor, attach: (o) => dom.PAInkAnchor.attach({ ...o, container: dom.container }) };
      const A = runApp(app, h.relay, ['INK', 'renderVerses', 'load', 'get ANN(){return ANN}'], { clampTimers: true, globals: { PAInkAnchor } });
      await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
      const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
      A.renderVerses(VERSES.map(([n, en, zh]) => ({ n, en, zh })));
      const seeded = { notes: { v3: 'kept' }, draws: {}, chat: {}, titles: {}, pins: {}, marks: { v5: [{ s: 0, e: 3, c: 'y' }] } };
      fs.mkdirSync(path.dirname(h.file(CHAPTER)), { recursive: true });
      fs.writeFileSync(h.file(CHAPTER), JSON.stringify(seeded));
      const loading = A.load();                 // not awaited: ANN is already reset, the read is in flight
      penStroke(dom, v16.en, 11, 16);           // the pen lands in the window
      assert.deepEqual(A.INK.groups(), [], 'the overlay is gated while the read is in flight: no group');
      await loading;
      const file = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.equal(file.notes.v3, 'kept', 'the note survives on disk');
      assert.deepEqual(file.marks, seeded.marks, 'the verse marks survive on disk');
      assert.equal(file.ink, undefined, 'the stroke was not saved');
      assert.equal(A.ANN.notes.v3, 'kept'); assert.deepEqual(A.INK.groups(), [], 'and not kept in memory either');
      // after the read the pen works again, through the same save, and the seeded keys are still there
      penStroke(dom, v16.en, 11, 16, 8);
      await until(() => (JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).ink || {}).v16, 'a stroke after the read is saved');
      const after = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.equal(after.notes.v3, 'kept'); assert.deepEqual(after.marks, seeded.marks);
    } finally { await h.stop(); }
  });
}

// REGRESSION (the other order): the pen is DOWN before the read starts — pointerdown passed the gate,
// then a finger taps the next chapter (or the ☰ re-read) while the pen rests on the page, and the pen
// lifts. onUp used to anchor + save the stroke over the already-reset ANN: notes and marks wiped on
// disk. The gate is re-checked at pointerup: the stroke is dropped, nothing is written.
for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: pen down → chapter read starts → pen up writes nothing — notes and marks survive on disk`, async () => {
    const h = await startHarness('bible');
    try {
      const dom = makeDom({ width: 400 });
      const PAInkAnchor = { ...dom.PAInkAnchor, attach: (o) => dom.PAInkAnchor.attach({ ...o, container: dom.container }) };
      const A = runApp(app, h.relay, ['INK', 'renderVerses', 'load', 'get ANN(){return ANN}'], { clampTimers: true, globals: { PAInkAnchor } });
      await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
      const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
      A.renderVerses(VERSES.map(([n, en, zh]) => ({ n, en, zh })));
      const seeded = { notes: { v3: 'kept' }, draws: {}, chat: {}, titles: {}, pins: {}, marks: { v5: [{ s: 0, e: 3, c: 'y' }] } };
      fs.mkdirSync(path.dirname(h.file(CHAPTER)), { recursive: true });
      fs.writeFileSync(h.file(CHAPTER), JSON.stringify(seeded));
      await A.load();                           // the seeded chapter is in: the gate is open
      assert.equal(A.ANN.notes.v3, 'kept');
      const a = dom.charRect(v16.en, 11), b = dom.charRect(v16.en, 15), y = a.top + RH * 0.75, id = 9;
      dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: a.left + 1, clientY: y, pressure: 0.6 }));
      dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: b.left, clientY: y + 1, pressure: 0.6 }));
      assert.ok(A.INK.isDrawing(), 'the pen is down, past the gate');
      const loading = A.load();                 // a chapter read starts under the pen: ANN is reset synchronously
      dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: b.left + CW - 1, clientY: y }));
      assert.deepEqual(A.INK.groups(), [], 'the stroke is dropped at pointerup: the gate is closed');
      await loading;
      const file = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.equal(file.notes.v3, 'kept', 'the note survives on disk');
      assert.deepEqual(file.marks, seeded.marks, 'the verse marks survive on disk');
      assert.equal(file.ink, undefined, 'no ink key was written');
      assert.equal(A.ANN.notes.v3, 'kept'); assert.deepEqual(A.INK.groups(), []);
      // the pen works again after the read, through the same save, with the seeded keys intact
      penStroke(dom, v16.en, 11, 16, 10);
      await until(() => (JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).ink || {}).v16, 'a stroke after the read is saved');
      const after = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.equal(after.notes.v3, 'kept'); assert.deepEqual(after.marks, seeded.marks);
    } finally { await h.stop(); }
  });
}
