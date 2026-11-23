// What simplify() cuts down and what it puts in place · 简化：尺寸上限与替代颜色 (ADR 0003 amendment 5, R13 round 1)
//
// SCAR (2026-10-13, a real Sonnet run on this branch): "a glowing neon love note with soft shadows" took 127 s, then was
// refused "Rejected · 已拒绝 — filter region too large" (test/fixtures/stationery-rejected-region.svg, the model's answer
// byte for byte but two path separators: ADR 0003 R13 round 2). That limit ran BEFORE the budget, so simplify() never saw the design. A filter's region and steps, a
// turbulence's octaves and a gradient's stops are SIZES, not dangers: sanitize() now marks such a refusal `limit` — only
// when every other rule passed — and simplify() cuts the element down before the budget's steps.
// Also pinned, each a confirmed R13 round 1 finding, against the SHIPPED components:
//   · a pattern made plain keeps its look: a faint texture stays faint (its tile's painted share), not a solid page;
//   · a gradient made plain keeps its stop-opacity: a fade from clear stays see-through, not an opaque cover;
//   · both keep the shape's own (or inherited) fill-opacity; an empty opacity is no opacity, not 0;
//   · a refused pattern step is undone with every attribute as it was; a step that throws is shown after "Rejected".
// Mutation evidence at the end; each mutant must match the shipped text exactly once, or the helper fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, FP, loadStill, loadStudio, svg, LG, unevenStops, heartsOf, XmlDomParser, simplifiedNote as note, answerWith as answer,
  countMatches as count, replaceOnce as san } from './helpers-stationery.mjs';

const NEON = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'stationery-rejected-region.svg'), 'utf8');
const S = loadStill();
const REJECTED = '已拒绝 · Rejected — ';
const BIG_NOTE = note('oversized shadows and glows', '过大的阴影和发光效果');

// ── 1. The size limits: cut down, not thrown away ─────────────────────────────────────────────────────────────
test('the real neon draft (2026-10-13): refused for a filter region, every other rule passed; simplify() accepts it', () => {
  const a = S.sanitize(NEON);
  assert.deepEqual([a.ok, a.reason, a.limit, a.over], [false, 'filter region too large', true, undefined], 'sanitize() still refuses it');
  assert.equal(Math.round(a.cost), 169487, 'a limit refusal carries its price (R13 round 2: pinned, not read back through sanitize)');
  const r = S.simplify(NEON);
  assert.equal(r.ok, true, r.reason); assert.ok(r.cost <= 5000);
  // the two oversized glows went first; still over the budget, every filter went: one kind, so one name
  assert.equal(r.note, note('shadows and glows', '阴影和发光效果'));
  assert.doesNotMatch(r.svg, /<filter|filter=/);
  assert.equal(count(r.svg, / opacity="/g), count(NEON, / opacity="/g), 'every opacity kept');
  assert.equal(count(r.svg, /Gradient id=/g), count(NEON, /Gradient id=/g), 'every gradient kept');
  const again = S.sanitize(r.svg);
  assert.deepEqual([again.ok, again.svg, again.cost], [true, r.svg, r.cost], 'what is drawn is exactly what the whole check passed');
});
const OK_F = '<filter id="k"><feGaussianBlur stdDeviation="2"/></filter>';   // inside every limit: kept, the control
const LIMITED = {
  'a filter region 3x the shape': ['<filter id="big" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="9"/></filter>', 'filter region too large'],
  'a 9-step filter': ['<filter id="big">' + '<feOffset dx="1"/>'.repeat(9) + '</filter>', 'a filter has more than 8 steps'],
  'a turbulence of 9 octaves': ['<filter id="big"><feTurbulence baseFrequency="0.9" numOctaves="9"/></filter>', 'numOctaves above 8'],
};
const BIG = LIMITED['a filter region 3x the shape'][0];
const limited = (def) => svg(`<defs>${OK_F}${def}</defs><circle r="9" fill="#fcc" filter="url(#big)"/><circle r="8" filter="url(#k)"/>`);
for (const [what, [def, why]] of Object.entries(LIMITED)) {
  test(`${what}: refused as before, marked limit; simplify() takes out that filter alone, and the shape stays`, () => {
    const d = limited(def), a = S.sanitize(d);
    assert.deepEqual([a.ok, a.reason, a.limit, a.over], [false, why, true, undefined]);
    const r = S.simplify(d);
    assert.equal(r.ok, true, r.reason); assert.equal(r.note, BIG_NOTE);
    assert.doesNotMatch(r.svg, /big/, 'the filter and every filter="url(#big)" are gone');
    assert.match(r.svg, /<circle r="9" fill="#fcc"\/>/, 'the shape it was on is drawn, without it');
    assert.match(r.svg, /<filter id="k">/); assert.match(r.svg, /<circle r="8" filter="url\(#k\)"\/>/, 'a filter inside its limits is kept');
  });
}
test('a gradient of 40 stops: refused as before, marked limit; simplify() keeps 16 of them, the first and the last', () => {
  const stops = unevenStops(40), first = stops.match(/<stop[^>]*>/g)[0], last = stops.match(/<stop[^>]*>/g)[39];
  const d = svg(`<defs><linearGradient id="g">${stops}</linearGradient>${LG}</defs><rect ${FP} fill="url(#g)"/><circle r="9" fill="url(#lg)"/>`);
  const a = S.sanitize(d); assert.deepEqual([a.reason, a.limit], ['a gradient has more than 16 stops', true]);
  const r = S.simplify(d);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('some gradient colour stops', '部分渐变色标'));
  const g = r.svg.match(/<linearGradient id="g">(.*?)<\/linearGradient>/)[1];
  assert.equal(count(g, /<stop/g), 16); assert.ok(g.startsWith(first) && g.endsWith(last), 'its ends keep their colours');
  assert.match(r.svg, /fill="url\(#g\)"/, 'still a gradient'); assert.match(r.svg, /<linearGradient id="lg"><stop offset="0" stop-color="#fff"\/><stop offset="1" stop-color="#ccd"\/>/);
});
test('limits and the budget add up; a later step of the same kind names it once', () => {
  const both = S.simplify(svg(`<defs>${BIG}<linearGradient id="g">${unevenStops(40)}</linearGradient></defs><circle r="9" filter="url(#big)"/><rect ${FP} fill="url(#g)"/>`));
  assert.equal(both.note, note('oversized shadows and glows, some gradient colour stops', '过大的阴影和发光效果、部分渐变色标'));
  // R13 round 2: after the limit's steps the savings bar is THEIR cost, so folding a one-paint circle (no layer) saves nothing: undone
  const dashes = S.simplify(svg(`<defs>${BIG}</defs><circle r="9" filter="url(#big)"/><circle cx="50" cy="50" r="20" fill="#c33" opacity="0.5"/>`
    + '<path fill="none" stroke="#000" stroke-dasharray="0.01" d="M0 0H816"/>'.repeat(3)));
  assert.equal(dashes.note, note('oversized shadows and glows, dashes', '过大的阴影和发光效果、虚线'), 'the limit\'s step is named with the budget\'s');
  assert.match(dashes.svg, /<circle cx="50" cy="50" r="20" fill="#c33" opacity="0.5"\/>/, 'a step that saved nothing is not kept');
  const filters = S.simplify(svg(`<defs>${OK_F}${BIG}</defs><circle r="9" filter="url(#big)"/>${'<circle cx="40" cy="40" r="9" fill="#fcc" filter="url(#k)"/>'.repeat(30)}`));
  assert.equal(filters.note, note('shadows and glows', '阴影和发光效果'), 'every filter went: the oversized one is not named twice');
  const grads = S.simplify(svg(`<defs><linearGradient id="g">${unevenStops(40)}</linearGradient></defs>${`<rect ${FP} fill="url(#g)"/>`.repeat(92)}`));
  assert.equal(grads.note, note('gradients', '渐变')); assert.doesNotMatch(grads.svg, /Gradient/);
  const stray = S.simplify(svg('<rect width="9" height="9" fill="#fcc" numOctaves="99"/>'));   // on no filter: draws nothing, dropped
  assert.deepEqual([stray.ok, stray.svg && /numOctaves/.test(stray.svg)], [true, false], stray.reason);
});
test('a limit no step can take out keeps its own reason, shown after "已拒绝 · Rejected" (a <use> names the filter)', async () => {
  const d = svg(`<defs>${BIG}</defs><use href="#big"/><circle r="9" filter="url(#big)"/>`), a = S.sanitize(d);
  assert.equal(a.limit, true);
  assert.deepEqual(S.simplify(d), { ok: false, reason: 'filter region too large', cost: a.cost });
  assert.deepEqual(await loadStudio(S).design(answer(d), 'x'), { ok: false, convoId: 'c1', reason: REJECTED + 'filter region too large' });
});

// ── R14: `limit` is set only when every OTHER rule passed; simplify never launders an attack out with the filter ─────
const UNSAFE = {
  'event handler INSIDE the oversized filter': svg(`<defs><filter id="big" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="9" onload="alert(1)"/></filter></defs><circle r="9" filter="url(#big)"/>`),
  'event handler after it': svg(`<defs>${BIG}</defs><circle r="9" filter="url(#big)"/><circle r="9" onload="alert(1)"/>`),
  'external url() in a stop of a 17-stop gradient': svg(`<defs><linearGradient id="g">${unevenStops(16)}<stop offset="1" stop-color="url(https://evil.example/x.svg#a)"/></linearGradient></defs><rect ${FP} fill="url(#g)"/>`),
  'a <script> beside it': svg(`<defs>${BIG}</defs><circle r="9" filter="url(#big)"/><script>parent.postMessage({pa:"req"},"*")</script>`),
  'a loop': svg(`<defs>${BIG}<g id="a"><use href="#a"/></g></defs><circle r="9" filter="url(#big)"/>`),
  'a mask that uses a filter (the nested rule)': svg(`<defs>${BIG}${OK_F}<mask id="m"><rect width="9" height="9" filter="url(#k)"/></mask></defs><circle r="9" filter="url(#big)"/><rect width="9" height="9" mask="url(#m)"/>`),
  'a <use> to a missing id': svg(`<defs>${BIG}</defs><circle r="9" filter="url(#big)"/><use href="#nope"/>`),
};
test('R14: a design over a limit AND refused by any other rule is refused by that rule, unchanged; its safe twin IS simplified', async () => {
  const twin = svg(`<defs>${BIG}</defs><circle r="9" filter="url(#big)"/>`);
  assert.equal(S.sanitize(twin).limit, true); assert.equal(S.simplify(twin).ok, true, 'control: the limit alone is cut down');
  for (const [what, d] of Object.entries(UNSAFE)) {
    const a = S.sanitize(d);
    assert.equal(a.ok, false, what); assert.notEqual(a.limit, true, `${what}: not marked limit`); assert.notEqual(a.over, true, what);
    assert.notEqual(a.reason, 'filter region too large', `${what}: the other rule's own reason`);
    assert.deepEqual(S.simplify(d), a, `${what}: sanitize()'s own refusal, unchanged`);
    assert.deepEqual(await loadStudio(S).design(answer(d), 'x'), { ok: false, convoId: 'c1', reason: REJECTED + a.reason }, what);
  }
});
// R13 round 2: the browser's own parse is a rule too, read BEFORE `limit` and `over`. Chromium refuses result="a&#xFFFF;" (U+FFFF
// is not XML: measured); XmlDomParser stands in for it in Node, where sanitize() otherwise has no DOMParser and skips the check.
const NON_XML = '<feGaussianBlur stdDeviation="2" result="a&#xFFFF;"/>';
const PARSED = { limit: svg(`<defs><filter id="big" x="-1" y="-1" width="3" height="3">${NON_XML}</filter></defs><circle r="9" filter="url(#big)"/>`),
  over: svg(`<defs><filter id="f">${NON_XML}</filter></defs>${'<circle cx="40" cy="40" r="9" fill="#fcc" filter="url(#f)"/>'.repeat(30)}`) };
test('R14: a design the browser parses differently is refused for that, over a limit or the budget too — never simplified', async () => {
  const B = loadStill({ DOMParser: XmlDomParser });
  for (const [flag, d] of Object.entries(PARSED)) {
    assert.equal(S.sanitize(d)[flag], true, `${flag}: with no browser check (Node), the design is marked ${flag}`);
    const a = B.sanitize(d); assert.deepEqual(a, { ok: false, reason: 'the browser parses it differently' }, flag);
    assert.deepEqual(B.simplify(d), a, `${flag}: refused unchanged, though the step would take that filter out`);
    assert.deepEqual(await loadStudio(B).design(answer(d), 'x'), { ok: false, convoId: 'c1', reason: REJECTED + a.reason }, flag);
    assert.equal(B.simplify(d.replace('&#xFFFF;', '')).ok, true, `${flag}: its twin without U+FFFF IS simplified (the control)`);
  }
});

// ── 2. A pattern made plain keeps its look ────────────────────────────────────────────────────────────────────
const FAINT = '<pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.2" fill="#333" opacity="0.5" fill-opacity="0.7"/></pattern>';
const PATTERNS = svg(`<defs>${FAINT}`
  + '<pattern id="q" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#fee"/><circle cx="5" cy="5" r="2" fill="#c33"/></pattern>'
  + '<pattern id="h" width="10" height="10" patternUnits="userSpaceOnUse"><line x1="0" y1="10" x2="10" y2="0" stroke="#99a" stroke-width="2"/></pattern>'
  + '<pattern id="o" width="0.1" height="0.1"><rect width="5" height="10" fill="#acd"/></pattern>'
  + '<pattern id="v" width="20" height="20" viewBox="0 0 2 2" patternUnits="userSpaceOnUse"><rect width="1" height="2"/></pattern>'
  + '<pattern id="c" width="10" height="10" patternUnits="userSpaceOnUse"><rect x="-50" y="-50" width="100" height="100" fill="#ddd" fill-opacity="0.1"/><rect width="5" height="10" fill="#acd"/></pattern>'
  + '<pattern id="z" width="-10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#f00"/></pattern>'
  + '<linearGradient id="tf"><stop offset="0" stop-color="#c33" stop-opacity="0"/><stop offset="1" stop-color="#c33"/></linearGradient>'
  + '<pattern id="gt" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="url(#tf)"/></pattern></defs>'
  + `<rect ${FP} fill="#fffaf2"/><rect ${FP} fill="url(#d)"/><rect ${FP} fill="url(#d)" fill-opacity="0.5"/>`
  + '<rect width="99" height="99" fill="url(#q)"/><rect width="98" height="98" fill="url(#h)"/><rect width="100" height="100" fill="url(#o)"/>'
  + '<rect width="97" height="97" fill="url(#v)"/><rect width="96" height="96" fill="url(#c)"/><rect width="95" height="95" fill="url(#z)"/><rect width="94" height="94" fill="url(#gt)"/>'
  + heartsOf('d', 45));
test('a faint page-wide texture stays faint: the tile\'s painted share, times its opacities and the shape\'s own', () => {
  assert.equal(S.sanitize(PATTERNS).over, true, 'over the budget because of its patterns');
  const r = S.simplify(PATTERNS);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  // dots r=1.2 on a 20 x 20 tile (1.13%) x fill-opacity 0.7 x opacity 0.5 = 0.4%: not a solid #333 page (the R13 scenario)
  assert.match(r.svg, new RegExp(`<rect ${FP} fill="#fffaf2"/><rect ${FP} fill="#333" fill-opacity="0.004"/>`));
  assert.match(r.svg, new RegExp(`<rect ${FP} fill="#333" fill-opacity="0.002"/>`), 'its own fill-opacity 0.5 is kept');
  assert.doesNotMatch(r.svg, /fill="#333"\/>/, 'nothing painted solid #333');
  assert.match(r.svg, /<rect width="99" height="99" fill="#fee"\/>/, 'a tile filled edge to edge stays solid, in the colour covering most');
  assert.match(r.svg, /<rect width="98" height="98" fill="#99a" fill-opacity="0.2828"\/>/, 'a hatch: its stroke, length x width (a line fills nothing)');
  assert.match(r.svg, /<rect width="100" height="100" fill="#acd" fill-opacity="0.5"\/>/, 'a tile in the shape\'s box: 10 x 10 here');
  assert.match(r.svg, /<rect width="97" height="97" fill="#000" fill-opacity="0.5"\/>/, 'a tile with a viewBox, its shape in the default black');
  assert.match(r.svg, /<rect width="96" height="96" fill="#acd" fill-opacity="0.6"\/>/, 'a shape past its tile counts the tile at most');
  assert.match(r.svg, /<rect width="95" height="95" fill="none"\/>/, 'a tile of no (or a negative) size paints nothing');
  assert.match(r.svg, /<rect width="94" height="94" fill="#c33" fill-opacity="0.5"\/>/, 'a tile shape painted with a gradient: its plain colour');
});

// ── 3. A gradient made plain keeps its stop-opacity ──────────────────────────────────────────────────────────
const FADE = '<linearGradient id="fade"><stop offset="0" stop-color="#c33" stop-opacity="0"/><stop offset="1" stop-color="#c33"/></linearGradient>';
const VIGNETTE = '<radialGradient id="vig"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.3"/></radialGradient>';
const CLEAR = '<linearGradient id="clear"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>';
const ODD = '<linearGradient id="empty"/><linearGradient id="ink"><stop offset="0"/></linearGradient>'   // no stop; a stop with no colour (black)
  + '<linearGradient id="odd"><stop offset="0" stop-color="#fff" stop-opacity="0.2"/><stop offset="1" stop-color="url(#lg)"/></linearGradient>'   // a url() colour: black
  + '<linearGradient id="back"><stop offset="0.6" stop-color="#00f"/><stop offset="0.2" stop-color="#0f0" stop-opacity="0"/></linearGradient>';   // an offset below the last is the last
const GRADIENTS = svg(`<defs>${LG}${FADE}${VIGNETTE}${CLEAR}${ODD}</defs>${`<rect ${FP} fill="url(#lg)"/>`.repeat(88)}`
  + `<circle cx="408" cy="528" r="40" fill="red"/><rect ${FP} fill="url(#vig)"/>`
  + '<rect width="816" height="300" fill="url(#fade)"/><rect width="816" height="300" fill="url(#fade)" fill-opacity="0.5"/>'
  + '<g fill-opacity="0.5"><rect width="9" height="9" fill="url(#fade)"/></g><path d="M0 0L816 10" fill="none" stroke="url(#fade)"/><rect width="9" height="9" fill="url(#clear)"/>'
  + '<rect width="8" height="8" fill="url(#empty)"/><rect width="7" height="7" fill="url(#ink)"/><rect width="6" height="6" fill="url(#odd)"/><rect width="5" height="5" fill="url(#back)"/>');
test('a fade from clear stays see-through: the mean stop-opacity, in the colour of the stop covering most', () => {
  assert.equal(S.sanitize(GRADIENTS).over, true, 'over the budget because of its gradients');
  const r = S.simplify(GRADIENTS);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('gradients', '渐变'));
  // the R13 scenario: a vignette whose first stop is clear #fff became an opaque white page over the red circle
  assert.match(r.svg, new RegExp(`<circle cx="408" cy="528" r="40" fill="red"/><rect ${FP} fill="#000" fill-opacity="0.15"/>`));
  assert.match(r.svg, /<rect width="816" height="300" fill="#c33" fill-opacity="0.5"\/>/, 'clear to #c33: half on average');
  assert.match(r.svg, /<rect width="816" height="300" fill="#c33" fill-opacity="0.25"\/>/, 'its own fill-opacity is multiplied');
  assert.match(r.svg, /<g fill-opacity="0.5"><rect width="9" height="9" fill="#c33" fill-opacity="0.25"\/><\/g>/, 'and an inherited one');
  assert.match(r.svg, /<path d="M0 0L816 10" fill="none" stroke="#c33" stroke-opacity="0.5"\/>/, 'a stroke: stroke-opacity (a level one draws nothing: stationery-simplify-paint)');
  assert.match(r.svg, /<rect width="9" height="9" fill="none"\/>/, 'all clear: none');
  assert.match(r.svg, /<rect width="8" height="8" fill="none"\/><rect width="7" height="7" fill="#000"\/><rect width="6" height="6" fill="#000" fill-opacity="0.6"\/>/,
    'no stop: none; a stop with no colour, or a url() one: black, as Chromium draws it');
  assert.match(r.svg, /<rect width="5" height="5" fill="#00f" fill-opacity="0.6"\/>/, 'offsets never go back: 0.6, then 0.6');
  assert.match(r.svg, new RegExp(`<rect ${FP} fill="#fff"/>`), 'an opaque gradient stays opaque (LG: #fff to #ccd)');
});

// ── 5. An empty opacity is no opacity ────────────────────────────────────────────────────────────────────────
test('opacity="" or " " is unreadable, as Chromium reads it: taken off, never folded in as 0 (the element stays drawn)', () => {
  const layers = '<g opacity="0.5"><circle cx="40" cy="40" r="9" fill="#fcc"/></g>'.repeat(460);
  const r = S.simplify(svg(`${layers}<g opacity=""><circle r="9" fill="#c33" stroke="#000"/></g><g opacity=" "><rect width="9" height="9" fill="#c33" stroke="#000"/></g>`));
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('see-through layers', '半透明图层'));
  assert.match(r.svg, /<g><circle r="9" fill="#c33" stroke="#000"\/><\/g><g><rect width="9" height="9" fill="#c33" stroke="#000"\/><\/g>/);
  assert.doesNotMatch(r.svg, /-opacity="0"/);
  // R13 round 1 (m3): a SHAPE with fill and stroke is a layer too, and is folded like a group
  const shapes = S.simplify(svg('<circle cx="40" cy="40" r="9" fill="#fcc" stroke="#c99" opacity="0.5"/>'.repeat(460)));
  assert.equal(shapes.note, note('see-through layers', '半透明图层'), shapes.reason);
  assert.equal(count(shapes.svg, /<circle cx="40" cy="40" r="9" fill="#fcc" stroke="#c99" fill-opacity="0.5" stroke-opacity="0.5"\/>/g), 460);
});

// ── 6. A refused step is undone with every attribute as it was (copy() slices each pair: R13 round 1) ────────────
const TILE_T = '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect id="t" width="4" height="4" fill="#eee"/></pattern>';
const P_REFUSED = svg(`<defs>${TILE_T}${LG}</defs><use href="#t"/>${'<circle cx="40" cy="40" r="9" fill="url(#p)" fill-opacity="0.5"/>'.repeat(5)}${`<rect ${FP} fill="url(#lg)"/>`.repeat(90)}`);
test('a refused pattern step is undone with every attribute as it was: the gradients step after it sees the original paint', () => {
  assert.equal(S.sanitize(P_REFUSED).over, true);
  const r = S.simplify(P_REFUSED);   // the pattern step strands <use href="#t">: refused, undone; the gradient step fits
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('gradients', '渐变'));
  assert.equal(count(r.svg, /<circle cx="40" cy="40" r="9" fill="url\(#p\)" fill-opacity="0.5"\/>/g), 5, 'fill and fill-opacity as they were');
  assert.match(r.svg, /<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect id="t"/);
});
// The gradient step is the last: an undone one ends in the plain message, so nothing could show a leak. Moved ahead of the
// pattern step (its own code unchanged), its undo is visible: a <use> names one of its stops, so dropping it is refused.
const GRAD_FIRST = san("    {en:'pattern fills',zh:'图案填充',run:(r,w)=>plain(r,3,w)},\n    {en:'gradients',zh:'渐变',of:'gradient',run:(r,w)=>plain(r,2,w)}]);",
  "    {en:'gradients',zh:'渐变',of:'gradient',run:(r,w)=>plain(r,2,w)},\n    {en:'pattern fills',zh:'图案填充',run:(r,w)=>plain(r,3,w)}]);");
const G_REFUSED = svg(`<defs><linearGradient id="lg"><stop id="s" offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#ccd"/></linearGradient>`
  + '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#eee"/></pattern></defs><use href="#s"/>'
  + `${'<rect width="81.6" height="105.6" fill="url(#lg)" fill-opacity="0.5"/>'.repeat(3)}${'<circle cx="40" cy="40" r="9" fill="url(#p)"/>'.repeat(48)}`);
test('a refused gradient step is undone with every attribute as it was (the step order mutated so the undo can show)', () => {
  const r = loadStill({ mutate: GRAD_FIRST }).simplify(G_REFUSED);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  assert.equal(count(r.svg, /<rect width="81.6" height="105.6" fill="url\(#lg\)" fill-opacity="0.5"\/>/g), 3, 'fill and fill-opacity as they were');
});

// ── 4. A step that throws on the limits' path is shown after "Rejected", in both languages ──────────────────────
test('simplify never throws (R5) on the limits\' path either: the limit\'s own reason, after "已拒绝 · Rejected"', async () => {
  const T = loadStill({ mutate: san('run:fitFilters}', "run:()=>{ throw new Error('boom'); }}") }), d = limited(BIG), a = T.sanitize(d);
  assert.deepEqual(T.simplify(d), { ok: false, reason: 'filter region too large', cost: a.cost });
  assert.deepEqual(await loadStudio(T).design(answer(d), 'x'), { ok: false, convoId: 'c1', reason: REJECTED + 'filter region too large' });
});

// ── Mutation evidence: each new guard, removed, lets its test's design through or changes what is drawn ─────────────
const M = {
  trigger: san('if(first.ok||!first.over&&!first.limit) return first;', 'if(first.ok||!first.over) return first;'),
  stopsWalk: san('if(!lim.why) lim.why=limitsWhy(node);', 'if(!lim.why) lim.why=limitsWhy(node); if(lim.why) return \'\';'),
  ruleFirst: san('if(c.why&&!c.over) return Object.assign(err(c.why),price);', ''),
  limitRecheck: san('const r=recheck(next); if(r.ok)', 'const r={ok:true,svg:emit(next,true)}; if(r.ok)'),
  share: san('return [c,Math.min(1,sum)];', 'return [c,sum>0?1:0];'),
  own: san('put(o,String(+(s*eff(x)).toFixed(4)))', 'put(o,String(+s.toFixed(4)))'),
  mean: san("inherits(c)||/url\\(/i.test(c)?'#000':c,mean];", "inherits(c)||/url\\(/i.test(c)?'#000':c,1];"),
  empty: san('const x=v==null||/\\d/.test(v)?frac(v,1):NaN;', 'const x=frac(v,1);'),
  pairs: san('attrs:n.attrs.map((a)=>a.slice())', 'attrs:n.attrs'),
  catch: san('}catch(e){ return X&&e===X.SPENT?plain():shown(); }', '}catch(e){ return X&&e===X.SPENT?plain():first; }'),
  limitBar: san('root=next; cost=r.cost; }', 'root=next; }'),
  limitPrice: san('return Object.assign(err(lim.why),price,{limit:true});', 'return Object.assign(err(lim.why),{limit:true});'),
  parseLast: san("const out=emit(p.root,true); if(!domAgrees(out,p.count)) return err('the browser parses it differently');",
    "const out=emit(p.root,true); if(!lim.why&&!c.why&&!domAgrees(out,p.count)) return err('the browser parses it differently');"),
};
test('MUTATION: each new guard, removed, is caught', async () => {
  const L = (...ms) => loadStill({ mutate: (s) => ms.reduce((x, m) => m(x), s) });
  assert.equal(L(M.trigger).simplify(NEON).ok, false, 'trigger: the neon draft is refused again (the reported gap)');
  const laundered = L(M.stopsWalk).simplify(UNSAFE['event handler INSIDE the oversized filter']);
  assert.equal(laundered.ok, true, 'stopsWalk: the filter holding onload is marked limit and cut out — the R14 test is not vacuous');
  const loop = L(M.ruleFirst).simplify(UNSAFE['a loop']);
  assert.deepEqual([loop.over, loop.reason === S.sanitize(UNSAFE['a loop']).reason], [true, false], 'ruleFirst: a loop is marked limit, then over: its reason is lost');
  assert.equal(L(M.limitRecheck).simplify(svg(`<defs>${BIG}</defs><use href="#big"/><circle r="9" filter="url(#big)"/>`)).ok, true,
    'limitRecheck: a version with a stranded <use> would be drawn');
  assert.match(L(M.share).simplify(PATTERNS).svg, /<rect width="816" height="1056" fill="#333"\/>/, 'share: the faint texture is a solid #333 page');
  assert.match(L(M.own).simplify(PATTERNS).svg, /fill="#333" fill-opacity="0.004"\/><rect width="816" height="1056" fill="#333" fill-opacity="0.004"/, 'own: its own 0.5 is lost');
  assert.match(L(M.mean).simplify(GRADIENTS).svg, /fill="red"\/><rect width="816" height="1056" fill="#000"\/>/, 'mean: the vignette covers the circle');
  assert.match(L(M.empty).simplify(svg(`${'<g opacity="0.5"><circle cx="40" cy="40" r="9" fill="#fcc"/></g>'.repeat(460)}<g opacity=""><circle r="9" fill="#c33" stroke="#000"/></g>`)).svg,
    /<g fill-opacity="0" stroke-opacity="0"><circle r="9"/, 'empty: the circle is hidden');
  assert.equal(count(L(M.pairs).simplify(P_REFUSED).svg, /fill="url\(#p\)"/g), 0, 'pairs: the refused pattern step leaks into the answer');
  assert.equal(count(L(M.pairs, GRAD_FIRST).simplify(G_REFUSED).svg, /fill="url\(#lg\)"/g), 0, 'pairs: so does a refused gradient step');
  const over = svg('<g opacity="0.5"><circle cx="40" cy="40" r="9" fill="#fcc"/></g>'.repeat(460)), why = S.sanitize(over).reason;
  const shownFirst = await loadStudio(L(M.catch, san('run:flatten}', "run:()=>{ throw new Error('boom'); }}"))).design(answer(over), 'x');
  assert.equal(shownFirst.reason, why, 'catch: the `over` refusal is shown plain — English only, no "已拒绝 · Rejected" (the R13 finding)');
  const bar = L(M.limitBar).simplify(svg(`<defs>${BIG}</defs><circle r="9" filter="url(#big)"/><circle cx="50" cy="50" r="20" fill="#c33" opacity="0.5"/>`
    + '<path fill="none" stroke="#000" stroke-dasharray="0.01" d="M0 0H816"/>'.repeat(3)));
  assert.equal(bar.note, note('oversized shadows and glows, see-through layers, dashes', '过大的阴影和发光效果、半透明图层、虚线'), 'limitBar: a fold that saved nothing is named');
  assert.equal(L(M.limitPrice).sanitize(NEON).cost, undefined, 'limitPrice: the limit refusal has no price');
  for (const d of Object.values(PARSED)) assert.equal(loadStill({ mutate: M.parseLast, DOMParser: XmlDomParser }).simplify(d).ok, true, 'parseLast: laundered');
});
