// Values named after Object.prototype · 原型上的名字 (ADR 0003, Follow-up — prototype lookups)
//
// A lookup in a plain {…} literal finds Object.prototype's members, so 'constructor', 'toString',
// 'valueOf', '__proto__' and the rest each pass a membership check. Every table in the stationery code
// that is looked up by a file's, a notebook's or an SVG's own text has NO prototype. Pinned here:
//   · gate 1, a My-templates file's audience (AUDIENCES), through the host's checked read;
//   · gate 2, a notebook reference's source (REG), at every entry PANote calls;
//   · the invariant: no plain-object table is indexed with [ ] or tested with `in`, in any stationery
//     source (the scan is helpers-proto's plainIndexed).
// Each is mutation-tested: the old plain literal is put back and the same value gets through.
// Elsewhere: PANote's own gate (the notebook's stationery.source) in test/stationery-panote.test.mjs;
// the sanitizer's SHAPED and ENT in test/stationery-sanitize-attrs.test.mjs; the same invariant over
// ALL of note-ui, STATIONERY_SRC included, in test/note-proto-gates.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadStationery, recordingCtx, svg } from './helpers-stationery.mjs';
import { PROTO_KEYS, plainIndexed, plainAgain } from './helpers-proto.mjs';
import { codeOnly } from './helpers-code.mjs';

// [as shipped, the plain literal it replaced]: a mutation puts the literal back.
const AUDIENCES = ['Object.assign(Object.create(null),{spouse:1,teen:1,any:1})', '{spouse:1,teen:1,any:1}'];
const REG = ['Object.assign(Object.create(null),{bundled:new Map(),mine:new Map(),picture:new Map()})',
  '{bundled:new Map(),mine:new Map(),picture:new Map()}'];
const putBack = ([shipped, literal]) => (s) => s.replace(shipped, literal);

test('the keys include the four named in the bug report', () => {
  for (const k of ['constructor', 'toString', 'valueOf', '__proto__']) assert.ok(PROTO_KEYS.includes(k), k);
});

// ── Gate 1: a My-templates file's audience, read through the host's checked read (the user flow) ──
const file = (id, audience) => ({ id, name: id, group: 'stationery', audience, dark: false, lines: null,
  safe: { x: 80, y: 100, w: 656, h: 860 }, svg: svg('<rect width="9" height="9"/>') });
// One file per audience (t0, t1, …), all listed in the index, each read back from JSON as from disk.
function loadMine(S, audiences) {
  const files = { 'templates/index.json': { v: 1, ids: audiences.map((_, i) => `t${i}`) } };
  audiences.forEach((a, i) => { files[`templates/t${i}.json`] = file(`t${i}`, a); });
  const read = async (p) => (p in files ? { status: 'loaded', data: JSON.parse(JSON.stringify(files[p])) } : { status: 'absent', data: null });
  return S.store({ read, write: async () => ({ ok: true }) }).loadMine();
}
test('a My-templates file whose audience is an Object.prototype name is rejected; a real audience loads', async () => {
  const S = loadStationery();
  const r = await loadMine(S, ['any', ...PROTO_KEYS]);
  assert.equal(r.ok, false);
  PROTO_KEYS.forEach((k, i) => assert.match(r.error, new RegExp(`\\bt${i + 1}: bad audience`), `audience '${k}' is reported`));
  assert.deepEqual(S.list().map((t) => t.id), ['t0'], 'only the file with a real audience loads');
});
test('mutation: with the old AUDIENCES literal, every one of those files loads', async () => {
  const M = loadStationery({ mutate: putBack(AUDIENCES) });
  const r = await loadMine(M, PROTO_KEYS);
  assert.ok(r.ok, r.error);
  assert.deepEqual(M.list().map((t) => t.audience), PROTO_KEYS);
});
test('an audience must be a string: ["any"] is rejected; mutation: without the check it loads', async () => {
  const S = loadStationery();
  assert.match((await loadMine(S, [['any']])).error, /\bt0: bad audience/);
  const M = loadStationery({ mutate: (s) => s.replace("typeof t.audience!=='string'||", '') });
  assert.ok((await loadMine(M, [['any']])).ok, 'mutant: the lookup turns ["any"] into "any"');
});

// ── Gate 2: a notebook reference's source, at every entry PANote calls with NB.stationery ──────
const ENTRY = {
  has: (S, ref) => S.has(ref),
  paint: (S, ref) => S.paint(recordingCtx(), ref, { w: 816, h: 1056 }),
  inset: (S, ref) => S.inset({ style: {} }, ref, 408),
  prime: (S, ref) => S.prime(ref, 50),
};
test('a reference whose source is an Object.prototype name is plain paper at every entry, never a throw', async () => {
  const S = loadStationery();
  for (const source of PROTO_KEYS) for (const [name, call] of Object.entries(ENTRY)) {
    assert.equal(await call(S, { id: 'x', source }), false, `${name}({source:'${source}'})`);
  }
});
test('mutation: with the old REG literal, every entry throws a TypeError for every such source', async () => {
  const M = loadStationery({ mutate: putBack(REG) });
  for (const source of PROTO_KEYS) for (const [name, call] of Object.entries(ENTRY)) {
    await assert.rejects(async () => call(M, { id: 'x', source }), TypeError, `${name}({source:'${source}'})`);
  }
});

// ── The invariant, over EVERY stationery source ────────────────────────────────────────────────
// It also covers the render-cost budget's EFFECT, RESOURCE, SERVER, SHAPES, GROUPS, ARGS, CROSS and LINES
// (stationery-cost and its readers, stationery-geometry). The first five are keyed by an element name that
// ELEMENTS has admitted, and the last three by one path-command letter, so no input reaches them with a prototype name and they have no
// prototype-key mutation. The invariant keeps them prototype-free.
const SOURCES = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'web')).filter((f) => /^stationery-.+\.inline\.html$/.test(f))
  .map((f) => [f, codeOnly(fs.readFileSync(path.join(ROOT, 'web', f), 'utf8'))]));
test('the scan finds each shape a plain table can take, and passes a prototype-free one', () => {
  const src = 'const a=1, T={x:1}; const U=Object.assign({},{x:1}); let V={}; const N=Object.assign(Object.create(null),{x:1});'
    + ' const W=Object.fromEntries([]), r={pages:{}}; o.cache={}; const arr={}; const F=Object.create(null);'
    + ' T[k]; U[k]; if(k in V) N[k]; W[k]; r.pages[id]; o.cache[p]; arr[0]; F[k]; for(const q in F);';
  assert.deepEqual(plainIndexed(src), ['T', 'U', 'V', 'W', 'pages', 'cache']);
  assert.deepEqual(plainIndexed('let m={}; for(const k in m);'), ['m'], 'a for…in is a lookup too');
  // The shapes R13 round 1 found missed: a path after `in`, `?.[`, a space before `[`, parentheses,
  // Object.assign with a filled first argument, and a spread.
  const more = 'const o={p:{}}; for(const id in now.p); const A={a:1}; A?.[k]; const B={a:1}; B [k]; const C=({a:1}); C[k];'
    + ' const D=Object.assign({a:1},y); D[k]; const E={...z}; E[k]; const G={}; if(id in this.G);';
  assert.deepEqual(plainIndexed(more), ['p', 'A', 'B', 'C', 'D', 'E', 'G']);
  // Rounds 2 to 4: a logical default after any simple left side or with its operator on the next
  // line, a compound assignment, a space before `(`, nested parentheses, Reflect.get/has (a space
  // before `(` too), and `in` before a parenthesised name.
  const round2 = 'const H=x||{}; H[k]; const I=x??{}; I[k]; const J=y&&{q:1}; J[k]; let K; K||={}; K[k]; let L; L??={}; L[k];'
    + ' const M=Object.assign ({a:1},x); M[k]; const O=( ({a:1})); O[k]; const P={}; Reflect.get(P,k); const Q={}; Reflect.has(Q,k);'
    + ' const R={}; if(k in (R)); let S; S&&={}; S[k]; const U=(x||{}); U[k]; const V=(x)||{}; V[k]; const W=f()||{}; W[k];'
    + ' const X=a[0]||{}; X[k]; const Y=a||b||{}; Y[k]; const Z=a?.b||{}; Z[k]; const a1=1, b1=x||{}; b1[k];'
    + ' const c1=x\n  ||{}; c1[k]; const d1={}; if(k in(d1)); const e1={}; Reflect.get (e1,k);';
  assert.deepEqual(plainIndexed(round2), ['H', 'I', 'J', 'K', 'L', 'M', 'O', 'P', 'Q', 'R', 'S', 'U', 'V', 'W', 'X', 'Y', 'Z', 'b1',
    'c1', 'd1', 'e1']);
  // The stated limits, pinned so the helper's comment cannot drift from what the scan does.
  for (const missed of ['const T=c?{a:1}:{b:1}; T[k];', 'const T=f(a,b)||{}; T[k];', 'const T=(x===y)||{}; T[k];',
    'const T=a>b||{}; T[k];', 'const T=a<b||{}; T[k];', 'const T=f({})||{}; T[k];', 'const T={}; const t=T; t[k];', 'const T=new Object(); T[k];', 'const T=make(); T[k];',
    'const T={}; const {[k]:v}=T;']) assert.deepEqual(plainIndexed(missed), [], `missed: ${missed}`);
  for (const [alarm, name] of [['function f(){ const t={}; } function g(t){ t[k]; }', 't'], ['const f=({a})=>a; f[k];', 'f'],
    ['outer:{ } outer[k];', 'outer'], ["switch(x){ case y: {} } y[k];", 'y'], ['const z=c?w:{}; w[k];', 'w'],
    ['const T=make(x||{}); T[k];', 'T'], ['const keys=Object.keys(o||{}); keys[i];', 'keys'], ['const v=(o||{}).p; v[id];', 'v'],
    ['let v={a:1}; s="x in v";', 'v']]) assert.deepEqual(plainIndexed(alarm), [name], `false alarm: ${alarm}`);
});
test('invariant: no plain-object table is indexed with [ ] or tested with `in` in the stationery code', () => {
  assert.ok(Object.keys(SOURCES).length >= 5, 'every source was read');
  for (const [name, src] of Object.entries(SOURCES)) assert.deepEqual(plainIndexed(src), [], name);
});
test('mutation: with every prototype-free table turned back into a plain object, the invariant names each one', () => {
  for (const shape of ['literal', 'assign']) {
    const named = Object.fromEntries(Object.entries(SOURCES).map(([f, src]) => [f, plainIndexed(plainAgain(src, shape))]).filter(([, n]) => n.length));
    assert.deepEqual(named, {
      'stationery-ui.inline.html': ['AUDIENCES', 'REG'],
      'stationery-sanitize.inline.html': ['SHAPED', 'ENT'],
      'stationery-cost.inline.html': ['EFFECT', 'RESOURCE', 'SERVER', 'SHAPES', 'GROUPS'],
      'stationery-geometry.inline.html': ['ARGS', 'CROSS', 'LINES'],
    }, shape);
  }
});
