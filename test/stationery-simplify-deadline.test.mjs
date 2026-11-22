// simplify()'s deadline · 简化的时间上限 (ADR 0003 amendment 5, R13 round 5)
//
// The R13 round 5 review: the work budget counts units, not time. A charge can be missed (a stale size, fixed in
// stationery-simplify-budget), a unit costs 0.01-0.6 µs by walk, and sanitize()'s re-checks are not metered at all (295 KB
// designs took 162-186 ms in Chromium). So the whole call also has ONE deadline, a backstop: simplify() reads a clock at its
// start ('start'), every TICK charges of the meter ('walk'), and before and after each re-check ('before', 'after'; the first
// check's end is an 'after' too). Past SIMPLIFY_MS the design is refused plain (TOO_COMPLEX, `over`), never part-simplified,
// and a re-check that would end past it (it costs about what the first check took) is not started. Pinned with FAKE clocks
// (no real waits, nothing timed):
//   · past the deadline at each check point, the answer is the plain refusal, and the clock is read no further;
//   · a slow clock (a slower device) refuses a borderline design that a fast one simplifies; a broken clock (NaN) fails closed;
//     a design that passes as it is never meets the deadline;
//   · the deadline is per call; without performance.now() the clock is Date.now(); the studio shows the refusal (R6);
//   · with the REAL clock (the one test that reads it), the real fixtures, as they are and forced through every step, give the
//     answer they give with none, or on a loaded runner the plain refusal; null options never throw (R5).
// The 58 saved real replies give byte-identical output to 4cc9438 with the real clock (ADR 0003, R13 round 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SIMP_HTML, PT, LG, loadStationery, loadStudio, svg, heartsOf, simplifiedNote as note, answerWith as answer,
  replaceOnce as san, TOO_COMPLEX as PLAIN, NO_DEADLINE } from './helpers-stationery.mjs';

const S = loadStationery();
const MS = Number(/\bSIMPLIFY_MS=(\d+),/.exec(SIMP_HTML)[1]);   // the deadline, read from its one source (R3)
// A fake clock: `at(where)` gives the time, and `log` keeps where simplify() read it.
const clock = (at) => { const log = []; return { log, clock: (where) => { log.push(where); return at(where); } }; };
const still = () => clock(() => 0);                                                     // never moves
const pastAt = (where, nth) => { let seen = 0, past = false;                            // far past the deadline from the
  return clock((w) => { if (w === where && ++seen === nth) past = true; return past ? 1e9 : 0; }); };   // nth read at `where` on
const squeeze = (log) => log.filter((x, i) => !(x === 'walk' && log[i - 1] === 'walk')).join(' ');   // a run of walk reads, once
const nthAt = (log, where, nth) => { let seen = 0; return log.findIndex((x) => x === where && ++seen === nth); };
const refused = (r, d) => [r.ok, r.reason, r.svg, r.over, r.cost === S.sanitize(d).cost];
const PLAINLY = [false, PLAIN, undefined, true, true];

// Over the budget for its see-through groups and its dotted hearts: the layers step is kept (still over), then patterns fit.
const LAYERED = svg(`<defs>${PT}</defs>${'<g opacity="0.5"><circle r="9" fill="#fcc" stroke="#000"/></g>'.repeat(40)}${heartsOf('p', 46)}`);
const DONE = note('see-through layers, pattern fills', '半透明图层、图案填充');
const fixture = (f) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', f), 'utf8');
const [FILTERS, REGION] = ['stationery-rejected-filters.svg', 'stationery-rejected-region.svg'].map(fixture);   // real drafts
const POINTS = { layered: [['after', 1, 'the first check ended past it'], ['before', 1, 'the layers re-check would start past it'],
  ['after', 2, 'the layers re-check ended past it'], ['walk', 1, 'the pattern step\'s walk ran past it'],
  ['before', 2, 'the patterns re-check would start past it'], ['after', 3, 'the last re-check ended past it, though it passed']],
  region: [['before', 1, 'the limits re-check would start past it'], ['after', 2, 'the limits re-check ended past it']] };
test('past the deadline at each check point, simplify() refuses plain, there and then', () => {
  for (const [d, points, read, done] of [[LAYERED, POINTS.layered, 'start after before after walk before after', DONE],
    [REGION, POINTS.region, 'start after before after before after', note('shadows and glows', '阴影和发光效果')]]) {
    const control = still(), r = S.simplify(d, control);
    assert.equal(r.note, done, r.reason);                                  // in time: simplified
    assert.equal(squeeze(control.log), read, 'where the clock is read');
    for (const [where, nth, what] of points) {
      const c = pastAt(where, nth);
      assert.deepEqual(refused(S.simplify(d, c), d), PLAINLY, what);
      assert.deepEqual(c.log, control.log.slice(0, nthAt(control.log, where, nth) + 1), `${what}: refused right there, the clock read no further`);
    }
  }
});
test('a re-check that would end past the deadline is not started: it costs about what the first check took', () => {
  const took = (f) => clock((w) => (w === 'start' ? 0 : f * MS));   // the first check took f x the deadline; nothing else takes time
  const late = took(0.6);                                            // 0.6 gone, 0.6 more: past it
  assert.deepEqual(refused(S.simplify(LAYERED, late), LAYERED), PLAINLY); assert.deepEqual(late.log, ['start', 'after', 'before']);
  assert.equal(S.simplify(LAYERED, took(0.4)).note, DONE, '0.4 gone, 0.4 more: in time');
});
const MANY = svg(`<defs>${PT}</defs>${'<rect width="9" height="9" fill="url(#p)"/>'.repeat(2000)}`);   // 2,000 shapes, one tile
test('a slower device refuses a borderline design sooner (fail closed, by design); a broken clock fails closed', () => {
  const reads = (() => { const c = still(); S.simplify(MANY, c); return c.log.length; })();   // what the call reads, in time
  const ticking = (ms) => { let t = 0; return { clock: () => (t += ms) }; };                 // ms pass between reads
  assert.ok(reads > 100, `${reads} reads: the walk reads the clock as it goes`);
  assert.equal(S.simplify(MANY, ticking(MS / reads / 2)).note, note('pattern fills', '图案填充'), 'half the deadline: simplified');
  assert.deepEqual(refused(S.simplify(MANY, ticking(2 * MS / reads)), MANY), PLAINLY, 'twice as slow: refused');
  assert.deepEqual(S.simplify(FILTERS, ticking(2 * MS / reads)), S.simplify(FILTERS, NO_DEADLINE), 'a real draft reads it 4 times: in time');
  assert.deepEqual(refused(S.simplify(MANY, { clock: () => NaN }), MANY), PLAINLY, 'NaN: past it');
  const as = svg('<rect width="9" height="9" fill="#c33"/>');
  assert.equal(S.simplify(as, { clock: () => NaN }).svg, S.sanitize(as).svg, 'a design that passes as it is never meets the deadline');
});
test('the deadline is per call; without performance.now() the clock is Date.now()', () => {
  assert.equal(S.simplify(LAYERED, pastAt('walk', 1)).reason, PLAIN);
  assert.equal(S.simplify(LAYERED, NO_DEADLINE).note, DONE, 'the next call has its own clock');
  let reads = 0; const late = { now: () => (++reads > 3 ? 1e9 : 0) };   // Date.now(), past it from the 4th read
  const dated = (D) => loadStationery({ globals: { performance: undefined, Date: D } });
  assert.equal(dated(late).simplify(LAYERED).reason, PLAIN, 'Date.now() past the deadline: refused');
  assert.equal(reads, 4, 'read 4 times: start, the first check, before the layers re-check, after it');
  assert.equal(dated({ now: () => 0 }).simplify(LAYERED).note, DONE, 'Date.now() standing still: simplified');
});
test('user flow (R6): on a slower device the studio shows an AI draft refused plain, and a small real draft as before', async () => {
  let t = 0; const slow = loadStationery({ globals: { performance: { now: () => (t += 1) } } });   // 1 ms between reads
  assert.deepEqual(await loadStudio(slow).design(answer(MANY), 'x'), { ok: false, convoId: 'c1', reason: PLAIN });
  const r = await loadStudio(slow).design(answer(FILTERS), 'x'), want = S.simplify(FILTERS, NO_DEADLINE);
  assert.deepEqual([r.ok, r.svg, r.note], [true, want.svg, want.note]);
});
// Forced: 200 invisible gradient rects take a draft through the pattern and gradient steps too (the metered walks)
const forced = (d) => d.replace('</svg>', `<defs>${LG}</defs>${'<rect width="816" height="816" fill="url(#lg)" fill-opacity="0"/>'.repeat(200)}</svg>`);
// The one test that reads the real clock: a loaded runner may pass the deadline, and then the answer is the plain refusal
// (fail closed). Either is accepted; anything else fails. Not timed.
const sameOrPlain = (r, want, d) => (r.ok ? assert.deepEqual(r, want) : assert.deepEqual(refused(r, d), PLAINLY));
test('with the REAL clock, the real drafts, as they are and forced through every step, give the answer they give with none, or plain', () => {
  const dated = loadStationery({ globals: { performance: undefined } });   // the real Date.now()
  for (const d of [FILTERS, REGION, forced(FILTERS), forced(REGION)]) {
    const want = S.simplify(d, NO_DEADLINE); assert.equal(want.ok, true, want.reason);
    sameOrPlain(S.simplify(d), want, d); sameOrPlain(dated.simplify(d), want, d);
  }
  assert.throws(() => sameOrPlain({ ok: false, reason: 'x' }, {}, FILTERS), 'a refusal other than the plain one fails');
});
test('simplify() never throws on null options (R5): the clock falls back to the real one', () => {
  assert.equal(S.simplify(FILTERS, null).ok, true);
});

// ── Mutation evidence: each check of the deadline, removed, is caught ───────────────────────────────────────────────────
const jumpy = () => { let n = 0; return { now: () => (n++ ? 1e9 : 0) }; };   // a Date: 0 at the start, then far past the deadline
const M = {
  first: san("const took=w.late('after'),", 'const took=0,'),
  before: san("w.late('before',took); ", ''),
  after: san("const r=sanitize(emit(next,true),o); w.late('after'); return r;", 'return sanitize(emit(next,true),o);'),
  walk: san(" if(++k%TICK===0) late('walk');", ''),
  ahead: san('if(!(t+ahead<=SIMPLIFY_MS)) throw SPENT;', 'if(!(t<=SIMPLIFY_MS)) throw SPENT;'),
  nan: san('if(!(t+ahead<=SIMPLIFY_MS)) throw SPENT;', 'if(t+ahead>SIMPLIFY_MS) throw SPENT;'),
  perCall: san('w=X&&X.meter(o&&o.clock||undefined);', 'w=X&&(X.w||(X.w=X.meter(o&&o.clock||undefined)));'),
  start: san("const t0=now('start');", 'const t0=0;'),
  fallback: san('?()=>performance.now():()=>Date.now();', '?()=>performance.now():()=>0;'),
};
test('MUTATION: each check of the deadline, removed, is caught', () => {
  const L = (m, globals) => loadStationery({ mutate: m, globals }), where = (m) => { const c = still(); L(m).simplify(LAYERED, c); return squeeze(c.log); };
  assert.equal(where(M.first), 'start before after walk before after', 'first: the first check\'s end is not read');
  assert.equal(where(M.before), 'start after after walk after', 'before: no re-check is read before');
  assert.equal(where(M.after), 'start after before walk before', 'after: no re-check is read after');
  assert.equal(where(M.walk), 'start after before after before after', 'walk: the walk never reads it');
  assert.equal(L(M.ahead).simplify(LAYERED, clock((w) => (w === 'start' ? 0 : 0.6 * MS))).note, DONE, 'ahead: a re-check that ends late is started');
  assert.equal(L(M.nan).simplify(MANY, { clock: () => NaN }).ok, true, 'nan: a broken clock never runs out');
  const shared = L(M.perCall); shared.simplify(LAYERED, pastAt('walk', 1));
  assert.equal(shared.simplify(LAYERED, NO_DEADLINE).reason, PLAIN, 'perCall: one clock for the page, past it after the first call');
  assert.equal(L(M.start, { performance: undefined }).simplify(FILTERS).reason, PLAIN, 'start: the epoch read as the call\'s start');
  assert.equal(L(M.fallback, { performance: undefined, Date: jumpy() }).simplify(LAYERED).note, DONE, 'fallback: no clock without performance');
});
