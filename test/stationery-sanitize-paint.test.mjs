// How a shape is painted, and how complex its outline is · 信纸的着色与轮廓成本 (ADR 0003 amendment 3)
//
// Part of the render-cost budget (web/stationery-cost.inline.html; the rest: test/stationery-sanitize-cost.test.mjs).
// Every design here was accepted before amendment 3 or its R13 round 1 review. Times: Chromium (Playwright) on
// the Journal's raster path at 1640 device px; a "~" time was taken on a tenth or less of the <use> or
// rects and scaled up. Each design is now REJECTED, and a mutation of the SHIPPED source that removes one rule
// lets it through, so that rule is what stops it. "rule:" marks a design Chromium draws cheaply: it pins a
// bound that must hold whichever way Chromium reads the value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStationery, svg, FP, LG, PT, HALF, SMALL, dashed, unevenStops, R16 } from './helpers-stationery.mjs';

const S = loadStationery();
// ── Amendment 3: how a shape is PAINTED ───────────────────────────────────────────────────────────
const DASHED = (a) => `<rect ${FP} fill="none" stroke="#000"${a}/>`, LEVEL = 'M0 500l816 0.816';   // a near-level line: the costliest dashes
const lent = (def, a, n, own = '') => svg(`<defs>${def}<g id="r">${`<rect ${FP}${own}/>`.repeat(48)}</g></defs><g ${a}>` + '<use href="#r"/>'.repeat(n) + '</g>');
const tile = (inner) => `<pattern id="p" ${FP} patternUnits="userSpaceOnUse">${inner}</pattern>`;
const PAINT = {
  'stroke-dasharray="0.01" on 10 full-page rects (5.0 s)': svg(DASHED(' stroke-dasharray="0.01"').repeat(10)),
  'stroke-dasharray="0.01" lent by a <g>, 10 rects (5.0 s)': svg('<g stroke-dasharray="0.01">' + DASHED('').repeat(10) + '</g>'),
  'stroke-dasharray="0.01" lent by the <use>, 10 uses (5.0 s)': svg(`<defs>${DASHED(' id="r"')}</defs>` + '<use href="#r" stroke-dasharray="0.01"/>'.repeat(10)),
  'a 10-wide near-level line, dash 0.01 (2.1 s)': svg(`<path fill="none" stroke="#000" stroke-width="10" stroke-dasharray="0.01" d="${LEVEL}"/>`),
  'a dashed rect scaled up 20x, dash 0.00125 (4.0 s)': svg('<rect width="40.8" height="52.8" fill="none" stroke="#000" stroke-dasharray="0.00125" transform="scale(20)"/>'),
  'a flat ellipse drawn by ONE arc, dash 0.01, x4 (3.4 s)': svg('<path fill="none" stroke="#000" stroke-dasharray="0.01" d="M8 528a400 1 0 1 0 0 -0.01"/>'.repeat(4)),
  'a dash in mm (0.0025mm), 10 rects (6.0 s)': svg(DASHED(' stroke-dasharray="0.0025mm"').repeat(10)),
  '1,248 full-page gradient rects (8.1 s)': svg(`<defs>${LG}</defs>` + `<rect ${FP} fill="url(#lg)"/>`.repeat(1248)),
  'gradient lent by a <g>, 48 rects x 98 <use> (~31 s)': lent(LG, 'fill="url(#lg)"', 98),
  'a small gradient rect scaled up 10x, x250 (1.7 s)': svg(`<defs>${LG}</defs>` + '<rect width="81.6" height="105.6" fill="url(#lg)" transform="scale(10)"/>'.repeat(250)),
  'a gradient stroke 2000 wide on a line, x250 (1.7 s)': svg(`<defs>${LG.replace('id="lg"', 'id="lg" gradientUnits="userSpaceOnUse" x2="816"')}</defs>`
    + '<line x2="816" y1="528" y2="528" stroke="url(#lg)" stroke-width="2000"/>'.repeat(250)),
  'pattern lent by a <g>, 48 rects x 96 <use> (~102 s)': lent(PT, 'fill="url(#p)"', 96),
  'pattern stroke lent by a <g>, 2000 wide, 48 rects x 80 <use> (~85 s)': lent(PT, 'fill="none" stroke="url(#p)" stroke-width="2000"', 80),
  'a full-page tile of 400 see-through rects, x9 (6.0 s)': svg(`<defs>${tile(HALF.repeat(400))}</defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(9)),
  'a tile that draws 350 see-through rects through <use>, x9 (5.2 s)': svg(`<defs><g id="m">${HALF.repeat(350)}</g>${tile('<use href="#m"/>')}</defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(9)),
  'a pattern inside a pattern tile, lent by the tile\'s parent': svg(`<defs>${PT.replace('id="p"', 'id="q"')}<g fill="url(#q)">${tile(`<rect ${FP}/>`.repeat(4))}</g></defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(4)),
};
// ── R13 round 1 ───────────────────────────────────────────────────────────────────────────────────
// [design, the shipped text a mutation removes or weakens, what it becomes]
const G250 = (a, root) => svg(`<defs>${LG}</defs>` + `${SMALL}${a}/>`.repeat(250), root);
const TILE_G = (a) => `<pattern id="p" ${a}><rect width="8.16" height="10.56" fill="url(#lg)"/></pattern>`;
const zig = (n, step) => 'M0 0' + Array.from({ length: n }, (_, i) => `L${(i * step).toFixed(1)} ${i % 2 ? 1056 : 0}`).join('');
// R13 round 2: [the pattern lent by a <g> to a scaled child, the same with the fill on the child itself]
const SEEDING = ['if(!(seed>1)) return P;', 'return P;'];
const GT = (n) => `<pattern id="p" patternUnits="userSpaceOnUse" width="8.16" height="10.56">${'<rect width="8.16" height="10.56" fill="url(#g)"/>'.repeat(n)}</pattern>`;
const DT = '<pattern id="p" patternUnits="userSpaceOnUse" width="80" height="10"><line x1="0" y1="5" x2="80" y2="5.08" stroke="#000" stroke-dasharray="0.01"/></pattern>';
const SM = 'width="81.6" height="105.6"';
const R2 = {
  'a 348-rect 16-stop gradient tile lent by a <g> to one rect scaled up 100x (5.5 s)': [svg(`<defs>${R16}${GT(348)}</defs><g fill="url(#p)"><rect width="8.16" height="10.56" transform="scale(100)"/></g>`),
    svg(`<defs>${R16}${GT(348)}</defs><rect width="8.16" height="10.56" fill="url(#p)" transform="scale(100)"/>`)],
  'the same tile lent as a 2-wide STROKE to one rect scaled up 100x (5.5 s)': [svg(`<defs>${R16}${GT(348)}</defs><g fill="none" stroke="url(#p)" stroke-width="2"><rect width="8.16" height="10.56" transform="scale(100)"/></g>`),
    svg(`<defs>${R16}${GT(348)}</defs><rect width="8.16" height="10.56" fill="none" stroke="url(#p)" stroke-width="2" transform="scale(100)"/>`)],
  'the same tile lent to a <path>, not a rect, scaled up 100x (5.5 s)': [svg(`<defs>${R16}${GT(348)}</defs><g fill="url(#p)"><path d="M0 0h8.16v10.56h-8.16z" transform="scale(100)"/></g>`),
    svg(`<defs>${R16}${GT(348)}</defs><path d="M0 0h8.16v10.56h-8.16z" fill="url(#p)" transform="scale(100)"/>`)],
  'rule: a dashed tile lent by a <g> to 3 rects scaled up 10x (0.48 s)': [svg(`<defs>${DT}</defs><g fill="url(#p)">` + `<rect ${SM} transform="scale(10)"/>`.repeat(3) + '</g>'),
    svg(`<defs>${DT}</defs>` + `<rect ${SM} fill="url(#p)" transform="scale(10)"/>`.repeat(3))],
  'rule: a dashed tile lent by a <g> into a nested <svg> scaling 10x, 3 rects (0.48 s)': [svg(`<defs>${DT}</defs><g fill="url(#p)"><svg ${FP} viewBox="0 0 81.6 105.6">` + `<rect ${SM}/>`.repeat(3) + '</svg></g>'),
    svg(`<defs>${DT}</defs><svg ${FP} viewBox="0 0 81.6 105.6">` + `<rect ${SM} fill="url(#p)"/>`.repeat(3) + '</svg>')],
  'rule: a dashed tile lent by a <g> to 2 <use transform="scale(10)"> (0.32 s)': [svg(`<defs>${DT}<rect id="r" ${SM}/></defs><g fill="url(#p)">` + '<use href="#r" transform="scale(10)"/>'.repeat(2) + '</g>'),
    svg(`<defs>${DT}<rect id="r" ${SM}/></defs>` + '<use href="#r" fill="url(#p)" transform="scale(10)"/>'.repeat(2))],
};
const KIND = ['own<0?inh:own&&max(own,inh)', 'own<0?inh:own'], KNOWN = ['const known=(v)=>v>=0?v:Infinity;', 'const known=(v)=>v>=0?v:0;'];
const R13 = {
  // finding 1: Chromium paints what a shape inherits when its own fill or stroke cannot be read
  'pattern lent by a <g>, each rect fill="x", 48 x 96 <use> (~102 s)': [lent(PT, 'fill="url(#p)"', 96, ' fill="x"'), KIND],
  'pattern lent by a <g>, each rect fill="", 48 x 96 <use> (~102 s)': [lent(PT, 'fill="url(#p)"', 96, ' fill=""'), KIND],
  'pattern lent by a <g>, each rect fill="context-fill", 48 x 96 <use> (~102 s)': [lent(PT, 'fill="url(#p)"', 96, ' fill="context-fill"'), KIND],
  'gradient lent by a <g>, each rect fill="x", 48 x 98 <use> (~31 s)': [lent(LG, 'fill="url(#lg)"', 98, ' fill="x"'), KIND],
  'gradient lent by a <g>, each rect fill="", 48 x 98 <use> (~31 s)': [lent(LG, 'fill="url(#lg)"', 98, ' fill=""'), KIND],
  'gradient lent by a <g>, each rect fill="context-fill", 48 x 98 <use> (~31 s)': [lent(LG, 'fill="url(#lg)"', 98, ' fill="context-fill"'), KIND],
  'pattern stroke lent by a <g>, each rect stroke="x", 2000 wide, 48 x 80 <use> (~84 s)': [lent(PT, 'fill="none" stroke="url(#p)" stroke-width="2000"', 80, ' stroke="x"'), KIND],
  'a pattern inside a pattern tile, through fill="x" (8.1 s)': [svg(`<defs>${PT.replace('id="p"', 'id="q"')}<g fill="url(#q)">${tile(`<rect ${FP} fill="x"/>`.repeat(40))}</g></defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(9)), KIND],
  // finding 2: with uneven offsets every stop adds to every pixel
  '3,000 uneven stops on 20 full-page rects (~29 s)': [svg(`<defs><linearGradient id="g">${unevenStops(3000)}</linearGradient></defs>` + `<rect ${FP} fill="url(#g)"/>`.repeat(20)),
    ["if(SERVER[n.name]===2&&stopsOf(n).length>MAX_STOPS) return", 'if(false) return']],
  // finding 3: each rule of the bound that no test pinned
  '10 small rects scaled up 100x, non-scaling-stroke, dash 0.01 (6.0 s)': [svg('<rect width="8.16" height="10.56" fill="none" stroke="#000" stroke-dasharray="0.01" vector-effect="non-scaling-stroke" transform="scale(100)"/>'.repeat(10)), ['*(ve?v.sc:1)*', '*1*']],
  'a 10-wide near-level line with non-scaling-stroke, dash 0.01 (2.4 s)': [dashed(LEVEL, 1, ' stroke-width="10" vector-effect="non-scaling-stroke"'), ['rows=v.sw*DEV*(ve?1:v.sc)', 'rows=v.sw*DEV*(ve?0:v.sc)']],
  'a near-level line 10mm wide, dash 0.01 (6.0 s)': [dashed(LEVEL, 1, ' stroke-width="10mm"'), ['return w>=0?w:Infinity;', 'return w>=0?w:1;']],
  '200 gradient rects width="100%" height="100%" (1.3 s)': [svg(`<defs>${LG}</defs>` + '<rect width="100%" height="100%" fill="url(#lg)"/>'.repeat(200)), KNOWN],
  '10 dashed rects width="100%" height="100%", dash 0.01 (5.0 s)': [svg('<rect width="100%" height="100%" fill="none" stroke="#000" stroke-dasharray="0.01"/>'.repeat(10)), KNOWN],
  'rule: 2 dashed paths whose length is not a number, 1e309 - 1e309 (2 ms)': [dashed('M1e309 500L1e309 500', 2), KNOWN],
  '250 small gradient rects under scale(10-10), which Chromium reads as scale(10,-10) (1.6 s)': [G250(' y="-105.6" transform="scale(10-10)"'), ['if(!a.every(isFinite)) return Infinity;', 'if(!a.every(isFinite)) return 1;']],
  'rule: 250 small gradient rects with text after the transform, "scale(1) x" (Chromium ignores it: 20 ms)': [G250(' transform="scale(1) x"'), ['return REST.test(v.slice(i))?f:Infinity;', 'return f;']],
  '250 small gradient rects, a root viewBox 10x smaller than the page (1.6 s)': [G250('', 'viewBox="0 0 81.6 105.6"'), ['if(n===root) return f*atLeast1(PAGE_W/b[2]);', 'if(n===root) return f;']],
  '250 small gradient rects in a nested <svg> scaling up 10x (1.6 s)': [svg(`<defs>${LG}</defs><svg ${FP} viewBox="0 0 81.6 105.6">` + `${SMALL}/>`.repeat(250) + '</svg>'),
    ["return f*atLeast1(Math.max(len(attr(n,'width'),NaN)/b[2],len(attr(n,'height'),NaN)/b[3]));", 'return f;']],
  'a pattern tile with a viewBox in object units, a gradient inside, x44 (1.3 s)': [svg(`<defs>${LG}${TILE_G('width="1" height="1" viewBox="0 0 8.16 10.56"')}</defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(44)),
    ["if(n.name==='pattern'&&attr(n,'patternUnits')!=='userSpaceOnUse') return Infinity;", '']],
  'a pattern tile under patternTransform scale(100), a gradient inside, x44 (1.3 s)': [svg(`<defs>${LG}${TILE_G('width="8.16" height="10.56" patternUnits="userSpaceOnUse" patternTransform="scale(100)"')}</defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(44)),
    ["if(n.name==='pattern') f*=stretch(attr(n,'patternTransform'));", '']],
  '250 <use width height> scaling a small gradient <svg> 10x (1.6 s)': [svg(`<defs>${LG}<svg id="s" width="81.6" height="105.6" viewBox="0 0 81.6 105.6">${SMALL}/></svg></defs>` + `<use href="#s" ${FP}/>`.repeat(250)),
    ["if(n.name==='use'&&(attr(n,'width')!=null||attr(n,'height')!=null)) return Infinity;", '']],
  'a mask drawn at the scale of what it masks: a dashed-line mask on 6 rects scaled up 10x (0.88 s)': [svg('<defs><mask id="m"><line x1="0" y1="5" x2="80" y2="5.08" stroke="#000" stroke-dasharray="0.01"/></mask></defs>'
    + '<rect width="81.6" height="105.6" fill="#f00" mask="url(#m)" transform="scale(10)"/>'.repeat(6)), ['w.sc=max(w.sc,v.sc); if(kind===2) continue;', 'if(kind===2) continue; w.sc=max(w.sc,v.sc);']],
  '2 dashed near-level lines with text after the path data (0.9 s)': [dashed(LEVEL + ' #', 2), ['if(k||!REST.test(d.slice(i))) return unread(d);', '']],
  '2 dashed near-level lines ending in an unknown command (0.9 s)': [dashed(LEVEL + 'X', 2), ['if(k||ARGS[l]===undefined) return unread(d);', 'if(k||ARGS[l]===undefined) break;']],
  'the most costly tile, not the last: 9 rects use a 400-rect see-through tile (6.0 s)': [svg(`<defs><pattern id="big" ${FP} patternUnits="userSpaceOnUse">${HALF.repeat(400)}</pattern>${PT}</defs>` + `<rect ${FP} fill="url(#big)"/>`.repeat(9)),
    ['P.tile=Math.max(P.tile,total(m));', 'P.tile=total(m);']],
  '250 small gradient rects under matrix(10 0 0 10 0 0) (1.6 s)': [G250(' transform="matrix(10 0 0 10 0 0)"'), ['s=Math.sqrt((F+Math.sqrt(Math.max(0,F*F-4*D*D)))/2);', 's=1;']],
  'rule: 250 small gradient rects under skewX(84.29), a shear that keeps their area (34 ms)': [G250(' transform="skewX(84.29)"'), ['s=(Math.abs(k)+Math.sqrt(k*k+4))/2;', 's=1;']],
  'a polygon of 2,000 page-tall points (2.5 s)': [svg(`<polygon points="${Array.from({ length: 2000 }, (_, i) => `${(i * 0.2).toFixed(1)},${i % 2 ? 1056 : 0}`).join(' ')}"/>`),
    ["pathGeom(m?'M'+p.slice(0,2*m).join(' ')+(N==='polygon'?'Z':''):'')", '({len:0, w:0, h:0, segs:0, cross:0, lines:0})']],
  'rule: 4 dashed circles r=400, dash 0.01 (curved dashes are cheap: 0.34 s)': [svg('<circle cx="408" cy="528" r="400" fill="none" stroke="#000" stroke-dasharray="0.01"/>'.repeat(4)), ["r={len:2*Math.PI*g('r'),", 'r={len:0,']],
  '3 dashed near-level <line>s, dash 0.01 (1.3 s)': [svg('<line x1="0" y1="500" x2="816" y2="500.816" stroke="#000" stroke-dasharray="0.01"/>'.repeat(3)), ['r={len:Math.hypot(w,h), w, h, segs:1, cross:1, lines:1};', 'r={len:0, w, h, segs:1, cross:1, lines:1};']],
  '2 near-level cubics that sweep out and back, dash 0.01 (0.9 s)': [dashed('M0 500C816 500.8 816 501.6 0 502.4', 2),
    ["else if(c==='c'){ leg(ox+a[0],oy+a[1]); leg(ox+a[2],oy+a[3]); leg(ox+a[4],oy+a[5]); }", "else if(c==='c'){ leg(ox+a[4],oy+a[5]); }"]],
  // finding 4: an outline with many edges, drawn many times or with its long edges on the same rows
  '25,000 tiny subpaths, drawn 2,490 times (22.9 s)': [svg(`<defs><path id="z" fill="none" stroke="#000" d="${'M0 500h.04'.repeat(25000)}"/></defs>` + '<use href="#z"/>'.repeat(2490)),
    ['outline(2*g.cross+2*g.segs,2*g.len+4*v.sw*g.segs,2*g.lines+16*g.segs,STROKE_SEG)', '0']],
  'rule: a stroked page-tall zigzag of 600 edges, both sides of each edge (0.15 s)': [svg(`<path fill="none" stroke="#000" d="${zig(600, 0.8)}"/>`), ['2*g.cross+2*g.segs', 'g.cross']],
  'a filled page-tall zigzag of 4,000 edges (12.8 s)': [svg(`<path d="${zig(4000, 0.2)}"/>`), ['outline(g.cross,g.len,g.lines,FILL_SEG)', '0']],
  'the same zigzag, priced by its rows (12.8 s)': [svg(`<path d="${zig(4000, 0.2)}"/>`), ['Math.max(0,q-FREE_PAIRS)/GEOM_PAIRS', '0']],
  'rule: 120 tiny segments drawn 1,600 times, priced by its segments (~40 ms)': [svg(`<defs><path id="z" fill="none" stroke="#000" stroke-width="0.1" d="M0 500${'h.001'.repeat(120)}"/></defs>` + '<use href="#z"/>'.repeat(1600)),
    ['Math.max(0,g.segs-FREE_SEGS)*each+', '']],
  // R13 round 2: a pattern's tile is drawn at the scale of the shape that PAINTS with it, not of the one that names it
  ...Object.fromEntries(Object.entries(R2).map(([name, [inherited]]) => [name, [inherited, SEEDING]])),
  // ...and each part of the second pass, on its own design (R13 round 3, S3)
  ...Object.fromEntries([['the seed reaches the pattern', 0, ["if(n.name==='pattern') s=Math.max(s,seed);", '']],
    ['the second pass carries the seed to what the pattern holds', 0, ['for(const [t] of links(n,ids,K)) inc.set(t,Math.max(inc.get(t)||0,v.sc));', '']],
    ['a shape that strokes with the pattern counts toward the seed', 1, ['(v.fk===3||v.sk===3)&&v.sc>seed', 'v.fk===3&&v.sc>seed']],
    ['a path, not only a rect, counts toward the seed', 2, ["if(SHAPES[n.name]&&(v.fk===3||v.sk===3)&&v.sc>seed)", "if(n.name==='rect'&&(v.fk===3||v.sk===3)&&v.sc>seed)"]],
  ].map(([what, i, mut]) => [`${Object.keys(R2)[i].replace(/ \(.*\)$/, '')}, ${what} (5.5 s)`, [Object.values(R2)[i][0], mut]])),
};
for (const [name, input] of [...Object.entries(PAINT), ...Object.entries(R13).map(([k, [s]]) => [k, s])]) {
  test(`render cost rejects: ${name}`, () => {
    let r; assert.doesNotThrow(() => { r = S.sanitize(input); }, 'a rejection, never a throw');
    assert.equal(r.ok, false); assert.ok(r.reason); assert.equal(r.svg, undefined);
  });
}
test('a pattern lent to a scaled child costs what the same pattern costs as the child\'s own fill (R13 round 2)', () => {
  for (const [name, [inherited, own]] of Object.entries(R2)) {
    const a = S.sanitize(inherited), b = S.sanitize(own);
    assert.equal(a.ok, false, name); assert.equal(b.ok, false, name + ': own fill (control)');
    assert.ok(Math.abs(a.cost - b.cost) <= 1, `${name}: inherited ${a.cost}, own ${b.cost}`);   // the lending <g> adds its own 1
  }
});
test('a gradient may hold at most 16 stops (S.LIMITS.gradientStops), and the AI is told so', async () => {
  const stops = (n) => svg(`<defs><linearGradient id="g">${unevenStops(n)}</linearGradient></defs><rect ${FP} fill="url(#g)"/>`);
  assert.equal(S.LIMITS.gradientStops, 16);
  assert.ok(S.sanitize(stops(16)).ok, '16 stops'); assert.match(S.sanitize(stops(17)).reason, /more than 16 stops/);
  const { loadStudio } = await import('./helpers-stationery.mjs');
  assert.match(loadStudio(S).contract(), /at most 16 <stop> in one gradient/);
});
// Controls: what real designs paint with stays well inside (each costs under 800 of 5,000): ordinary dashes, gradient
// fills, an opaque pattern tile, a 57-segment stroked vine (the most complex outline in the 36 real and bundled
// designs) drawn 20 times, and a solid colour under a lent pattern (priced as the pattern: an over-count).
test('render cost: ordinary dashes, gradient fills, an opaque tile, a long vine and a coloured child are still fine', () => {
  for (const ok of [svg(DASHED(' stroke-width="2" stroke-dasharray="4 6"') + '<g stroke="#ccc" stroke-dasharray="2,3">'
      + Array.from({ length: 30 }, (_, i) => `<line x1="80" x2="736" y1="${140 + 24 * i}" y2="${140 + 24 * i}"/>`).join('') + '</g>'),
    svg(`<defs>${LG}<radialGradient id="rg"><stop offset="0" stop-color="#fce"/><stop offset="1" stop-color="#e9a"/></radialGradient></defs><rect ${FP} fill="url(#lg)"/>`
      + '<ellipse cx="60" cy="60" rx="14" ry="30" fill="url(#rg)"/>'.repeat(50) + '<g fill="url(#rg)">' + '<circle cx="700" cy="900" r="20"/>'.repeat(10) + '</g>'),
    svg(`<defs>${PT}${tile(`<rect ${FP} fill="#fff"/>`.repeat(10)).replace('id="p"', 'id="t"')}</defs><rect ${FP} fill="url(#p)"/>` + `<rect ${FP} fill="url(#t)"/>`.repeat(3)),
    svg(`<defs><path id="v" fill="none" stroke="#596" stroke-width="2" d="M20 60${Array.from({ length: 57 }, (_, i) => ` q8 ${i % 2 ? 8 : -8} 0 16`).join('')}"/></defs>` + '<use href="#v"/>'.repeat(20)),
    svg(`<defs>${PT}</defs><g fill="url(#p)">` + `<rect ${FP} fill="#fff"/>`.repeat(4) + '</g>')]) {
    const r = S.sanitize(ok); assert.ok(r.ok, r.reason); assert.ok(r.cost < 800, `costs ${r.cost}`);
  }
});
const PAINT_MUTANTS = [
  // each rule of the paint price, and each way a paint is inherited
  ...[['the dash price', (s) => s.replace('if(v.dash>0){', 'if(false){'), 'stroke-dasharray="0.01" on 10 full-page rects (5.0 s)'],
    ['inherited dashes', (s) => s.replace('w.dash=max(w.dash,v.dash);', ''), 'stroke-dasharray="0.01" lent by a <g>, 10 rects (5.0 s)'],
    ['inheritance through <use>', (s) => s.replace('if(kind===2) continue;', 'if(kind) continue;'), 'stroke-dasharray="0.01" lent by the <use>, 10 uses (5.0 s)'],
    ['inheritance through <use> into a tile', (s) => s.replace('if(kind===2) continue;', 'if(kind) continue;'), 'a tile that draws 350 see-through rects through <use>, x9 (5.2 s)'],
    ['the stroke width a dash spans', (s) => s.replace('Math.max(2,rows<H_DEV?rows:H_DEV)', '2'), 'a 10-wide near-level line, dash 0.01 (2.1 s)'],
    ['the stretch of a transform (dashes)', (s) => s.replace('sc:u.sc*o[4]', 'sc:1'), 'a dashed rect scaled up 20x, dash 0.00125 (4.0 s)'],
    ['the stretch of a transform (gradient area)', (s) => s.replace('sc:u.sc*o[4]', 'sc:1'), 'a small gradient rect scaled up 10x, x250 (1.7 s)'],
    ['an arc\'s length', (s) => s.replace('L+=2*Math.PI*R;', ''), 'a flat ellipse drawn by ONE arc, dash 0.01, x4 (3.4 s)'],
    ['an unreadable dash is the worst case', (s) => s.replace('every((x)=>x>=0)) return Infinity;', 'every((x)=>x>=0)) return 0;'), 'a dash in mm (0.0025mm), 10 rects (6.0 s)'],
    ['the gradient price', (s) => s.replace('k===2?GRAD_COST*area(e)', 'k===2?0'), '1,248 full-page gradient rects (8.1 s)'],
    ['an inherited fill kind', (s) => s.replace('w.fk=max(w.fk,v.fk);', 'w.fk=max(w.fk,v.fk&&1);'), 'gradient lent by a <g>, 48 rects x 98 <use> (~31 s)'],
    ['an inherited stroke kind', (s) => s.replace('w.sk=max(w.sk,v.sk);', 'w.sk=max(w.sk,v.sk&&1);'), 'pattern stroke lent by a <g>, 2000 wide, 48 rects x 80 <use> (~85 s)'],
    ['the pattern price', (s) => s.replace('k===3?PASS_COST+P.tile:0', 'k===3?0:0'), 'pattern lent by a <g>, 48 rects x 96 <use> (~102 s)'],
    ['a stroke reaching out its width', (s) => s.replace('c+=server(v.sk,v.sw)+', 'c+=server(v.sk,0)+'), 'a gradient stroke 2000 wide on a line, x250 (1.7 s)'],
    ['the tile price', (s) => s.replace('let c=v.tile?TILE_COST:0;', 'let c=0;'), 'a full-page tile of 400 see-through rects, x9 (6.0 s)'],
    ['the nested rule for an inherited pattern', (s) => s.replace('if(v.tile&&SHAPES[n.name]&&(v.fk===3||v.sk===3)) return {nested:true};', ''), 'a pattern inside a pattern tile, lent by the tile\'s parent'],
  ].map(([rule, mutate, name]) => [rule, mutate, PAINT[name]]),
  ...Object.entries(R13).map(([name, [design, [from, to]]]) => [`${name.replace(/ \(.*\)$/, '')}: ${from}`, (s) => s.replace(from, to), design]),
];
for (const [rule, mutate, attack] of PAINT_MUTANTS) {
  test(`mutation: without ${rule}, the costly design gets through`, () => {
    assert.equal(S.sanitize(attack).ok, false, 'shipped: rejected');
    const r = loadStationery({ mutate }).sanitize(attack); assert.equal(r.ok, true, 'mutant: accepted — ' + r.reason);
  });
}
