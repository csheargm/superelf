// An AI draft over the render-cost budget is SIMPLIFIED, not thrown away · 超出绘制预算的 AI 草稿先简化 (ADR 0003 amendment 5)
//
// SCAR (owner, 2026-10-13, live): the Journal studio waited 2+ minutes for a real Sonnet design, then showed
// "Rejected · 已拒绝 — too costly to draw …" and discarded it. The design (test/fixtures/stationery-rejected-filters.svg,
// the model's answer byte for byte) costs 12,541 of MAX_COST 5,000; its two filters (a softShadow on 12 shapes, a glow
// on 8) are almost all of it. Without them it costs 392. The budget is right (filters are slow on the iPad); the
// waste was throwing the whole design away.
// What is pinned, each against the SHIPPED components (stationery-geometry, -cost, -sanitize, -ui, -studio, -picker):
//   · the real design comes back drawn, without its filters only, and the note names them, in both languages;
//   · each step is reached only when the steps before it are not enough: a control of every LATER kind is kept;
//   · R14: a design refused for a SAFETY reason, or by any rule but the budget, is refused unchanged — even when it
//     is also over the budget and its safe twin IS simplified (the control that makes the test non-vacuous);
//   · an in-budget design is untouched, with no note; a design no step can fit gets the plain message;
//   · the budget is not loosened: MAX_COST and the cost figures are unchanged (the cost suites run untouched).
// Mutation evidence for each guard is at the end; each mutant must match the shipped text, or the helper fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, COST_HTML, loadStill, loadStudio, withDesigns, svg, LG, PT, simplifiedNote as note, answerWith as answer,
  countMatches as count, replaceOnce as san, draftFlow as flow, TOO_COMPLEX as PLAIN } from './helpers-stationery.mjs';
import { settle } from './helpers-timing.mjs';

const fixture = (f) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', f), 'utf8');
const REJECTED = fixture('stationery-rejected-filters.svg');
const NEON = fixture('stationery-rejected-region.svg');   // the 127 s "glowing neon love note", refused for a filter region (R13 round 1)
const GOOD = svg('<rect width="816" height="1056" fill="#fffaf2"/><circle cx="60" cy="60" r="30" fill="#f2b8c6"/>');
const MAX_COST = 5000;   // NOT loosened: pinned against the shipped constants below

test('the budget is the one shipped before: MAX_COST 5,000, a pass 100, a layer 10', () => {
  assert.match(COST_HTML, /const MAX_COST=5000, PASS_COST=100, LAYER_COST=10;/);
});

// ── The parts: over the budget ONLY because of one kind, plus in-budget controls of the LATER kinds ─────────
const F = '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>';
const dot = (a) => `<circle cx="40" cy="40" r="9" ${a}/>`;
const FILTERED = dot('fill="#fcc" filter="url(#f)"').repeat(30);                       // 6,094 alone
const MASKED = '<mask id="m"><rect width="816" height="1056" fill="#fff"/></mask><clipPath id="c"><rect width="816" height="1056"/></clipPath>';
const LAYERS = '<g opacity="0.5"><circle cx="40" cy="40" r="9" fill="#fcc"/></g>'.repeat(460);   // 5,521 alone
const DASHED = '<path fill="none" stroke="#000" stroke-dasharray="0.01" d="M0 0H816"/>'.repeat(3);  // 5,471 alone
const C_LAYER = '<g opacity="0.5"><circle cx="9" cy="9" r="4" fill="#fcc" stroke="#c99"/></g>';
const C_DASH = '<path fill="none" stroke="#caa" stroke-dasharray="4 2" d="M80 150H736"/>';
const C_PAT = dot('fill="url(#p)"'), C_GRAD = dot('fill="url(#lg)"');
const C_FOLDED = dot('fill="#fcc" opacity="0.5"');   // one paint: Chromium folds it, so the budget prices no layer

test('the real rejected design (2026-10-13) is simplified and accepted: only its filters go, and the note says so', () => {
  const S = loadStill();
  const before = S.sanitize(REJECTED);
  assert.equal(before.ok, false); assert.equal(before.over, true, 'refused for the budget and nothing else');
  assert.match(before.reason, /^too costly to draw/, 'sanitize() itself is unchanged: it still refuses it');
  assert.equal(Math.round(before.cost), 12541, 'the cost model reads what it read before this change');
  const r = S.simplify(REJECTED);
  assert.equal(r.ok, true, r.reason);
  assert.equal(Math.round(r.cost), 392, 'without the two filters'); assert.ok(r.cost <= MAX_COST);
  assert.equal(r.note, note('shadows and glows', '阴影和发光效果'));
  assert.doesNotMatch(r.svg, /<filter|filter=/, 'no filter is left, used or defined');
  // The first version that fits is the answer: nothing of a later kind was touched.
  assert.equal(count(r.svg, / opacity="/g), count(REJECTED, / opacity="/g), 'every opacity kept');
  assert.match(r.svg, /stroke-dasharray="6,4"/); assert.match(r.svg, /fill="url\(#dotsPattern\)"/); assert.match(r.svg, /fill="url\(#heartGrad1\)"/);
  const again = S.sanitize(r.svg);
  assert.deepEqual([again.ok, again.svg, again.cost], [true, r.svg, r.cost], 'what is drawn is exactly what the whole check passed');
});
test('the studio hands the simplified design back with its note; a design that fits is untouched, with no note', async () => {
  const S = loadStill(), ST = loadStudio(S);
  const r = await ST.design(answer(REJECTED), 'pink hearts');
  assert.deepEqual(r, { ok: true, svg: S.simplify(REJECTED).svg, convoId: 'c1', reason: '', note: note('shadows and glows', '阴影和发光效果') });
  assert.deepEqual(await ST.design(answer(GOOD), 'dots'), { ok: true, svg: S.sanitize(GOOD).svg, convoId: 'c1', reason: '', note: '' });
  assert.deepEqual(S.simplify(GOOD), S.sanitize(GOOD), 'in budget: sanitize()’s own result, no note');
  for (const t of withDesigns(loadStill()).list()) assert.deepEqual(S.simplify(t.svg), S.sanitize(t.svg), `bundled ${t.id}`);
});

// ── Each step, reached only when the ones before it are not enough ──────────────────────────────────────────
const STEPS = [
  ['masks and clip-paths', svg(`<defs>${MASKED}${PT}${LG}</defs>${dot('fill="#fcc" mask="url(#m)"').repeat(50)}${dot('clip-path="url(#c)"').repeat(50)}`
    + `${C_LAYER}${C_DASH}${C_PAT}${C_GRAD}`), note('masks and clipping', '遮罩和裁剪'), [/opacity="0.5"/, /stroke-dasharray="4 2"/, /url\(#p\)/, /url\(#lg\)/], /mask|clip/i],
  ['see-through layers', svg(`<defs>${PT}${LG}</defs>${LAYERS}${C_DASH}${C_PAT}${C_GRAD}`),
    note('see-through layers', '半透明图层'), [/stroke-dasharray="4 2"/, /url\(#p\)/, /url\(#lg\)/], / opacity=/],
  ['dashes', svg(`<defs>${PT}${LG}</defs>${DASHED}${C_FOLDED}${C_PAT}${C_GRAD}`),
    note('dashes', '虚线'), [/ opacity="0.5"/, /url\(#p\)/, /url\(#lg\)/], /stroke-dasharray/],
  ['pattern fills', svg(`<defs>${PT}${LG}</defs>${dot('fill="url(#p)"').repeat(48)}${C_GRAD}`),
    note('pattern fills', '图案填充'), [/url\(#lg\)/], /<pattern|url\(#p\)/],
  ['gradients', svg(`<defs>${LG}</defs>${'<rect width="816" height="1056" fill="url(#lg)"/>'.repeat(92)}`),
    note('gradients', '渐变'), [], /Gradient|url\(#lg\)/],
];
for (const [kind, design, words, kept, gone] of STEPS) {
  test(`over the budget only because of ${kind}: simplified at that step, every later kind kept`, () => {
    const S = loadStill(), a = S.sanitize(design), r = S.simplify(design);
    assert.equal(a.over, true, `${kind}: the design is over the budget (${a.cost})`);
    assert.equal(r.ok, true, r.reason); assert.equal(r.note, words);
    assert.doesNotMatch(r.svg, gone, `${kind} are gone`);
    for (const re of kept) assert.match(r.svg, re, `${kind}: ${re} is a later kind, and is kept`);
  });
}
test('what a step puts in place: the same see-through on fill and stroke; a pattern or gradient’s own plain colour', () => {
  const S = loadStill();
  const odd = '<g opacity="50%"><rect width="9" height="9" fill="#cde"/></g><g opacity="0.5" fill-opacity="0.5"><rect width="9" height="9"/></g>';
  const r = S.simplify(svg(LAYERS + odd));
  assert.match(r.svg, /<g fill-opacity="0.5" stroke-opacity="0.5"><circle/, 'a 50% group stays 50%, not 100%');
  assert.match(r.svg, /<g fill-opacity="0.5" stroke-opacity="0.5"><rect width="9" height="9" fill="#cde"/, 'a percent reads as a fraction');
  assert.match(r.svg, /<g fill-opacity="0.25" stroke-opacity="0.5"><rect width="9" height="9"\/>/, 'its own fill-opacity is multiplied');
  assert.match(S.simplify(STEPS[3][1]).svg, /<circle cx="40" cy="40" r="9" fill="#eee" fill-opacity="0.25"\/>/, 'PT: #eee on a quarter of its tile');
  assert.match(S.simplify(STEPS[4][1]).svg, /<rect width="816" height="1056" fill="#fff"\/>/, 'the gradient’s first stop (LG: #fff)');
});
test('steps add up in order; a step that saves nothing, or that the check refuses, is undone and not named', () => {
  const S = loadStill();
  const two = S.simplify(svg(`<defs>${F}</defs>${FILTERED}${DASHED}`));
  assert.equal(two.note, note('shadows and glows, dashes', '阴影和发光效果、虚线'), 'filters alone were not enough');
  // Removing the filter strands <use href="#f">: the check refuses that version, so the filter stays; dashes fit.
  const r = S.simplify(svg(`<defs>${F}</defs><use href="#f"/>${dot('fill="#fcc" filter="url(#f)"')}${DASHED}${C_FOLDED}`));
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('dashes', '虚线'));
  assert.match(r.svg, /<filter id="f">/); assert.match(r.svg, /filter="url\(#f\)"/);
  assert.match(r.svg, / opacity="0.5"/, 'a one-paint opacity is no layer: flattening it saves nothing, so it is kept');
});

// ── R14: simplify never turns a refusal for any other reason into an accept ─────────────────────────────────
const BASE = `<defs>${F}</defs>${FILTERED}`;   // over the budget, and fixable: the control
const UNSAFE = {
  script: '<script>parent.postMessage({pa:"req"},"*")</script>',
  'event handler': '<circle r="9" onload="alert(1)"/>',
  'external href': '<use href="https://evil.example/x.svg#a"/>',
  'external url()': '<rect width="9" height="9" fill="url(https://evil.example/p.svg#g)"/>',
  foreignObject: '<foreignObject width="9" height="9"></foreignObject>',
};
const OTHER = {   // refused by the cost component, but NOT for the budget: their own reasons stand
  nested: svg(`<defs>${F}<mask id="m"><rect width="9" height="9" filter="url(#f)"/></mask></defs><rect width="9" height="9" mask="url(#m)"/>`),
  loop: svg(`<defs>${F}<g id="a"><use href="#a"/></g></defs>${dot('filter="url(#f)"')}`),
};
test('R14: a design refused for SAFETY is refused unchanged, though it is also over the budget and its safe twin is simplified', async () => {
  const S = loadStill();
  assert.equal(S.sanitize(svg(BASE)).over, true, 'control: the safe twin is over the budget');
  assert.equal(S.simplify(svg(BASE)).ok, true, 'control: and simplify fixes it — so a refusal below is the safety rule');
  for (const [what, bad] of Object.entries(UNSAFE)) {
    const design = svg(BASE + bad), a = S.sanitize(design);
    assert.equal(a.ok, false, what); assert.notEqual(a.over, true, `${what}: refused before the budget is read`);
    assert.deepEqual(S.simplify(design), a, `${what}: sanitize()’s own refusal, unchanged`);
    const r = await loadStudio(S).design(answer(design), 'x');
    assert.deepEqual(r, { ok: false, convoId: 'c1', reason: '已拒绝 · Rejected — ' + a.reason }, `${what}: nothing drawable`);
  }
  for (const [what, design] of Object.entries(OTHER)) assert.deepEqual(S.simplify(design), S.sanitize(design), what);
});
test('nothing fits: the plain message, not "Rejected", and nothing to draw', async () => {
  const S = loadStill();
  const heavy = svg(`<defs>${F}<g id="a">${'<rect width="9" height="9"/>'.repeat(50)}</g></defs>${'<use href="#a"/>'.repeat(100)}${dot('filter="url(#f)"')}`);
  const r = S.simplify(heavy);
  assert.deepEqual([r.ok, r.reason, r.svg], [false, PLAIN, undefined]);
  assert.equal(r.cost, S.sanitize(heavy).cost, 'the price read is the design’s own');
  assert.deepEqual(await loadStudio(S).design(answer(heavy), 'x'), { ok: false, convoId: 'c1', reason: PLAIN });
});

// R13 round 1: the catch returned the refusal WITH `over`, and the studio shows an `over` result plain — so the person read
// the English-only cost reason, with no Chinese. Now the reason comes back without the flag, after "已拒绝 · Rejected".
const THROWS = (s) => s.replace("run:flatten}", "run:()=>{ throw new Error('boom'); }}");
test('simplify never throws (R5): a step that throws leaves sanitize()’s own reason, shown after "已拒绝 · Rejected"', async () => {
  const S = loadStill({ mutate: THROWS }), design = svg(LAYERS), a = S.sanitize(design);
  assert.equal(a.over, true);
  assert.deepEqual(S.simplify(design), { ok: false, reason: a.reason, cost: a.cost }, 'no `over`: that flag means "nothing fits"');
  assert.deepEqual(await loadStudio(S).design(answer(design), 'x'), { ok: false, convoId: 'c1', reason: '已拒绝 · Rejected — ' + a.reason });
});

// ── The user flow (R6): the picker, its studio and the engine, as PANote mounts them for the Journal ────────
test('user flow: the over-budget answer is drawn with the note, and Keep saves the simplified design', async (t) => {
  const f = flow(t);
  await f.reply(REJECTED);
  assert.equal(f.drawn(), true, 'the draft is shown, not discarded');
  assert.equal(f.say(), note('shadows and glows', '阴影和发光效果')); assert.equal(f.msg.classList.contains('err'), false, 'a note, not an error');
  f.btn('Keep ·').click(); await settle();
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].svg, loadStill().simplify(REJECTED).svg);
  const n = flow(t);   // R13 round 1: the neon draft, refused for a filter region before the budget was read
  await n.reply(NEON);
  assert.deepEqual([n.drawn(), n.say(), n.msg.classList.contains('err')], [true, note('shadows and glows', '阴影和发光效果'), false]);
  n.btn('Keep ·').click(); await settle(); assert.equal(n.saved[0].svg, loadStill().simplify(NEON).svg);
  const g = flow(t);
  await g.reply(svg(`<defs>${F}<g id="a">${'<rect width="9" height="9"/>'.repeat(50)}</g></defs>${'<use href="#a"/>'.repeat(100)}`));
  assert.deepEqual([g.drawn(), g.say(), g.msg.classList.contains('err')], [false, PLAIN, true]);
});

// ── Mutation evidence: each guard, removed, lets its test's design through or changes its words ─────────────
const both = (...fs) => (s) => fs.reduce((x, f) => f(x), s);
const M = {
  trigger: san('if(first.ok||!first.over&&!first.limit) return first;', 'if(first.ok) return first;'),
  recheck: san('const r=recheck(next);\n        if(r.ok) return Object.assign(r,{note:noteOf(out.concat(step))});',
    'const r={ok:true,svg:emit(next,true)};\n        if(r.ok) return Object.assign(r,{note:noteOf(out.concat(step))});'),
  saves: san('if(r.over&&r.cost<cost)', 'if(r.over)'),
  refused: san('if(r.over&&r.cost<cost)', 'if(true)'),
  over: san(",{over:true});   // over:", ");   // over:"),
  fold: san('for(const [k,v] of own) n.attrs.push([k,String(+(o*v).toFixed(4))]);', ''),
  order: san("{en:'see-through layers',zh:'半透明图层',run:flatten},\n    {en:'dashes',zh:'虚线',run:(r)=>drop(r,[],['stroke-dasharray'])},",
    "{en:'dashes',zh:'虚线',run:(r)=>drop(r,[],['stroke-dasharray'])},\n    {en:'see-through layers',zh:'半透明图层',run:flatten},"),
};
test('MUTATION: each guard of simplify(), removed, is caught', () => {
  const L = (m) => loadStill({ mutate: m });
  assert.equal(L(M.trigger).simplify(OTHER.nested).ok, true, 'trigger: a nested-rule refusal would be "simplified" into an accept');
  assert.equal(L(M.recheck).simplify(svg(`<defs>${F}<g id="a">${'<rect width="9" height="9"/>'.repeat(50)}</g></defs>${'<use href="#a"/>'.repeat(100)}${dot('filter="url(#f)"')}`)).ok,
    true, 'recheck: a version still over the budget would be drawn');
  const unsafe = L(both(M.trigger, M.recheck)).simplify(svg(BASE + UNSAFE['event handler']));
  assert.equal(unsafe.ok, true, 'trigger + recheck: the event handler is drawn — the R14 test is not vacuous'); assert.match(unsafe.svg, /onload/);
  assert.equal(L(M.saves).simplify(STEPS[2][1]).note, note('see-through layers, dashes', '半透明图层、虚线'), 'saves: a step that saved nothing is named');
  assert.equal(L(M.refused).simplify(svg(`<defs>${F}</defs><use href="#f"/>${dot('filter="url(#f)"')}${DASHED}`)).reason, PLAIN, 'refused: a refused step is kept, so nothing after it fits');
  assert.equal(L(M.over).simplify(REJECTED).ok, false, 'over: without the flag the real design is discarded again');
  assert.doesNotMatch(L(M.fold).simplify(STEPS[1][1]).svg, /fill-opacity="0.5"/, 'fold: a 50% group would draw at 100%');
  assert.equal(L(M.order).simplify(svg(`<defs>${PT}${LG}</defs>${LAYERS}${'<path fill="none" stroke="#000" stroke-dasharray="0.01" d="M0 0H816"/>'}`)).note,
    note('dashes, see-through layers', '虚线、半透明图层'), 'order: dashes would go before layers, though layers alone fit');
});
test('MUTATION: the studio and picker wiring, removed, is caught', async (t) => {
  const S = loadStill();
  const old = loadStudio(S, { mutate: san('const v=S.simplify(raw);', 'const v=S.sanitize(raw);') });
  assert.equal((await old.design(answer(REJECTED), 'x')).ok, false, 'sanitize alone: the 2026-10-13 bug, the design discarded');
  const prefixed = loadStudio(S, { mutate: san('reason:v.over?v.reason:', 'reason:') });
  assert.notEqual((await prefixed.design(answer(svg(`<defs>${F}<g id="a">${'<rect width="9" height="9"/>'.repeat(50)}</g></defs>${'<use href="#a"/>'.repeat(100)}`)), 'x')).reason, PLAIN);
  const quiet = flow(t, san("say(msg,r.note||'');", "say(msg,'');"));
  await quiet.reply(REJECTED); assert.equal(quiet.say(), '', 'picker: the draft would be shown with no word of what changed');
});
