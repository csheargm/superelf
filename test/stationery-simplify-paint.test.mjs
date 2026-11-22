// What a plain colour keeps, and what stays hidden · 简化后保持原样 (ADR 0003 amendment 5, R13 round 2)
//
// The R13 round 2 review confirmed four findings in the pattern and gradient steps, each measured in Chromium on 16f6749:
//   · a texture LENT by a group (or a <use>) to a shape with its own fill-opacity became a solid page: the share was written on
//     the lender only, and a shape's own opacity overrides an inherited one (a 1% dot texture became a 90% dark grey page);
//   · a gradient on a shape of no width or height (a level rule, a common AI motif) is not drawn by Chromium, but became a solid
//     gold line;
//   · a tile counted shapes it never draws (in a <defs>, <clipPath> or <mask>), skipped each <use>, and read "transparent" (in a
//     tile or a stop) as a colour: red dots turned grey-black, or vanished with a fade;
//   · the default stroke width of a tile's line (1) had no test.
// The real neon draft showed one more: its glowing level frame lines appeared once their filter went. Chromium never drew them (a
// filter's region is in the shape's box, and a level line's box has no height), so they stay hidden; the same under a mask.
// Every expected value below is what Chromium draws (measured: ADR 0003, R13 round 2). Mutation evidence at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, FP, LG, loadStill, loadStudio, svg, heartsOf, simplifiedNote as note, answerWith as answer,
  countMatches as count, replaceOnce as san, draftFlow, useChain as chain, TOO_COMPLEX as PLAIN, NO_DEADLINE } from './helpers-stationery.mjs';

const S = loadStill();
const NEON = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'stationery-rejected-region.svg'), 'utf8');
const PAGES = `<rect ${FP} fill="url(#lg)"/>`.repeat(92);   // 92 page gradients: over the budget, so the gradient step runs

// ── 1. A lent paint: the share also goes where a shape's own opacity overrides the lender's ──────────────────────────────
const DOTS = '<pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.2" fill="#333"/></pattern>';
const HALF_TILE = '<pattern id="o" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="10" fill="#acd"/></pattern>';
const TARGETS = '<g id="tg"><defs><rect width="3" height="3" fill-opacity="0.9"/></defs><rect width="9" height="9"/></g>'   // its <defs> draws nothing
  + '<g id="mix"><rect width="9" height="9" fill="#0f0" fill-opacity="0.9"/><rect x="10" width="9" height="9"/></g>';      // the first paints its own
const LENT = svg(`<defs>${DOTS}${HALF_TILE}<rect id="bg" ${FP} fill-opacity="0.9"/><rect id="bg2" ${FP} fill-opacity="0.9"/><rect id="plain" width="9" height="9"/>${TARGETS}</defs>`
  + `<rect ${FP} fill="#fffaf2"/><g fill="url(#d)"><rect ${FP} fill-opacity="0.9"/><rect width="8" height="8" fill-opacity=""/><g fill-opacity="0.5"><rect width="7" height="7"/></g>`
  + '<rect width="6" height="6" fill="#f00" fill-opacity="0.9"/></g><g fill-opacity="0.5"><rect width="5" height="5" fill="url(#d)" fill-opacity=""/></g>'
  + '<use href="#bg" fill="url(#d)"/><use href="#bg2" fill="url(#o)"/><use href="#plain" fill="url(#d)"/><use href="#tg" fill="url(#d)"/><use href="#mix" fill="url(#d)"/>'
  + '<g fill="url(#d)"><defs><rect id="kept" width="4" height="4" fill-opacity="0.9"/></defs></g><use href="#kept" fill="#f00"/>' + heartsOf('d', 46));
test('a texture lent by a group stays faint on a shape that sets its own fill-opacity (the R13 scenario: a dark grey page)', () => {
  assert.equal(S.sanitize(LENT).over, true);
  const r = S.simplify(LENT);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  // dots cover 1.13% of the tile: the child's own 0.9 becomes 0.9 x 1.13%, not 90% of a solid #333
  assert.match(r.svg, new RegExp(`<g fill="#333" fill-opacity="0.0113"><rect ${FP} fill-opacity="0.0102"/>`));
  assert.match(r.svg, /<rect width="8" height="8" fill-opacity=""\/>/, 'an unreadable one is no override: Chromium reads the group\'s');
  assert.match(r.svg, /<g fill-opacity="0.0057"><rect width="7" height="7"\/><\/g>/, 'a group of its own below the lender');
  assert.match(r.svg, /<rect width="6" height="6" fill="#f00" fill-opacity="0.9"\/>/, 'a shape with its own paint is not lent: untouched');
  assert.match(r.svg, /<g fill-opacity="0.5"><rect width="5" height="5" fill="#333" fill-opacity="0.0057"\/><\/g>/, 'its own "" reads the 0.5 above');
  assert.match(r.svg, /<defs><rect id="kept" width="4" height="4" fill-opacity="0.9"\/><\/defs><\/g><use href="#kept" fill="#f00"\/>/,
    'a <defs> below the lender draws nothing there: its red 90% (drawn through a <use>) is untouched');
});
test('through a <use> nothing is written in the shared target; the <use> paints none when that is nearer', () => {
  const r = S.simplify(LENT);
  assert.match(r.svg, /<use href="#bg" fill="none"\/>/, 'the target sets 0.9 of its own, the share is 1.13%: none is nearer than 90% #333');
  assert.match(r.svg, /<use href="#bg2" fill="#acd" fill-opacity="0.5"\/>/, 'a share of a half: the colour (at the target\'s own 0.9)');
  assert.match(r.svg, /<use href="#plain" fill="#333" fill-opacity="0.0113"\/>/, 'control: a target that sets none inherits the share');
  assert.match(r.svg, /<use href="#tg" fill="#333" fill-opacity="0.0113"\/><use href="#mix" fill="#333" fill-opacity="0.0113"\/>/,
    'no override where the paint goes: not in the target\'s <defs>, nor under a shape with its own paint');
  assert.match(r.svg, new RegExp(`<rect id="bg" ${FP} fill-opacity="0.9"/><rect id="bg2" ${FP} fill-opacity="0.9"/>`), 'targets as they were');
});

// ── 2. A shape of no width or height draws nothing with a bounding-box gradient or pattern ───────────────────────────────
const GOLD = '<linearGradient id="gold"><stop offset="0" stop-color="#b8860b"/><stop offset="0.5" stop-color="#ffd700"/><stop offset="1" stop-color="#b8860b"/></linearGradient>';
const RULES = svg(`<defs>${LG}${GOLD}<linearGradient id="gu" gradientUnits="userSpaceOnUse" x1="0" x2="816"><stop offset="0" stop-color="#ffd700"/><stop offset="1" stop-color="#b8860b"/></linearGradient>`
  + '<pattern id="pb" width="0.5" height="0.5"><rect width="20" height="20" fill="#c33"/></pattern><line id="rule" x1="80" y1="0" x2="736" y2="0" stroke-width="4"/></defs>'
  + `${PAGES}<line x1="100" y1="200" x2="716" y2="200" stroke="url(#gold)" stroke-width="6"/><path d="M100 400H716" stroke="url(#gold)"/>`
  + '<g stroke="url(#gold)" stroke-width="4"><line x1="80" y1="600" x2="736" y2="600"/><rect x="80" y="610" width="656" height="20" fill="none"/></g>'
  + '<use href="#rule" y="300" stroke="url(#gold)"/><line x1="100" y1="700" x2="716" y2="700" stroke="url(#gu)"/><line x1="100" y1="800" x2="716" y2="800" stroke="url(#pb)"/>');
const RULED = '<line x1="100" y1="200" x2="716" y2="200" stroke="none" stroke-width="6"/><path d="M100 400H716" stroke="none"/>'
  + '<g stroke="#ffd700" stroke-width="4"><line x1="80" y1="600" x2="736" y2="600" stroke="none"/><rect x="80" y="610" width="656" height="20" fill="none"/></g>'
  + '<use href="#rule" y="300" stroke="none"/><line x1="100" y1="700" x2="716" y2="700" stroke="#ffd700"/><line x1="100" y1="800" x2="716" y2="800" stroke="none"/>';
test('gold rules Chromium never drew stay undrawn: on a level line or path, lent by a group, or through a <use>', () => {
  assert.equal(S.sanitize(RULES).over, true);
  const r = S.simplify(RULES);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills, gradients', '图案填充、渐变'));
  // the rect in the group has a box: it keeps the gold; a user-space gradient is drawn on a level line: it keeps it too
  assert.ok(r.svg.endsWith(RULED + '</svg>'), r.svg.slice(-700));
});
test('user flow (R6): the studio draws the gold-rule draft as Chromium would, and Keep saves exactly that', async (t) => {
  const f = draftFlow(t);
  await f.reply(RULES);
  const said = note('pattern fills, gradients', '图案填充、渐变');
  assert.deepEqual([f.drawn(), f.say(), f.msg.classList.contains('err')], [true, said, false]);
  f.btn('Keep ·').click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.saved.length, 1); assert.ok(f.saved[0].svg.endsWith(RULED + '</svg>'), 'no gold line the original never showed');
  assert.deepEqual(await loadStudio(S).design(answer(RULES), 'x'), { ok: true, svg: S.simplify(RULES).svg, convoId: 'c1', reason: '', note: said });
});

// ── 3. A tile counts what it draws; a colour's own alpha counts once ────────────────────────────────────────────────────
const tile = (id, body) => `<pattern id="${id}" width="20" height="20" patternUnits="userSpaceOnUse">${body}</pattern>`;
const TILES = svg('<defs>' + tile('u', '<defs><circle id="dot" r="9"/></defs><use href="#dot" x="10" y="10" fill="#c33"/>')
  + tile('t', '<rect width="20" height="20" fill="transparent"/><circle cx="10" cy="10" r="8" fill="#c33"/>')
  + tile('m', '<pattern id="inner" width="5" height="5"><rect width="20" height="20" fill="#000"/></pattern><rect width="10" height="20" fill="#acd"/>')
  + tile('a', '<rect width="20" height="20" fill="rgba(0,0,0,0.5)"/>') + tile('h8', '<rect width="20" height="10" fill="#0000007f"/>')
  + tile('e', '<g fill-opacity="0.5"><rect width="20" height="20" fill="#acd" fill-opacity=""/></g>')
  + '</defs><rect width="99" height="99" fill="url(#u)"/><rect width="98" height="98" fill="url(#t)"/><rect width="97" height="97" fill="url(#m)"/>'
  + '<rect width="96" height="96" fill="url(#a)"/><rect width="95" height="95" fill="url(#h8)"/><rect width="94" height="94" fill="url(#e)"/>' + heartsOf('u', 46));
test('a tile counts only what it draws: a <use> as its target, painted from the <use>; never a <defs> or a held <pattern>', () => {
  assert.equal(S.sanitize(TILES).over, true);
  const r = S.simplify(TILES);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  assert.match(r.svg, /<rect width="99" height="99" fill="#c33" fill-opacity="0.6362"\/>/, 'red dots of r=9 (was grey-black: the <defs> circle)');
  assert.match(r.svg, /<rect width="98" height="98" fill="#c33" fill-opacity="0.5027"\/>/, 'transparent paints nothing (was fill="transparent")');
  assert.match(r.svg, /<rect width="97" height="97" fill="#acd" fill-opacity="0.5"\/>/, 'a <pattern> it only holds draws nothing (nor a <clipPath>, a <mask>)');
  assert.match(r.svg, /<rect width="94" height="94" fill="#acd" fill-opacity="0.5"\/>/, 'an unreadable fill-opacity reads the group\'s 0.5');
});
const fadeTo = (id, from, to = '#c33') => `<linearGradient id="${id}"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
const FADES = svg(`<defs>${LG}${fadeTo('g1', 'transparent')}${fadeTo('g2', 'rgba(204,51,51,0)')}${fadeTo('g3', 'rgb(204 51 51 / 20%)')}${fadeTo('g4', '#cc333333', '#c333')}`
  + `${fadeTo('g5', '#cc333333')}</defs>${PAGES}` + [94, 93, 92, 91, 90].map((w, i) => `<rect width="${w}" height="${w}" fill="url(#g${i + 1})"/>`).join(''));
test('a colour\'s own alpha counts once: in the share, and divided out where it is written (it is drawn with it)', () => {
  const r = S.simplify(TILES);
  assert.match(r.svg, /<rect width="96" height="96" fill="rgba\(0,0,0,0.5\)"\/>/, 'a whole tile at 50%: 50%, not 25%');
  assert.match(r.svg, /<rect width="95" height="95" fill="#0000007f" fill-opacity="0.5"\/>/, 'half a tile at 50%: 25% in all');
  const g = S.simplify(FADES);
  assert.equal(g.note, note('gradients', '渐变'), g.reason);
  assert.match(g.svg, /<rect width="94" height="94" fill="#c33" fill-opacity="0.5"\/><rect width="93" height="93" fill="#c33" fill-opacity="0.5"\/>/,
    'a fade from transparent, or from an rgba() at 0: half #c33 (was fill="transparent": the fade vanished)');
  assert.match(g.svg, /<rect width="92" height="92" fill="#c33" fill-opacity="0.6"\/>/, 'a stop at 20% after "/" counts 20%');
  assert.match(g.svg, /<rect width="91" height="91" fill="#cc333333"\/>/, '#rrggbbaa and #rgba: drawn with their own 20%');
  assert.match(g.svg, /<rect width="90" height="90" fill="#c33" fill-opacity="0.6"\/>/, '#rrggbbaa at 20%, then #c33: 60% #c33');
});
test('a hatch line with no stroke-width is 1 wide (the default), not none', () => {
  const r = S.simplify(svg(`<defs><pattern id="h" width="10" height="10" patternUnits="userSpaceOnUse"><line x1="0" y1="10" x2="10" y2="0" stroke="#99a"/></pattern></defs>`
    + `<rect width="98" height="98" fill="url(#h)"/>${heartsOf('h', 46)}`));
  assert.equal(r.ok, true, r.reason);
  assert.match(r.svg, /<rect width="98" height="98" fill="#99a" fill-opacity="0.1414"\/>/, '10 x sqrt 2 long, 1 wide, on a 10 x 10 tile');
});

// ── 4. What a filter or a mask hid stays hidden ────────────────────────────────────────────────────────────────────────
const F = '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>', BIG = '<filter id="big" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="9"/></filter>';
const GLOWING = (f) => `<line x1="30" y1="52" x2="786" y2="52" stroke="#f0f" filter="url(#${f})"/><path d="M30 60V900" stroke="#f0f" filter="url(#${f})"/>`
  + `<line x1="0" y1="0" x2="9" y2="9" stroke="#f0f" filter="url(#${f})"/><g fill="#fcc" filter="url(#${f})"><circle cx="20" cy="20" r="9"/></g>`;
const HIDDEN = '<line x1="30" y1="52" x2="786" y2="52" stroke="none" fill="none"/><path d="M30 60V900" stroke="none" fill="none"/><line x1="0" y1="0" x2="9" y2="9" stroke="#f0f"/>'
  + '<g fill="#fcc"><circle cx="20" cy="20" r="9"/></g>';   // a sloped line and a group are shown
test('a level line or path Chromium never drew under its glow stays hidden when the glow goes (the neon frame lines)', () => {
  const budget = S.simplify(svg(`<defs>${F}</defs>${GLOWING('f')}${'<circle cx="40" cy="40" r="9" fill="#fcc" filter="url(#f)"/>'.repeat(30)}`));
  assert.equal(budget.note, note('shadows and glows', '阴影和发光效果'), budget.reason); assert.ok(budget.svg.includes(HIDDEN), 'the budget\'s filter step');
  const limit = S.simplify(svg(`<defs>${BIG}</defs>${GLOWING('big')}`));
  assert.equal(limit.note, note('oversized shadows and glows', '过大的阴影和发光效果'), limit.reason); assert.ok(limit.svg.includes(HIDDEN), 'the limit\'s step');
  const masked = S.simplify(svg(`<defs><mask id="m"><rect width="9" height="9" fill="#fff"/></mask></defs>${GLOWING('f').replace(/filter="url\(#f\)"/g, 'mask="url(#m)"')}`
    + '<circle cx="40" cy="40" r="9" fill="#fcc" mask="url(#m)"/>'.repeat(60)));
  assert.equal(masked.note, note('masks and clipping', '遮罩和裁剪'), masked.reason); assert.ok(masked.svg.includes(HIDDEN), 'a mask: the same');
  const neon = S.simplify(NEON), level = (l) => l.x1 === l.x2 || l.y1 === l.y2;
  const lines = [...NEON.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*filter=/g)].map((m) => ({ x1: m[1], y1: m[2], x2: m[3], y2: m[4] }));
  assert.equal(lines.filter(level).length, 14, 'the neon draft holds 14 glowing level frame lines');
  for (const l of lines.filter(level)) assert.match(neon.svg, new RegExp(`<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="none"[^>]* fill="none"/>`));
  assert.equal(count(neon.svg, /fill="none"\/>/g), 14, 'and nothing else is hidden');
});

// ── 5. A doubling <use> chain is read once per link, and a tile at most TILE_WALK elements ─────────────────────────────────
// One guard each: 4.8M circles in a tile (read at most TILE_WALK deep); 16.7M circles lent a gradient through a <use> (each link
// read once). A tile read once, and the one work budget that bounds them all: stationery-simplify-share (R13 rounds 3 and 4).
// Without a guard, that budget runs out and the design is refused plain (R13 round 4): what each guard saves keeps a design in it.
const NESTED = svg(`<defs>${DOTS}<g id="grp">${'<rect width="9" height="9"/>'.repeat(40)}</g></defs>`   // 40 lenders, one shared group
  + '<g fill="url(#d)"><use href="#grp"/>'.repeat(40) + '</g>'.repeat(40) + heartsOf('d', 46));
const CHAINS = { cap: svg(`<defs><pattern id="c" width="20" height="20" patternUnits="userSpaceOnUse"><defs>${chain(7, 9)}</defs><use href="#l7"/></pattern></defs>`
  + '<rect width="9" height="9" fill="url(#c)"/>'), lent: svg(`<defs>${LG}${chain(8, 8)}</defs><g fill="url(#lg)"><use href="#l8"/></g>`) };
const timed = (X, d) => { const t0 = performance.now(), r = X.simplify(d); return [r, performance.now() - t0]; }, BOUND = 750;   // ms: <= ~100 here, ~2,300 unbounded
test('a doubling <use> chain is simplified in well under a second: each walk is bounded, each link read once', () => {
  const [r, ms] = timed(S, CHAINS.cap);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  assert.equal(count(r.svg, /<rect width="9" height="9" fill="#c33"\/>/g), 1); assert.ok(ms < BOUND, `cap: ${Math.round(ms)} ms (unbounded: seconds)`);
  const [l, lms] = timed(S, CHAINS.lent);   // the chain itself is the expansion bomb: nothing fits, after every step ran
  assert.deepEqual([l.ok, l.over], [false, true], l.reason); assert.ok(lms < BOUND, `lent: ${Math.round(lms)} ms`);
  assert.equal(S.simplify(NESTED).note, note('pattern fills', '图案填充'), 'each lender reads the shared group once: in the budget');
});

// ── Mutation evidence: each new guard, removed, changes what is drawn or how long it takes ─────────────────────────────────
const M = {
  lent: san('if(s<1&&(x===n||!on||readable(x,o)))', 'if(s<1&&(x===n||!on))'),
  effReadable: san('if(readable(y,o)) return unit(attr(y,o)); } return 1;', 'if(attr(y,o)!=null) return op(attr(y,o)); } return 1;'),
  nearer: san('||s*(b.lent-b.flat)<(1-s)*stuck;', ';'),
  useFlat: san('=>b.lent===b.flat||s*', '=>s*'),
  flatBox: san('use?near(b):bb&&SHAPES[x.name]&&flat(x,X.G)', 'use?near(b):false'),
  flatLender: san(':bb&&flat(n,X.G)))', ':false))'),
  flatAnd: san('return !(g.w>0&&g.h>0);', 'return !(g.w>0||g.h>0);'),
  bbOnly: san("bb=attr(t,kind===2?'gradientUnits':'patternUnits')!=='userSpaceOnUse';", 'bb=true;'),
  drawnOnly: san('for(const k of ks) if(drawn(k)) st.push([k,v,so]);', 'for(const k of ks) st.push([k,v,so]);'),
  useInTile: san('ks=kidsOf(s,X.ids);', 'ks=s.kids;'),
  tileReadable: san('inherits(x)||i>2&&!readable(s,k)?up[i]:x', 'inherits(x)?up[i]:x'),
  clear: san('if(CLEAR.test(c)) return 0;', ''),
  hexAlpha: san('return h?parseInt(h[1]?h[1]+h[1]:h[2],16)/255:f?', 'return f?'),
  fnAlpha: san('f?num(f[1]||f[2],1):1;', '1;'),
  stopAlpha: san("op(attr(k,'stop-opacity'))*alphaOf(attr(k,'stop-color'))", "op(attr(k,'stop-opacity'))"),
  divide: san('Math.min(1,f/alphaOf(c))', 'Math.min(1,f)'),
  width1: san('v[2]==null?1:widthOf(v[2])', 'widthOf(v[2])'),
  hideStep: san("run:(r)=>{ hideFlat(r,'filter',named('filter')); return", 'run:(r)=>{ return'),
  hideMask: san("hideFlat(r,'mask',named('mask')); ", ''),
  hideLimit: san("    hideFlat(root,'filter',(e)=>big.has(e));\n", ''),
  tallyDrawn: san('const go=(x,k,bb,ks,on)=>{ visit(x); if(!drawn(x)) return Z;', 'const go=(x,k,bb,ks,on)=>{ visit(x);'),
  tallyOwnPaint: san("K=inherits(v)?ks:NONE.test(v)?'none':'own'", 'K=ks'),
  hideShapesOnly: san('if(SHAPES[n.name]&&[...String(attr(n,key))', 'if([...String(attr(n,key))'),
  walkCap: san('while(st.length&&left-->0){', 'while(st.length){'),
  tallyMemo: san('if(m.has(x)) return m.get(x);', ''),
};
test('MUTATION: each new guard, removed, is caught', () => {
  const L = (m) => loadStill({ mutate: m }), has = (m, d, s) => L(m).simplify(d).svg.includes(s);
  assert.ok(has(M.lent, LENT, `<rect ${FP} fill-opacity="0.9"/>`), 'lent: the child keeps 90% of a solid #333 (the R13 page)');
  assert.ok(has(M.effReadable, LENT, '<rect width="5" height="5" fill="#333" fill-opacity="0.0113"/>'), 'effReadable: "" read as 1');
  assert.ok(has(M.nearer, LENT, '<use href="#bg" fill="#333" fill-opacity="0.0113"/>'), 'nearer: 90% #333 through the <use>');
  assert.ok(has(M.tallyDrawn, LENT, '<use href="#tg" fill="none"/>'), 'tallyDrawn: a <defs> rect counts as an override');
  assert.ok(has(M.tallyOwnPaint, LENT, '<use href="#mix" fill="none"/>'), 'tallyOwnPaint: the shape painting its own counts');
  assert.ok(has(M.useFlat, RULES, '<use href="#rule" y="300" stroke="#ffd700"/>'), 'useFlat: the rule through <use> turns gold');
  assert.ok(has(M.flatBox, RULES, '<g stroke="#ffd700" stroke-width="4"><line x1="80" y1="600" x2="736" y2="600"/>'), 'flatBox: a lent gold line');
  assert.ok(has(M.flatLender, RULES, '<path d="M100 400H716" stroke="#ffd700"/>'), 'flatLender: a gold line appears');
  assert.ok(has(M.flatAnd, RULES, '<path d="M100 400H716" stroke="#ffd700"/>'), 'flatAnd: only a box flat both ways is flat');
  assert.ok(has(M.bbOnly, RULES, '<line x1="100" y1="700" x2="716" y2="700" stroke="none"/>'), 'bbOnly: a user-space rule is hidden');
  assert.ok(has(M.drawnOnly, TILES, '<rect width="99" height="99" fill="#c33"/>'), 'drawnOnly: the <defs> circle counts too: solid');
  assert.ok(has(M.useInTile, TILES, '<rect width="99" height="99" fill="none"/>'), 'useInTile: the red dots vanish');
  assert.ok(has(M.tileReadable, TILES, '<rect width="94" height="94" fill="#acd"/>'), 'tileReadable: "" read as 1');
  assert.ok(has(M.clear, TILES, '<rect width="98" height="98" fill="transparent"/>'), 'clear: the red circles vanish');
  assert.ok(has(M.hexAlpha, FADES, '<rect width="90" height="90" fill="#cc333333"/>'), 'hexAlpha: 20% #c33 in all');
  assert.ok(has(M.fnAlpha, FADES, '<rect width="93" height="93" fill="rgba(204,51,51,0)"/>'), 'fnAlpha: the fade vanishes');
  assert.ok(has(M.stopAlpha, FADES, '<rect width="94" height="94" fill="transparent"/>'), 'stopAlpha: the fade vanishes');
  assert.ok(has(M.divide, TILES, '<rect width="96" height="96" fill="rgba(0,0,0,0.5)" fill-opacity="0.5"/>'), 'divide: 25%, not 50%');
  const hatch = svg(`<defs><pattern id="h" width="10" height="10" patternUnits="userSpaceOnUse"><line x1="0" y1="10" x2="10" y2="0" stroke="#99a"/></pattern></defs><rect width="98" height="98" fill="url(#h)"/>${heartsOf('h', 46)}`);
  assert.ok(has(M.width1, hatch, '<rect width="98" height="98" fill="none"/>'), 'width1: the hatch disappears');
  assert.ok(has(M.hideStep, svg(`<defs>${F}</defs>${GLOWING('f')}${'<circle cx="40" cy="40" r="9" fill="#fcc" filter="url(#f)"/>'.repeat(30)}`), '<line x1="30" y1="52" x2="786" y2="52" stroke="#f0f"/>'), 'hideStep');
  assert.ok(has(M.hideLimit, svg(`<defs>${BIG}</defs>${GLOWING('big')}`), '<line x1="30" y1="52" x2="786" y2="52" stroke="#f0f"/>'), 'hideLimit');
  assert.ok(has(M.hideShapesOnly, svg(`<defs>${BIG}</defs>${GLOWING('big')}`), '<g fill="none" stroke="none"><circle'), 'hideShapesOnly: the group goes');
  assert.ok(has(M.hideMask, svg(`<defs><mask id="m"><rect width="9" height="9" fill="#fff"/></mask></defs><line x1="30" y1="52" x2="786" y2="52" stroke="#f0f" mask="url(#m)"/>`
    + '<circle cx="40" cy="40" r="9" fill="#fcc" mask="url(#m)"/>'.repeat(60)), '<line x1="30" y1="52" x2="786" y2="52" stroke="#f0f"/>'), 'hideMask');
  assert.equal(L(M.walkCap).simplify(CHAINS.cap, NO_DEADLINE).reason, PLAIN, 'walkCap: one tile of 4.8M circles spends the whole budget');
  assert.equal(L(M.tallyMemo).simplify(NESTED, NO_DEADLINE).reason, PLAIN, 'tallyMemo: each lender reads the shared group again');
});
