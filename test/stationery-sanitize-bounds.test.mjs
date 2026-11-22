// Every bound of the render-cost budget, pinned · 渲染成本的每条界限 (ADR 0003 amendment 3, R13 round 3)
//
// The readers (web/stationery-geometry.inline.html) and prices (web/stationery-cost.inline.html) are upper bounds.
// A bound that no test feeds can be deleted with every test still green (R14), so each design here is REJECTED
// as shipped and ACCEPTED by one mutation of the shipped source: that text is what decides it. Then each price
// gets a boundary (n accepted, n + 1 rejected), and sanitize()'s cost readout is held to the controls.
// Times: Chromium (Playwright) on the Journal's raster path at 1640 device px. "rule:" marks a design Chromium
// draws cheaply: it pins a bound that must hold whichever way Chromium reads the value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStationery, svg, FP, LG, PT, HALF, SMALL, dashed, R16 } from './helpers-stationery.mjs';

const S = loadStationery();
const G250 = (inner) => svg(`<defs>${LG}</defs>` + inner.repeat(250));
const uses = (el, n) => svg(`<defs>${el}</defs>` + '<use href="#z"/>'.repeat(n));
const zig = (n, step, h = 1056) => 'M0 0' + Array.from({ length: n }, (_, i) => `L${(i * step).toFixed(3)} ${i % 2 ? h : 0}`).join('');
const turb = (oct, n) => svg(`<filter id="t"><feTurbulence baseFrequency="0.9" numOctaves="${oct}"/></filter>` + `<rect ${FP} filter="url(#t)"/>`.repeat(n));

// [design, the shipped text a mutation removes or weakens, what it becomes]
const PINS = {
  // B1: a pattern inside a mask or a clip-path is a nested effect; only url(#pattern) setting fx says so now
  'a pattern inside a mask': [svg(`<defs>${PT}<mask id="m"><rect width="9" height="9" fill="url(#p)"/></mask></defs><rect width="9" height="9" mask="url(#m)"/>`),
    ['r.fx=r.fx||!!EFFECT[t.name]; continue;', 'continue;']],
  'a pattern inside a clipPath': [svg(`<defs>${PT}<clipPath id="c"><rect width="9" height="9" fill="url(#p)"/></clipPath></defs><rect width="9" height="9" clip-path="url(#c)"/>`),
    ['r.fx=r.fx||!!EFFECT[t.name]; continue;', 'continue;']],
  // B2: the stretch, the second pass and the scale readers
  'a filled zigzag of 1,500 edges drawn 100x larger (1.2 s)': [svg(`<path d="${zig(1500, 0.002, 10.56)}" transform="scale(100)"/>`), ['s=v.sc*DEV;', 's=DEV;']],
  'a tile of 100 small gradient rects, each scaled 100x inside the tile, painted 100x larger (0.68 s)': [svg(`<defs>${LG}<pattern id="p" patternUnits="userSpaceOnUse" width="8.16" height="10.56">`
    + '<rect width="0.0816" height="0.1056" fill="url(#lg)" transform="scale(100)"/>'.repeat(100) + '</pattern></defs><g fill="url(#p)"><rect width="8.16" height="10.56" transform="scale(100)"/></g>'),
    ['v.sc=s*O.get(n)[4];', 'v.sc=s;']],
  'a gradient rect drawn 100 times 100x larger, and once in a tile painted 2x larger (0.66 s)': [svg(`<defs>${LG}<rect id="e" width="8.16" height="10.56" fill="url(#lg)"/>`
    + '<pattern id="p" patternUnits="userSpaceOnUse" width="8.16" height="10.56"><use href="#e"/></pattern></defs>'
    + '<g transform="scale(100)">' + '<use href="#e"/>'.repeat(100) + '</g><rect width="8.16" height="10.56" fill="url(#p)" transform="scale(2)"/>'),
    ['let s=Math.max(v.in,inc.get(n)||0);', 'let s=inc.get(n)||0;']],
  '250 gradient rects under scale(1,10) (1.7 s)': [G250('<rect width="816" height="105.6" fill="url(#lg)" transform="scale(1,10)"/>'), ['Math.abs(a.length>1?q:p)', 'Math.abs(p)']],
  '250 small gradient rects in a nested <svg> with no size, 100% of the page (1.7 s)': [svg(`<defs>${LG}</defs><svg viewBox="0 0 81.6 105.6">` + `${SMALL}/>`.repeat(250) + '</svg>'),
    ['s<=1?1:Infinity', 's<=1?1:1']],
  'a filled 4,000-edge zigzag with text after its data (12.8 s)': [svg(`<path d="${zig(4000, 0.2)} #"/>`), ['segs:T, cross:3*T, lines:256*T', 'segs:0, cross:0, lines:0']],
  // B2: geometry that no test read
  '2 dashed flat ellipses rx 400 ry 1, dash 0.01 (1.7 s)': [svg('<ellipse cx="408" cy="528" rx="400" ry="1" fill="none" stroke="#000" stroke-dasharray="0.01"/>'.repeat(2)),
    ["len:2*Math.PI*Math.max(g('rx'),g('ry'))", 'len:0']],
  'rule: 1,250 rounded rects stroked 2,000 wide (0.28 s)': [svg(`<rect rx="9" ${FP} fill="none" stroke="#000" stroke-width="2000"/>`.repeat(1250)), ['segs:o?8:4, cross:2, lines:o?260:4', 'segs:4, cross:2, lines:4']],
  '2 near-level T curves that sweep out and back, dash 0.01 (0.31 s)': [dashed('M408 500Q816 500.8 408 501.6T408 503.2', 2), ['leg(kx,ky); leg(ox+a[0],oy+a[1]);', 'leg(ox+a[0],oy+a[1]);']],
  '120 gradient half-page triangles drawn with h and v (0.42 s)': [svg(`<defs>${LG}</defs>` + '<path d="M0 0h816v1056z" fill="url(#lg)"/>'.repeat(120)), ["else if(c==='v') leg(x,oy+a[0]);", "else if(c==='v'){ y=oy+a[0]; }"]],
  '2 flat half-ellipses from an arc with too-small radii, dash 0.01 (1.0 s)': [dashed('M8 528A1 0.001 0 0 0 808 528', 2), ['R=Math.max(rx,ry)*(lam>1?Math.sqrt(lam):1)', 'R=Math.max(rx,ry)']],
  // B2: prices that lowered costs but decided no verdict
  'rule: 900 tiny filled steps, drawn 2,000 times (39 ms)': [uses(`<path id="z" d="M0 500${'h.001v.001'.repeat(450)}"/>`, 2000), ['FILL_SEG=0.002', 'FILL_SEG=0']],
  'rule: 14,000 tiny filled squares in one place (8 ms)': [svg(`<path d="${'M0 500h.01v.01h-.01z'.repeat(14000)}"/>`), ['q=x*((r<k*H_DEV?r:k*H_DEV)+k)', 'q=x*((r<k*H_DEV?r:k*H_DEV))']],
  'rule: 500 tiny segments stroked 50 wide, drawn 8 times (2 ms)': [uses(`<path id="z" fill="none" stroke="#000" stroke-width="50" d="M0 500${'l.01 .01'.repeat(500)}"/>`, 8), ['2*g.len+4*v.sw*g.segs', '2*g.len']],
  'rule: 1,000 tiny stroked segments, drawn 50 times (5 ms)': [uses(`<path id="z" fill="none" stroke="#000" d="M0 500${'l.01 .01'.repeat(1000)}"/>`, 50), ['2*g.lines+16*g.segs', '2*g.lines']],
  '120 full-page gradient circles (0.80 s)': [svg(`<defs>${LG}</defs>` + '<circle cx="408" cy="528" r="660" fill="url(#lg)"/>'.repeat(120)), ["w:2*g('r'), h:2*g('r')", 'w:0, h:0']],
  '120 full-page gradient ellipses (0.79 s)': [svg(`<defs>${LG}</defs>` + '<ellipse cx="408" cy="528" rx="600" ry="760" fill="url(#lg)"/>'.repeat(120)), ["w:2*g('rx'), h:2*g('ry')", 'w:0, h:0']],
  '120 gradient paths whose box is set by a Q control point (0.29 s)': [svg(`<defs>${LG}</defs>` + '<path d="M0 0Q0 1056 816 0Z" fill="url(#lg)"/>'.repeat(120)),
    ["else if(c==='q'){ leg(ox+a[0],oy+a[1]); leg(ox+a[2],oy+a[3]); }", "else if(c==='q'){ leg(ox+a[2],oy+a[3]); }"]],
  '120 gradient paths whose box is set by an S control point (0.26 s)': [svg(`<defs>${LG}</defs>` + '<path d="M0 0C0 0 0 0 0 0S0 1056 816 0Z" fill="url(#lg)"/>'.repeat(120)),
    ["else if(c==='s'){ leg(lx,ly); leg(ox+a[0],oy+a[1]); leg(ox+a[2],oy+a[3]); }", "else if(c==='s'){ leg(ox+a[2],oy+a[3]); }"]],
  '3 level h lines, dash 0.01 (0.81 s)': [dashed('M0 500h816', 3), ["else if(c==='h') leg(ox+a[0],y);", "else if(c==='h'){ x=ox+a[0]; }"]],
  '120 gradient half-discs drawn by an arc (0.25 s)': [svg(`<defs>${LG}</defs>` + '<path d="M8 528A400 400 0 0 0 808 528Z" fill="url(#lg)"/>'.repeat(120)), ['at(x-2*R,y-2*R); at(x+2*R,y+2*R);', '']],
  'a filled zigzag of 900 page-tall cubics (0.21 s)': [svg(`<path d="M0 0${Array.from({ length: 900 }, (_, i) => `C${(i * 0.2 + 0.05).toFixed(2)} ${i % 2 ? 352 : 704} ${(i * 0.2 + 0.1).toFixed(2)} ${i % 2 ? 704 : 352} ${(i * 0.2 + 0.2).toFixed(2)} ${i % 2 ? 0 : 1056}`).join('')}"/>`),
    ['q:2,t:2,a:2,c:3,s:3}', 'q:1,t:1,a:1,c:1,s:1}']],
  'the same zigzag of cubics, counted per segment (0.21 s)': [svg(`<path d="M0 0${Array.from({ length: 900 }, (_, i) => `C${(i * 0.2 + 0.05).toFixed(2)} ${i % 2 ? 352 : 704} ${(i * 0.2 + 0.1).toFixed(2)} ${i % 2 ? 704 : 352} ${(i * 0.2 + 0.2).toFixed(2)} ${i % 2 ? 0 : 1056}`).join('')}"/>`),
    ['X+=CROSS[c]; N+=LINES[c];', 'X+=1; N+=1;']],
  'rule: 1,800 tiny filled curves, drawn 7 times (3 ms)': [uses(`<path id="z" d="M0 500${'q.01 .02 .02 0'.repeat(1800)}"/>`, 7), ['q:64,t:64,a:256,c:64,s:64}', 'q:1,t:1,a:1,c:1,s:1}']],
  'rule: 15,000 closed empty subpaths, drawn 14 times (9 ms)': [uses(`<path id="z" d="${'M0 500z'.repeat(15000)}"/>`, 14), ['leg(sx,sy); S++; X++; N++;', 'leg(sx,sy);']],
  // S5: older rules moved verbatim, now pinned
  'rule: a clipPath of 60 small shapes, used by 2 rects (11 ms)': [svg(`<defs><clipPath id="c">${'<rect width="8" height="10"/>'.repeat(60)}</clipPath></defs>` + `<rect ${FP} fill="#f00" clip-path="url(#c)"/>`.repeat(2)),
    ["t.name==='clipPath'?Math.max(1,c.size-1):1", "t.name==='clipPath'?1:1"]],
  '5 full-page turbulence rects with 8 octaves (1.2 s)': [turb(8, 5), ["steps+=k.name==='feTurbulence'?Math.max(1,+(attr(k,'numOctaves')||1)):1", 'steps+=1']],
  '2 rects under an 8-step blur over a region 2x the element (0.39 s)': [svg('<filter id="f" x="-0.5" y="-0.5" width="2" height="2">' + '<feGaussianBlur stdDeviation="3"/>'.repeat(8) + `</filter>` + `<rect ${FP} filter="url(#f)"/>`.repeat(2)),
    ["Math.ceil(steps*Math.max(1,frac(attr(n,'width'),1.2)*frac(attr(n,'height'),1.2)))", 'Math.ceil(steps)']],
  'rule: a filter whose region starts 5 boxes away': [svg(`<filter id="f" x="-5"><feOffset dx="1"/></filter><rect ${FP} filter="url(#f)"/>`), ['||Math.abs(x)>1||Math.abs(y)>1', '']],
  'rule: a filter whose region x is not a number': [svg(`<filter id="f" x="abc"><feOffset dx="1"/></filter><rect ${FP} filter="url(#f)"/>`), ['![x,y,w,h].every(isFinite)||', '']],
};
for (const [name, [design]] of Object.entries(PINS)) {
  test(`render cost rejects: ${name}`, () => { const r = S.sanitize(design); assert.equal(r.ok, false); assert.ok(r.reason); assert.equal(r.svg, undefined); });
}
for (const [name, [design, [from, to]]] of Object.entries(PINS)) {
  test(`mutation: without ${name.replace(/ \(.*\)$/, '')} (${from}), it gets through`, () => {
    const r = loadStationery({ mutate: (s) => s.replace(from, to) }).sanitize(design); assert.equal(r.ok, true, 'mutant: accepted — ' + r.reason);
  });
}
test('B1: a pattern inside a mask or a clipPath is the nested rule, by name', () => {
  for (const k of ['a pattern inside a mask', 'a pattern inside a clipPath']) assert.match(S.sanitize(PINS[k][0]).reason, /may not itself use/, k);
});
test('S5: a loop is refused as a loop, by name (<use>, url(#id), and a pattern whose tile paints with itself)', () => {
  for (const d of [svg('<g id="a"><use href="#a"/></g>'), svg('<mask id="a"><rect width="9" height="9" mask="url(#b)"/></mask><mask id="b"><rect width="9" height="9" mask="url(#a)"/></mask>'),
    svg('<pattern id="p" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="url(#p)"/></pattern><rect width="9" height="9" fill="url(#p)"/>')])
    assert.match(S.sanitize(d).reason, /loops back on itself/);
});

// ── S1: every price has a boundary: n accepted, n + 1 rejected (the counts from the binary search) ──────────
const STAR = Array.from({ length: 40 }, (_, i) => { const a = i * Math.PI / 20, r = i % 2 ? 300 : 520; return `${(408 + r * Math.sin(a)).toFixed(1)},${(528 - r * Math.cos(a)).toFixed(1)}`; }).join(' ');
const EDGE = {
  'gradient fill on full-page rects (the largest: 0.58 s)': [89, (n) => svg(`<defs>${LG}</defs>` + `<rect ${FP} fill="url(#lg)"/>`.repeat(n))],
  '16 uneven radial stops with stop-opacity on full-page rects (the largest: 1.40 s)': [88, (n) => svg(`<defs>${R16}</defs>` + `<rect ${FP} fill="url(#g)"/>`.repeat(n))],
  'pattern fill on full-page rects (the largest: 0.99 s)': [45, (n) => svg(`<defs>${PT}</defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(n))],
  'a full-page tile of n see-through rects, used by 9 (the largest: 1.06 s)': [58, (n) => svg(`<defs><pattern id="p" ${FP} patternUnits="userSpaceOnUse">${HALF.repeat(n)}</pattern></defs>` + `<rect ${FP} fill="url(#p)"/>`.repeat(9))],
  'see-through layers: rects with opacity over fill and stroke (the largest: 0.98 s)': [383, (n) => svg(`<defs><g id="r"><rect x="0.3" y="0.3" ${FP} fill="#fff" stroke="#000" stroke-width="2" opacity="0.5"/></g></defs>` + '<use href="#r"/>'.repeat(n))],
  'near-level lines with dashes 0.01 long (the largest: 0.95 s)': [2, (n) => svg('<path fill="none" stroke="#000" stroke-dasharray="0.01" d="' + Array.from({ length: n }, (_, i) => `M0 ${10 + i * 7}l816 0.816`).join('') + '"/>')],
  'a filled page-tall zigzag of n edges (the largest: 0.41 s)': [1237, (n) => svg(`<path d="${zig(n, 0.2)}"/>`)],
  'a stroked 40-point star over the page, past its free share (the largest: 0.16 s)': [469, (n) => svg(`<defs><polygon id="s" fill="none" stroke="#000" points="${STAR}"/></defs>` + '<use href="#s"/>'.repeat(n))],
};
for (const [name, [n, build]] of Object.entries(EDGE)) {
  test(`boundary: ${name}: ${n} accepted, ${n + 1} rejected`, () => {
    const a = S.sanitize(build(n)), b = S.sanitize(build(n + 1));
    assert.equal(a.ok, true, `${n}: ${a.reason}`); assert.equal(b.ok, false, `${n + 1} accepted at cost ${b.cost ?? 'none'}`);
    assert.ok(a.cost < b.cost, `the readout: ${a.cost} / ${b.cost ?? 'none'} (${b.reason || 'accepted'})`);   // a rejection before the budget has no cost
  });
}
