// One work budget per simplify() call · 简化的工作量上限 (ADR 0003 amendment 5, R13 round 4)
//
// The R13 round 4 review (blocking): TILE_WALK bounded the walk of ONE tile, not the call. 1,600 small patterns that each draw
// one shared <use> chain (60 junk attributes on each link, 208 KB) froze Chromium for 6 s, and the Journal studio with it.
// Measuring found more walks of that kind: a tile's size and colours read again for each shape, a gradient's children for each
// circle, a long value read on each visit, a long colour written on every shape, climbs up the tree. Now every walk that can
// read an element again and again spends from ONE meter per call (stationery-simplify WORK); spent, simplify() fails CLOSED.
// R13 round 5 (blocking): a visit charged the size an element had when FIRST read, so a long colour lend() then wrote onto a
// <use> target cost 1 unit each time a tally read it again (4,000 reads of 150 KB, 2 s). A visit now charges the values as
// they are. (The call's deadline, its backstop, is stationery-simplify-deadline; here it is held off with NO_DEADLINE where a
// verdict must come from the units alone.)
// What is pinned, against the shipped components:
//   · each crafted design below is refused with the plain message (`over`, sanitize()'s own price) in well under 200 ms, by the
//     units alone (no deadline: a charge the deadline would back up is still pinned), and the same with the real clock;
//   · a step kept before the budget ran out is not drawn either, though without the budget the design would be simplified;
//   · the budget is per call: the real drafts are simplified after the refusals exactly as on a fresh page;
//   · shapes sharing one big gradient are simplified: a gradient is read once a call;
//   · user flow (R6): the studio shows the plain refusal and draws nothing.
// The 58 saved real replies give byte-identical output (ADR). Mutation evidence at the end: each charge, removed, lets a
// crafted design through, or gives the time back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadStationery, svg, heartsOf, simplifiedNote as note, replaceOnce as san, draftFlow, useChain as chain,
  TOO_COMPLEX as PLAIN, NO_DEADLINE } from './helpers-stationery.mjs';
import { SIMPLIFY_BOUND_MS as BOUND, SIMPLIFY_BOUND_BASE_MS as BOUND_BASE } from './helpers-platform.mjs';   // 200 ms here, x CI_TIMING_FACTOR on a shared runner

const S = loadStationery();
const DOTS = '<pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.2" fill="#333"/></pattern>';
const JUNK = Array.from({ length: 60 }, (_, i) => ` q${i}="1"`).join('');   // attributes sanitize() drops; the steps still read them
const pad = (n) => ' '.repeat(n);                                           // CSS whitespace: the value still reads as its start
const tiles = (n, href, w = '0.5') => Array.from({ length: n }, (_, i) => `<pattern id="p${i}" width="${w}" height="${w}"><use href="#${href}"/></pattern>`).join('');
const painting = (n) => Array.from({ length: n }, (_, i) => `<rect width="9" height="9" fill="url(#p${i})"/>`).join('');
const sizes = (n, fill) => Array.from({ length: n }, (_, i) => `<rect width="${i + 1}" height="9" ${fill(i)}/>`).join('');
const R13 = svg(`<defs>${chain(4, 9, JUNK)}${tiles(1600, 'l4')}</defs>${painting(1600)}`);
// R13 round 5: a colour lent onto #n (spaces first: each read of it runs to the end), which the last lender's tallies read again
// for each of its <use>s of #n
const lentOnto = (len, uses, grad) => svg(`<defs>${grad ? `<linearGradient id="p"><stop offset="0" stop-color="${pad(len)}#c33"/></linearGradient>`
  : `<pattern id="p" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="${pad(len)}#c33"/></pattern>`}</defs>`
  + `<g fill="url(#p)"><use href="#n"/></g><g id="n" fill="url(#p)"><rect width="9" height="9"/></g><g fill="url(#p)">${'<use href="#n"/>'.repeat(uses)}</g>${heartsOf('p', 46)}`);
const WRITTEN = svg(`<defs><pattern id="c" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#c33${pad(150000)}"/></pattern>`
  + `</defs>${'<rect width="9" height="9" fill="url(#c)"/>'.repeat(2500)}`);
const CRAFTED = {   // each over the budget, each built to make one walk repeat; each took 0.3-7 s on 1bdce28, or was simplified
  'many tiles, one shared <use> chain, 60 junk attributes a link (the R13 scenario)': R13,
  'tiles on the fill and the stroke, a 13-link chain': svg(`<defs>${chain(13, 2)}${tiles(1950, 'l13')}</defs>`
    + sizes(975, (i) => `fill="url(#p${2 * i})" stroke="url(#p${2 * i + 1})"`)),
  '40 tiles, each 729 circles deep': svg(`<defs>${chain(3, 9)}${tiles(40, 'l3')}</defs>${painting(40)}${heartsOf('p0', 46)}`),
  '500 tiles of one group of 3,400 children': svg(`<defs><g id="big"><circle r="1" fill="#c33"/>${'<defs/>'.repeat(3400)}</g>${tiles(500, 'big')}</defs>${painting(500)}`),
  'a chain painting a gradient of 4,000 other children, in 300 tiles': svg(`<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>`
    + `${'<g/>'.repeat(4000)}<stop offset="1" stop-color="#00f"/></linearGradient>${chain(4, 9).replace('fill="#c33"', 'fill="url(#g)"')}${tiles(300, 'l4', '9')}</defs>${painting(300)}`),
  'a 250 KB stroke width inherited by every circle of a tile': svg(`<defs><g stroke-width="1${pad(250000)}"><pattern id="c" width="0.5" height="0.5">`
    + `<defs>${chain(3, 9)}</defs><use href="#l3"/></pattern></g></defs>${'<rect width="9" height="9" fill="url(#c)"/>'.repeat(50)}`),
  'a 20 KB opacity on each circle of a tile': svg(`<defs><pattern id="c" width="0.5" height="0.5"><defs>${chain(3, 9).replace('fill="#c33"', `fill="#c33" opacity="0.5${pad(20000)}"`)}`
    + `</defs><use href="#l3"/></pattern></defs>${'<rect width="9" height="9" fill="url(#c)"/>'.repeat(50)}`),
  'a 20 KB tile width, read for each of 500 shapes': svg(`<defs><pattern id="c" width="0.5${pad(20000)}" height="0.5"><rect width="1" height="1" fill="#c33"/></pattern></defs>`
    + sizes(500, () => 'fill="url(#c)"')),
  'one tile of 2,400 colours, on 2,500 shapes': svg(`<defs><pattern id="c" width="0.5" height="0.5">${Array.from({ length: 2400 },
    (_, i) => `<rect width="1" height="1" fill="#${(i * 40503).toString(16).padStart(6, '0').slice(-6)}"/>`).join('')}</pattern></defs>${sizes(2500, () => 'fill="url(#c)"')}`),
  'a 150 KB colour written on 2,500 shapes': WRITTEN,
  '2,000 <use>s of a target with a 20 KB opacity, in a lender': svg(`<defs>${DOTS}<rect id="t" width="9" height="9" opacity="0.5${pad(20000)}"/></defs>`
    + `<g fill="url(#d)">${'<use href="#t"/>'.repeat(2000)}</g>${heartsOf('d', 46)}`),
  '2,000 <use>s of one rect, 12 groups deep in a lender': svg(`<defs>${DOTS}</defs><g fill="url(#d)"><rect id="r" width="9" height="9"/>`
    + `${'<g>'.repeat(12)}${'<use href="#r"/>'.repeat(2000)}${'</g>'.repeat(12)}</g>${heartsOf('d', 46)}`),
  '1,000 lenders under 44 groups with 4.5 KB opacities': svg(`<defs>${DOTS}</defs>${`<g fill-opacity="${pad(4500)}">`.repeat(44)}`
    + `${'<rect width="9" height="9" fill="url(#d)"/>'.repeat(1000)}${'</g>'.repeat(44)}`),
  'a 150 KB colour lent onto a <use> target, read again for each of 2,000 <use>s (the R13 round 5 scenario)': lentOnto(150000, 2000),
  'the same, the colour a gradient stop\'s': lentOnto(150000, 2000, true),
  'a 4 KB colour lent onto a <use> target, read again for each of 1,200 <use>s': lentOnto(4000, 1200),
  '300 tiles under 40 groups with 4.5 KB stroke widths': svg(`<defs>${`<g stroke-width="1${pad(4500)}">`.repeat(40)}${Array.from({ length: 300 },
    (_, i) => `<pattern id="p${i}" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#c33"/></pattern>`).join('')}${'</g>'.repeat(40)}</defs>${painting(300)}`),
};
const timed = (X, d, o) => { const t0 = performance.now(), r = X.simplify(d, o); return [r, performance.now() - t0]; };
const refused = (r, d) => [r.ok, r.reason, r.svg, r.over, r.cost === S.sanitize(d).cost];
test('crafted designs that make the steps read an element again and again are refused plain by the units alone, in well under 200 ms', () => {
  for (const [what, d] of Object.entries(CRAFTED)) {
    assert.equal(S.sanitize(d).over, true, `${what}: over the budget, so simplify() runs`);
    const runs = [0, 1].map(() => timed(S, d, NO_DEADLINE)), ms = Math.min(...runs.map((x) => x[1]));   // the least of 2: load
    assert.deepEqual(refused(runs[0][0], d), [false, PLAIN, undefined, true, true], what); assert.ok(ms < BOUND, `${what}: ${Math.round(ms)} ms`);
    assert.deepEqual(S.simplify(d), runs[0][0], `${what}: and the same with the real clock`);
  }
});
const F = '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>', LIFT = san('const WORK=50000,', 'const WORK=Infinity,');
const KEPT = svg(`<defs>${F}${chain(3, 9)}${tiles(40, 'l3')}</defs>${painting(40)}${heartsOf('p0', 46)}${'<circle r="9" fill="#fcc" filter="url(#f)"/>'.repeat(30)}`);
test('it fails CLOSED: the filters step kept before the budget ran out is not drawn either', () => {
  const r = S.simplify(KEPT);
  assert.deepEqual(refused(r, KEPT), [false, PLAIN, undefined, true, true]);
  const control = loadStationery({ mutate: LIFT }).simplify(KEPT, NO_DEADLINE);   // R14: only the budget refuses it (nor the deadline)
  assert.equal(control.note, note('shadows and glows, pattern fills', '阴影和发光效果、图案填充'), control.reason);
});
const fixture = (f) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', f), 'utf8');
const REAL = ['stationery-rejected-filters.svg', 'stationery-rejected-region.svg'].map(fixture);
const SHARED = svg(`<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>${'<g/>'.repeat(3000)}<stop offset="1" stop-color="#00f"/></linearGradient></defs>`
  + '<rect width="816" height="1056" fill="url(#g)"/>'.repeat(92) + '<rect width="9" height="9" fill="url(#g)"/>'.repeat(1500));
test('the budget is per call: after every refusal, the real drafts are simplified exactly as on a fresh page', () => {
  const fresh = loadStationery(), page = loadStationery();
  for (const d of Object.values(CRAFTED)) page.simplify(d);
  for (const d of [...REAL, SHARED]) { const r = page.simplify(d, NO_DEADLINE); assert.equal(r.ok, true, r.reason); assert.deepEqual(r, fresh.simplify(d, NO_DEADLINE)); }
});
test('1,592 shapes sharing one gradient of 3,000 children are simplified: a gradient is read once a call', () => {
  assert.equal(S.sanitize(SHARED).over, true);
  const r = S.simplify(SHARED, NO_DEADLINE);
  assert.equal(r.note, note('gradients', '渐变'), r.reason);
});
test('user flow (R6): the studio shows the R13 design refused plain, and draws nothing', async (t) => {
  const f = draftFlow(t);
  await f.reply(R13);
  assert.deepEqual([f.drawn(), f.say(), f.msg.classList.contains('err')], [false, PLAIN, true]);
});

// ── Mutation evidence: each charge, removed, lets a crafted design through or gives the time back ─────────────────────────────
const M = {
  meterThrow: san('if((left-=n)<0) throw SPENT;', 'left-=n;'),
  perCall: san('w=X&&X.meter(o&&o.clock||undefined);', 'w=X&&(X.w||(X.w=X.meter(o&&o.clock||undefined)));'),
  spentPlain: san('return X&&e===X.SPENT?plain():shown();', 'return shown();'),
  tileWalk: san('X.visit(s,ks.length+chars(v));', ''),
  tileInherited: san('X.visit(s,ks.length+chars(v));', 'X.visit(s,ks.length);'),
  tileKids: san('X.visit(s,ks.length+chars(v));', 'X.visit(s,chars(v));'),
  tileSize: san('function tileOf(t,n,X){ X.visit(t);', 'function tileOf(t,n,X){'),
  tilePieces: san('const P=piecesOf(t,X); X.w(P.length);', 'const P=piecesOf(t,X);'),
  gradMemo: san('if(!X.grads.has(t)){ X.visit(t,t.kids.length); X.grads.set(t,gradOf(t)); } return X.grads.get(t);', 'X.visit(t,t.kids.length); return gradOf(t);'),
  aloneCharge: san('X.w(1); if(!z||X.users.has(z))', 'if(!z||X.users.has(z))'),
  effVisit: san('X.visit(y); if(readable(y,o))', 'if(readable(y,o))'),
  goVisit: san('const go=(x,k,bb,ks,on)=>{ visit(x);', 'const go=(x,k,bb,ks,on)=>{'),
  inhVisit: san('for(let x=n;x;x=up.get(x)){ visit(x);', 'for(let x=n;x;x=up.get(x)){'),
  sizeChars: san('w(1+chars(x.attrs.map((a)=>a[1]))+more)', 'w(1+more)'),
  colourCharge: san("!=='userSpaceOnUse'; w(chars([c]));", "!=='userSpaceOnUse';"),
  // round 4's visit: the size an element had when first read, kept though lend() writes a colour onto it later
  staleSize: san('const visit=(x,more=0)=>w(1+chars(x.attrs.map((a)=>a[1]))+more);',
    'const size=new Map(), visit=(x,more=0)=>{ if(!size.has(x)) size.set(x,1+chars(x.attrs.map((a)=>a[1]))); w(size.get(x)+more); };'),
};
const THROUGH = { meterThrow: 'one tile of 2,400 colours, on 2,500 shapes', tileWalk: '40 tiles, each 729 circles deep',
  tileInherited: 'a 250 KB stroke width inherited by every circle of a tile', tileKids: '500 tiles of one group of 3,400 children',
  tileSize: 'a 20 KB tile width, read for each of 500 shapes', tilePieces: 'one tile of 2,400 colours, on 2,500 shapes',
  aloneCharge: '2,000 <use>s of one rect, 12 groups deep in a lender', effVisit: '1,000 lenders under 44 groups with 4.5 KB opacities',
  goVisit: '2,000 <use>s of a target with a 20 KB opacity, in a lender', inhVisit: '300 tiles under 40 groups with 4.5 KB stroke widths',
  sizeChars: 'a 20 KB opacity on each circle of a tile', staleSize: 'a 4 KB colour lent onto a <use> target, read again for each of 1,200 <use>s' };
test('MUTATION: each charge of the work budget, removed, is caught', () => {
  const L = (m) => loadStationery({ mutate: m });   // no deadline: the units alone decide (a mutant may take longer than it)
  for (const [m, what] of Object.entries(THROUGH)) assert.equal(L(M[m]).simplify(CRAFTED[what], NO_DEADLINE).ok, true, `${m}: ${what} gets through`);
  const shared = L(M.perCall); shared.simplify(R13);
  assert.equal(shared.simplify(SHARED).reason, PLAIN, 'perCall: one budget for the page, spent by the first design');
  assert.match(L(M.spentPlain).simplify(R13).reason, /^too costly to draw/, 'spentPlain: the English cost reason, after "Rejected"');
  assert.equal(L(M.gradMemo).simplify(SHARED).reason, PLAIN, 'gradMemo: the gradient read again for each shape');
  const [, ms] = timed(L(M.colourCharge), WRITTEN, NO_DEADLINE); assert.ok(ms > BOUND_BASE, `colourCharge: ${Math.round(ms)} ms (375 MB written)`);   // the unscaled floor: a slow runner only makes the mutant slower
});
