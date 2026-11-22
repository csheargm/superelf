// Where a lent paint's share goes, and a tile read once · 借出颜料的份额 (ADR 0003 amendment 5, R13 round 3)
//
// The R13 round 3 review confirmed three findings in the pattern and gradient steps, each measured in Chromium on 3e852d2:
//   · the share went on the lending <g> or <use>, so a shape below that paints a colour of its own, with no fill-opacity of its
//     own, took it too: a pink circle in a 1% dot-textured group vanished, and a nested lender took the outer share again;
//   · below the lender, an element a <use> also draws elsewhere was written: that instance, painted a plain colour of its own,
//     lost its rule line, or faded;
//   · a bounding-box tile was walked again for each shape of another size: 4,000 rects took 4.4 s (63 ms on d4d257d).
// R13 round 4 added one case to the second: a <use> target drawn by a <use> inside the lender and by one outside it.
// Every expected value below is what Chromium draws (measured: ADR 0003, R13 round 3). Mutation evidence at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FP, LG, loadStill, svg, heartsOf, simplifiedNote as note, countMatches as count, replaceOnce as san, draftFlow,
  useChain as chain, TOO_COMPLEX as PLAIN, NO_DEADLINE } from './helpers-stationery.mjs';
import { SIMPLIFY_BOUND_MS as BOUND } from './helpers-platform.mjs';   // 200 ms here, x CI_TIMING_FACTOR on a shared runner

const S = loadStill();
const DOTS = '<pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.2" fill="#333"/></pattern>';
const HALF = '<pattern id="o" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="10" fill="#acd"/></pattern>';
const BG = `<rect ${FP} fill="#fffaf2"/>`, PAGES = `<rect ${FP} fill="url(#lg)"/>`.repeat(92);   // 92 page gradients: over the budget

// ── 1. A shape painting its own colour below a lender keeps its look; the share goes on what paints the lent server ──────────
const LENDERS = '<g fill="url(#d)"><rect width="99" height="99"/><g fill="#2a6f97"><rect x="300" y="400" width="200" height="200"/></g></g>'
  + '<g fill="url(#d)"><rect width="98" height="98"/><g fill="url(#o)"><rect x="600" y="100" width="100" height="100"/></g></g>'
  + '<g fill="url(#d)"><rect width="9" height="9"/><circle r="5" fill="#f00" fill-opacity="0.9"/></g>';
const ONCE = '<g fill="#333" fill-opacity="0.0113"><rect width="9" height="9"/><circle r="5" fill="#f00" fill-opacity="0.9"/></g>';
const OWN = svg(`<defs>${DOTS}${HALF}<circle id="pink" cx="400" cy="500" r="100" fill="#e91e63"/>`
  + '<g id="both"><rect width="99" height="99"/><circle cx="400" cy="500" r="9" fill="#e91e63"/></g></defs>' + BG
  + `<g fill="url(#d)"><rect ${FP}/><circle cx="400" cy="500" r="100" fill="#e91e63"/><defs><rect width="1" height="1"/></defs></g>${LENDERS}`
  + '<use href="#pink" fill="url(#d)"/><use href="#both" fill="url(#d)"/><use href="#both" fill="url(#o)"/>' + heartsOf('d', 46));
const KEPT = `<g fill="#333"><rect ${FP} fill-opacity="0.0113"/><circle cx="400" cy="500" r="100" fill="#e91e63"/><defs><rect width="1" height="1"/></defs></g>`;
test('a shape painting its own colour below a lender keeps it, whole (the R13 scenario: a pink circle vanished)', () => {
  assert.equal(S.sanitize(OWN).over, true);
  const r = S.simplify(OWN);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  assert.ok(r.svg.includes(KEPT), 'the share on the dotted rect alone; nothing written where nothing is drawn');
  assert.ok(r.svg.includes('<g fill="#333"><rect width="99" height="99" fill-opacity="0.0113"/><g fill="#2a6f97"><rect x="300"'), 'a group of its own colour');
  assert.ok(r.svg.includes('<g fill="#acd" fill-opacity="0.5"><rect x="600"'), 'a nested lender: its own share (a half), not times the outer 1.13%');
  assert.ok(r.svg.includes(ONCE), 'a shape of its own colour at its own opacity is not reached: the share on the group, once');
});
test('through a <use>: none when all it lends to paints its own colour, or when that is nearer; else the colour, no share', () => {
  const r = S.simplify(OWN);
  assert.ok(r.svg.includes('<use href="#pink" fill="none"/>'), 'the pink circle paints its own: the <use> lends to nothing');
  assert.ok(r.svg.includes('<use href="#both" fill="none"/><use href="#both" fill="#acd"/>'),
    'a share kept off the pink: the rect at 1.13% is nearer none; at a half, the colour (the share would fade the pink)');
});

// ── 2. Below the lender, nothing a <use> draws elsewhere is written ─────────────────────────────────────────────────────
const GOLD = '<linearGradient id="gold"><stop offset="0" stop-color="#b8860b"/><stop offset="0.5" stop-color="#ffd700"/><stop offset="1" stop-color="#b8860b"/></linearGradient>';
const PETALS = '<g fill="url(#o)"><path id="petal" d="M400 300C350 200 450 200 400 300Z"/><use href="#petal" transform="rotate(90 400 300)"/>'
  + '<circle cx="400" cy="300" r="12" fill="#fc0"/></g>';
const SHARED = svg(`<defs>${LG}${GOLD}${DOTS}${HALF}</defs>${BG}${PAGES}`
  + '<g stroke="url(#gold)" stroke-width="4"><line id="r" x1="80" y1="200" x2="736" y2="200"/></g><use href="#r" y="100" stroke="#333"/>'
  + '<g fill="url(#d)"><rect id="card" x="100" y="100" width="300" height="200" fill-opacity="0.9"/></g><use href="#card" x="300" y="500" fill="#2a6f97"/>'
  + '<g fill="url(#d)"><rect id="card2" x="100" y="400" width="300" height="200"/><circle cx="600" cy="500" r="50" fill="#e91e63"/></g>'
  + '<use href="#card2" x="300" fill="#2a6f97"/><g fill="url(#o)"><rect id="p" x="500" y="800" width="50" height="50" fill-opacity="0.9"/>'
  + `<g id="w"><use href="#p" x="60"/></g></g><use href="#w" y="100" fill="#00f"/>${PETALS}${heartsOf('d', 46)}`);
const DRAWN = '<g stroke="none" stroke-width="4"><line id="r" x1="80" y1="200" x2="736" y2="200"/></g><use href="#r" y="100" stroke="#333"/>'
  + '<g fill="none"><rect id="card" x="100" y="100" width="300" height="200" fill-opacity="0.9"/></g><use href="#card" x="300" y="500" fill="#2a6f97"/>'
  + '<g fill="none"><rect id="card2" x="100" y="400" width="300" height="200"/><circle cx="600" cy="500" r="50" fill="#e91e63"/></g>'
  + '<use href="#card2" x="300" fill="#2a6f97"/><g fill="#acd" fill-opacity="0.5"><rect id="p" x="500" y="800" width="50" height="50" fill-opacity="0.9"/>'
  + '<g id="w"><use href="#p" x="60"/></g></g><use href="#w" y="100" fill="#00f"/><g fill="#acd"><path id="petal" d="M400 300C350 200 450 200 400 300Z"'
  + ' fill-opacity="0.5"/><use href="#petal" transform="rotate(90 400 300)" fill-opacity="0.5"/><circle cx="400" cy="300" r="12" fill="#fc0"/></g>';
test('an element a <use> also draws keeps its look there: the grey rule and the blue cards stay (the R13 scenario)', () => {
  assert.equal(S.sanitize(SHARED).over, true);
  const r = S.simplify(SHARED);
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills, gradients', '图案填充、渐变'));
  // the rule: all the gold lends to is a level line (none, as Chromium drew it); the cards: what the 1.13% share cannot reach (a
  // card's own 0.9; a card while the share is kept off the pink) is nearer none; at a half, the colour at its own (0.9); the
  // petal is drawn only where it is lent, so it takes the share
  assert.ok(r.svg.includes(DRAWN), r.svg.slice(r.svg.indexOf('<g stroke'), r.svg.indexOf('<path d="M10 30')));
});
// R13 round 4 (minor): a card drawn by a <use> inside the lender AND by one outside it. Only the inner one is lent the dots; the
// outer one paints it blue. So the card is never written: a share on it would fade the blue card to about 1%.
const MIXED = svg(`<defs>${DOTS}</defs>${BG}<g fill="url(#d)"><rect id="c" x="100" y="100" width="300" height="200"/><use href="#c" x="400"/>`
  + '<circle cx="600" cy="600" r="50" fill="#e91e63"/></g><use href="#c" y="500" fill="#2a6f97"/>' + heartsOf('d', 46));
test('a <use> target drawn inside the lender and outside it is never written: the outside blue card stays solid', () => {
  const r = S.simplify(MIXED);
  assert.equal(r.note, note('pattern fills', '图案填充'), r.reason);
  assert.ok(r.svg.includes('<g fill="none"><rect id="c" x="100" y="100" width="300" height="200"/><use href="#c" x="400"/>'
    + '<circle cx="600" cy="600" r="50" fill="#e91e63"/></g><use href="#c" y="500" fill="#2a6f97"/>'), r.svg.slice(0, 600));
});
test('user flow (R6): the studio draws the own-colour draft with its pink circle, and Keep saves exactly that', async (t) => {
  const f = draftFlow(t), said = note('pattern fills', '图案填充');
  await f.reply(OWN);
  assert.deepEqual([f.drawn(), f.say(), f.msg.classList.contains('err')], [true, said, false]);
  f.btn('Keep ·').click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].svg, S.simplify(OWN).svg); assert.ok(f.saved[0].svg.includes(KEPT));
});

// ── 3. A bounding-box tile: its walk read once, each shape scaled to its own size ───────────────────────────────────────────
const SIZES = svg('<defs><pattern id="z" width="0.5" height="0.5"><rect width="20" height="20" fill="#c33" fill-opacity="0.3"/></pattern></defs>'
  + [100, 30, 60].map((w) => `<rect width="${w}" height="${w}" fill="url(#z)"/>`).join('') + heartsOf('z', 46));
test('a bounding-box tile is scaled to each shape: a piece covers its area of the tile, at most all of it', () => {
  const r = S.simplify(SIZES);
  assert.equal(r.note, note('pattern fills', '图案填充'), r.reason);
  // 400 of a 50x50 tile; of a 15x15 tile, all (not 400/225); of a 30x30 tile, 400/900 — each at 0.3
  assert.ok(r.svg.includes('<rect width="100" height="100" fill="#c33" fill-opacity="0.048"/><rect width="30" height="30" fill="#c33" fill-opacity="0.3"/>'
    + '<rect width="60" height="60" fill="#c33" fill-opacity="0.1333"/>'), r.svg.slice(0, 400));
});
// The worst case: the most shapes a design may hold (4,900 of MAX_NODES 5,000), each its own size, painting one tile that
// draws TILE_WALK elements through a <use> chain. ~70 ms; 5.2 s when the tile was walked once per size (now that would spend
// the call's work budget, and the design would be refused: stationery-simplify-budget). Its verdict is read with NO_DEADLINE:
// ~70 ms is half the call's deadline, which a loaded runner could pass (then refused plain, by design).
const HEAVY = svg(`<defs><pattern id="c" width="0.5" height="0.5"><defs>${chain(4, 9)}</defs><use href="#l4"/></pattern></defs>`
  + Array.from({ length: 4900 }, (_, i) => `<rect width="${i + 1}" height="9" fill="url(#c)"/>`).join(''));
const timed = (X, d) => { const t0 = performance.now(), r = X.simplify(d, NO_DEADLINE); return [r, performance.now() - t0]; };
test('4,900 shapes of different sizes painting one heavy bounding-box tile are simplified in well under 200 ms', () => {
  assert.equal(S.sanitize(HEAVY).over, true);
  const runs = [0, 1, 2].map(() => timed(S, HEAVY)), [r] = runs[0], ms = Math.min(...runs.map((x) => x[1]));   // the least of 3: load
  assert.equal(r.ok, true, r.reason); assert.equal(r.note, note('pattern fills', '图案填充'));
  assert.equal(count(r.svg, /<rect width="\d+" height="9" fill="#c33"( fill-opacity="0\.\d+")?\/>/g), 4900); assert.ok(ms < BOUND, `${Math.round(ms)} ms`);
});

// ── Mutation evidence: each new guard, removed, changes what is drawn or how long it takes ─────────────────────────────────
const M = {
  other: san('to=!(b&&b.other);', 'to=true;'),
  otherCount: san("else if(K==='own'&&!O) r.other=1;", ''),
  otherShield: san("else if(K==='own'&&!O) r.other=1;", "else if(K==='own') r.other=1;"),
  ownBelow: san("else if(K==='lent'||!O) for", "else if(K==='lent') for"),
  notOn: san('if(s<1&&(x===n||!on||readable(x,o)))', 'if(s<1&&(x===n||readable(x,o)))'),
  carry: san('st.push([y,to]);', 'st.push([y,on]);'),
  lendDrawn: san('kids=(x)=>x.kids.filter((y)=>drawn(y)&&inherits(attr(y,k)))', 'kids=(x)=>x.kids.filter((y)=>inherits(attr(y,k)))'),
  useStuck: san('stuck=b.other?b.lent:b.own', 'stuck=b.own'),
  sealed: san('if(x!==n&&!(X.users.get(x)||[]).every(alone))', 'if(false)'),
  every: san('!(X.users.get(x)||[]).every(alone)', '!((X.users.get(x)||[]).some(alone)||!(X.users.get(x)||[]).length)'),
  alone: san('return false; } return lent.has(u); };', 'return false; } return false; };'),
  aloneClimb: san('if(!z||X.users.has(z)) return false;', 'if(!z) return false;'),
  stuckAtLender: san("near(b,n.name==='use'?undefined:pass(false))", 'near(b,0)'),
  stuckOn: san('stuck+=on?q.own:q.lent;', 'stuck+=q.own;'),
  clamp: san('const f=AF[i]/A+F[a.length]-F[i];', 'const f=AF[a.length]/A;'),
  search: san('if(a[m]<=A) i=m+1; else j=m;', 'if(a[m]<=A) j=m; else i=m+1;'),
  tileMemo: san('if(X.tiles.has(t)) return X.tiles.get(t);', ''),
};
test('MUTATION: each new guard, removed, is caught', () => {
  const L = (m) => loadStill({ mutate: m }), has = (m, d, s) => L(m).simplify(d).svg.includes(s);
  const faded = `<g fill="#333" fill-opacity="0.0113"><rect ${FP}/><circle cx="400" cy="500" r="100" fill="#e91e63"/>`;
  assert.ok(has(M.other, OWN, faded), 'other: the share on the group, the pink circle fades (the R13 page)');
  assert.ok(has(M.otherCount, OWN, faded), 'otherCount: a shape painting its own colour is not counted');
  assert.ok(has(M.otherShield, OWN, '<g fill="#333"><rect width="9" height="9" fill-opacity="0.0113"/>'), 'otherShield: one write each, not once');
  assert.ok(has(M.ownBelow, OWN, '<g fill="#333" fill-opacity="0.0113"><rect width="99" height="99"/><g fill="#2a6f97">'), 'ownBelow: the blue group fades');
  assert.ok(has(M.notOn, OWN, `<g fill="#333"><rect ${FP}/><circle`), 'notOn: the dotted rect, solid #333');
  assert.ok(has(M.carry, OWN, '<rect width="9" height="9" fill-opacity="0.0001"/><circle r="5"'), 'carry: 1.13% of 1.13%, written twice');
  assert.ok(has(M.lendDrawn, OWN, '<defs fill-opacity="0.0113">'), 'lendDrawn: a <defs> is written');
  assert.ok(has(M.useStuck, OWN, '<use href="#both" fill="#333"/>'), 'useStuck: a solid #333 rect through the <use>');
  assert.ok(has(M.sealed, SHARED, '<rect id="card" x="100" y="100" width="300" height="200" fill-opacity="0.0102"/>'), 'sealed: the blue card fades');
  assert.ok(has(M.sealed, SHARED, '<rect id="p" x="500" y="800" width="50" height="50" fill-opacity="0.45"/>'), 'sealed: the blue square fades');
  assert.ok(has(M.alone, SHARED, '<path id="petal" d="M400 300C350 200 450 200 400 300Z"/>'), 'alone: the petal, solid #acd');
  assert.ok(has(M.every, MIXED, '<rect id="c" x="100" y="100" width="300" height="200" fill-opacity="0.0113"/>'), 'every: the blue card fades');
  assert.ok(has(M.aloneClimb, SHARED, '<rect id="p" x="500" y="800" width="50" height="50" fill-opacity="0.45"/>'), 'aloneClimb');
  assert.ok(has(M.stuckAtLender, SHARED, '<g fill="#333" fill-opacity="0.0113"><rect id="card"'), 'stuckAtLender: a dark card');
  assert.ok(has(M.stuckOn, SHARED, '<g fill="#333"><rect id="card2"'), 'stuckOn: a dark card while the share is kept off the pink');
  assert.ok(has(M.clamp, SIZES, '<rect width="30" height="30" fill="#c33" fill-opacity="0.5333"/>'), 'clamp: more than the tile');
  assert.ok(has(M.search, SIZES, '<rect width="100" height="100" fill="#c33" fill-opacity="0.3"/>'), 'search: every piece read as larger');
  assert.equal(L(M.tileMemo).simplify(HEAVY, NO_DEADLINE).reason, PLAIN, 'tileMemo: walked once per size, the tile spends the whole budget');
});
