// The render-cost budget · 信纸绘制成本 (web/stationery-cost.inline.html, ADR 0003 decision 4 and amendments)
//
// A design that PASSES the allow-list (test/stationery-sanitize.test.mjs) can still hold the Journal's
// main thread for a minute. Each design below was measured in Chromium on the real raster path, and is
// REJECTED by the budget. The key rules are mutation-tested: the rule is deleted from the SHIPPED source
// and the same costly design is shown to get through, so that rule is what stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStationery, svg, FP } from './helpers-stationery.mjs';

const S = loadStationery();

// ── Render cost: a design that PASSES the allow-list can still freeze the page ─────────────
// Measured in Chromium (scratch probe, real raster at 1640/2244 device px) BEFORE this rule: a
// 2.2 KB mask fan-out (8^4) held the Journal's main thread 49.5 s on every open; 50 full-page
// turbulence rects 13.3 s. AFTER: the worst design each cost family lets through rasters in ~2.5 s at
// 1640 px (about 4,600 plain full-page stroked shapes off the pixel grid); see-through layers <= 1.2 s;
// turbulence, masks, blur, patterns, clips <= 1.0 s. How shapes are painted, and their outlines (ADR 0003
// amendment 3): test/stationery-sanitize-paint.test.mjs.
// 48 full-page shapes x 95 <use> (~4,800 drawn): inside the budget as plain shapes (ADR 0003, 2026-10-12).
const fan48 = (shape, useAttrs = '', gAttrs = '') => svg(`<defs><g id="r"${gAttrs}>` + shape.repeat(48) + '</g></defs>' + `<use href="#r"${useAttrs}/>`.repeat(95));
const rect = (a) => `<rect ${FP} fill="#fff"${a}/>`, SEE = ' opacity="0.01"', INK = ' stroke="#000" stroke-width="2"';
const maskFan = (levels, fan) => { let m = `<mask id="m0"><rect ${FP} fill="#fff"/></mask>`;
  for (let i = 1; i <= levels; i++) m += `<mask id="m${i}">` + `<rect ${FP} fill="#fff" mask="url(#m${i - 1})"/>`.repeat(fan) + '</mask>';
  return svg('<defs>' + m + `</defs><rect ${FP} fill="#f00" mask="url(#m${levels})"/>`); };
const turb = (oct) => `<filter id="t"><feTurbulence baseFrequency="0.9" numOctaves="${oct}"/></filter>`;
const chain = (n) => { let c = ''; for (let i = 1; i < n; i++) c += `<use id="c${i}" href="#c${i + 1}"/>`;
  return svg('<defs>' + c + `<rect id="c${n}" width="1" height="1"/></defs>`); };
const COST = {
  'mask fan-out 8^3 (8.2 s stall)': maskFan(3, 8),
  'mask fan-out 8^4 (49.5 s stall)': maskFan(4, 8),
  'nested mask, tiny': maskFan(1, 1),
  'pattern inside a pattern': svg(`<pattern id="p0" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1"/></pattern>`
    + `<pattern id="p1" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="url(#p0)"/></pattern><rect ${FP} fill="url(#p1)"/>`),
  'filter inside a clipPath, through <use>': svg(`${turb(1)}<g id="g" filter="url(#t)"><rect width="9" height="9"/></g><clipPath id="c"><use href="#g"/></clipPath><rect ${FP} clip-path="url(#c)"/>`),
  '50 full-page turbulence rects (13.3 s stall)': svg(turb(2) + `<rect ${FP} filter="url(#t)" opacity="0.01"/>`.repeat(50)),
  '49 full-page masks': svg(`<mask id="m"><rect ${FP} fill="#fff"/></mask>` + `<rect ${FP} fill="#f00" mask="url(#m)"/>`.repeat(49)),
  'numOctaves 1e9': svg(turb(1e9) + `<rect ${FP} filter="url(#t)"/>`),
  'numOctaves 9': svg(turb(9) + `<rect ${FP} filter="url(#t)"/>`),
  'a 9-step filter': svg('<filter id="f">' + '<feOffset dx="1"/>'.repeat(9) + `</filter><rect ${FP} filter="url(#f)"/>`),
  'a filter region 30x the element': svg(`<filter id="f" x="-10" y="-10" width="30" height="30"><feGaussianBlur stdDeviation="9"/></filter><rect ${FP} filter="url(#f)"/>`),
  'a filter region 3x the element': svg(`<filter id="f" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="9"/></filter><rect ${FP} filter="url(#f)"/>`),
  'a 17-hop <use> chain': chain(18),
  'a 4,990-hop <use> chain (threw RangeError)': chain(4990),
  'a url(#id) cycle': svg('<mask id="a"><rect width="9" height="9" mask="url(#b)"/></mask><mask id="b"><rect width="9" height="9" mask="url(#a)"/></mask>'),
  // R13 review: the browser draws the FIRST #a (40 masked pages); a last-wins id map measured the empty twin
  // opacity that Chromium cannot fold into ONE paint is an off-screen layer each: the budget priced it as one element
  'opacity over fill and stroke, 48 x 95 <use> (12.5 s stall)': fan48(rect(SEE + INK)),
  'no fill attribute: the default black fill under a stroke (11.8 s)': fan48(`<rect ${FP}${INK}${SEE}/>`),
  'opacity="50%" over fill and stroke (11.8 s)': fan48(rect(INK + ' opacity="50%"')),
  'a stroke with vector-effect, fill="none" (10 s)': fan48(`<rect ${FP} fill="none" stroke="#000"${SEE} vector-effect="non-scaling-stroke"/>`),
  // every shape, not only <rect> (R13 round 2: path 11.1 s, ellipse 10.8 s, polygon 11.3 s)
  ...Object.fromEntries(['<path d="M0 0H816V1056H0Z"', '<circle cx="408" cy="528" r="660"', '<ellipse cx="408" cy="528" rx="600" ry="760"', '<line x2="816" y2="1056"',
    '<polyline points="0,0 816,0 816,1056"', '<polygon points="0,0 816,0 816,1056"'].map((o) => [`${o.slice(1, o.indexOf(' '))}: opacity over fill and stroke, 48 x 95`, fan48(`${o} fill="#fff"${INK}${SEE}/>`)])),
  // R13 round 2: a mask's content takes its stroke from the MASK's ancestors (3.7 s); 4 nested <svg opacity> x 498 (4.6 s)
  'mask content: stroke from its own ancestors, opacity on the shape, 29 refs (3.7 s)': svg(`<defs><g${INK}><mask id="m">` + rect(' opacity="0.5"').repeat(48) + `</mask></g></defs>` + `<rect ${FP} fill="#f00" mask="url(#m)"/>`.repeat(29)),
  'nested <svg opacity> round one rect, 4 x 498 <use> (4.6 s)': svg('<defs><g id="r">' + `<svg ${FP}${SEE}>${rect('')}</svg>`.repeat(4) + '</g></defs>' + '<use href="#r"/>'.repeat(498)),
  // R13: ONE paint, but 40 nested group layers round it — a group's opacity is never folded
  '40 nested <g opacity> round one fill-only rect, x115 (12.2 s)': svg('<defs><g id="r">' + '<g opacity="0.5">'.repeat(40) + rect('') + '</g>'.repeat(40) + '</g></defs>' + '<use href="#r"/>'.repeat(115)),
  'stroke lent by the <use>, opacity on the shape (11.7 s)': fan48(rect(SEE), INK),
  'stroke lent by a <g>, opacity on the shape (11.8 s)': fan48(rect(SEE), '', INK),
  // a no-break space is not CSS whitespace: Chromium reads no 'none' and paints the default black fill
  'fill="&#160;none" over a stroke, with opacity (11.6 s)': fan48(`<rect ${FP} fill="&#160;none"${INK}${SEE}/>`),
  'opacity on a <use> over two shapes, 1,200x (3.3 s)': svg(`<defs><g id="r">${rect('').repeat(2)}</g></defs>` + `<use href="#r"${SEE}/>`.repeat(1200)),
  'a duplicate id hiding the cost': svg(`<mask id="m"><rect ${FP} fill="#fff"/></mask><g id="a">` + `<rect ${FP} mask="url(#m)"/>`.repeat(40) + '</g><rect id="a"/>' + '<use href="#a"/>'.repeat(95)),
};
for (const [name, input] of Object.entries(COST)) {
  test(`render cost rejects: ${name}`, () => {
    let r; assert.doesNotThrow(() => { r = S.sanitize(input); }, 'a rejection, never a throw');
    assert.equal(r.ok, false); assert.ok(r.reason); assert.equal(r.svg, undefined);
  });
}
test('render cost: what real stationery does is still fine (one mask, a few filters, a 16-hop chain)', () => {
  for (const ok of [svg(`<mask id="m"><rect ${FP} fill="#fff"/></mask><rect ${FP} fill="#fee" mask="url(#m)"/>`),
    svg(turb(3) + `<rect ${FP} filter="url(#t)" opacity="0.1"/>`.repeat(3)), chain(16),
    svg('<filter id="f" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2"/></filter><circle r="9" filter="url(#f)"/>')]) {
    const r = S.sanitize(ok); assert.ok(r.ok, r.reason);
  }
});
test('render cost: opacity Chromium folds into a shape\'s ONE paint is not a layer (fill="none" 73 ms, fill only 1.3 s); fill-/stroke-opacity are not opacity (1.4 s)', () => {
  for (const ok of [fan48(`<rect ${FP} fill="none"${INK}${SEE}/>`), fan48(`<rect ${FP} fill=" NONE "${INK}${SEE}/>`), fan48(rect(SEE)), fan48(rect(INK + ' fill-opacity="0.01" stroke-opacity="0.01"'))]) {
    const r = S.sanitize(ok); assert.ok(r.ok, r.reason);
  }
});
test('a 4,990-hop chain is a REASON for every caller: studio design and My templates both carry on', async () => {
  const { loadStudio } = await import('./helpers-stationery.mjs');
  const S2 = loadStationery(); const ST = loadStudio(S2);
  const d = await ST.design(async () => ({ ok: true, text: chain(4990), convoId: 'c' }), 'x');
  assert.equal(d.ok, false); assert.match(d.reason, /Rejected/);
  const tpl = (id, s) => JSON.stringify({ id, name: id, group: 'stationery', audience: 'any', lines: null, safe: { x: 80, y: 100, w: 656, h: 860 }, dark: false, svg: s });
  const ok = svg('<rect width="9" height="9"/>');
  const files = { 'templates/index.json': '{"v":1,"ids":["a","poison","b"]}', 'templates/a.json': tpl('a', ok), 'templates/poison.json': tpl('poison', chain(4990)), 'templates/b.json': tpl('b', ok) };
  const st = S2.store({ read: async (p) => (p in files ? { status: 'loaded', data: JSON.parse(files[p]) } : { status: 'absent' }), write: async () => ({ ok: true }) });
  const r = await st.loadMine();
  assert.equal(r.ok, false); assert.match(r.error, /poison: /);
  assert.deepEqual(S2.list().filter((t) => t.source === 'mine').map((t) => t.id), ['a', 'b'], 'the templates after the bad one still load');
});
const COST_MUTANTS = [
  ['url(#id) counted as a reference', (s) => s.replace('for(const m of v.matchAll(REF_URL)){ const t=ids.get(m[1]); if(t) r.push([t,2]); }', ''), COST['49 full-page masks']],
  ['the nested-resource rule', (s) => s.replace("if(m.nested) return", 'if(false) return'), COST['nested mask, tiny']],
  ['the numOctaves cap', (s) => s.replace("if(octOver(attr(n,'numOctaves')))", 'if(false)'), COST['numOctaves 9']],
  ['the filter-steps cap', (s) => s.replace('if(n.kids.length>MAX_FILTER_STEPS)', 'if(false)'), COST['a 9-step filter']],
  ['the filter-region cap', (s) => s.replace('||!(w<=MAX_FILTER_REGION&&h<=MAX_FILTER_REGION)', ''), COST['a filter region 3x the element']],
  ['the reference-depth cap', (s) => s.replace('if(m.depth>MAX_REF_DEPTH)', 'if(false)'), COST['a 17-hop <use> chain']],
  ['the duplicate-id rule', (s) => s.replace("if(k==='id'&&ids.has(v)) return", 'if(false) return'), COST['a duplicate id hiding the cost']],
  ['the per-pass price', (s) => s.replace('m.passes*PASS_COST+', ''), COST['50 full-page turbulence rects (13.3 s stall)']],
  ['the see-through layer price', (s) => s.replace('+m.layers*LAYER_COST', ''), COST['opacity over fill and stroke, 48 x 95 <use> (12.5 s stall)']],
  // a rule that reads only the shape's OWN fill and stroke misses the stroke a <use> lends it
  ['inherited paint', (s) => s.replace('(s==null?up&2:', '(s==null?0:'), COST['stroke lent by the <use>, opacity on the shape (11.7 s)']],
  ['CSS whitespace only around none', (s) => s.replace("NONE=new RegExp('^'+WS+'*none'+WS+'*$','i')", 'NONE=/^\\s*none\\s*$/i'), COST['fill="&#160;none" over a stroke, with opacity (11.6 s)']],
  ['a group\'s own layer', (s) => s.replace('GROUPS[n.name]||', ''), COST['40 nested <g opacity> round one fill-only rect, x115 (12.2 s)']],
  ['the default and inherited fill', (s) => s.replace('(f==null?up&1:', '(f==null?0:'), COST['no fill attribute: the default black fill under a stroke (11.8 s)']],
  ['opacity in percent', (s) => s.replace('!(Number(o)>=1)', '!(parseFloat(o)>=1)'), COST['opacity="50%" over fill and stroke (11.8 s)']],
  ['vector-effect', (s) => s.replace("||attr(n,'vector-effect')!=null", ''), COST['a stroke with vector-effect, fill="none" (10 s)']],
  ['a url(#id) target\'s own inherited paint', (s) => s.replace('kind===2?doc.get(t):paintOf(t,p)', 'kind===2?0:paintOf(t,p)'), COST['mask content: stroke from its own ancestors, opacity on the shape, 29 refs (3.7 s)']],
  ['<svg> as a group', (s) => s.replace('{g:1,svg:1,use:1}', '{g:1,use:1}'), COST['nested <svg opacity> round one rect, 4 x 498 <use> (4.6 s)']],
];
for (const [rule, mutate, attack] of COST_MUTANTS) {
  test(`mutation: without ${rule}, the costly design gets through`, () => {
    assert.equal(S.sanitize(attack).ok, false, 'shipped: rejected');
    const r = loadStationery({ mutate }).sanitize(attack); assert.equal(r.ok, true, 'mutant: accepted — ' + r.reason);
  });
}
