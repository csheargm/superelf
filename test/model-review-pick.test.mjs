// The model review's update rule and report (docs/adr/0017), as pure functions: who may replace
// whom, what is never touched, how a round is sized, when a review is due, and what the owner reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, rank, pickRound2, referencedIds, decideChanges, applyChanges, newLane, ROUND2_NEWCOMERS } from '../lib/model-review-pick.mjs';
import { planRounds, reviewDue } from '../lib/model-review.mjs';
import { reviewBrief, UNDO_HOW } from '../lib/model-review-report.mjs';
import { MODEL_REVIEW_DEFAULTS } from '../lib/model-review-config.mjs';
import { DAY_MS } from '../lib/schedule.mjs';

const S = { ...MODEL_REVIEW_DEFAULTS };
const lane = (id, group, model, provider = 'ollama') => ({ id, label: id.toUpperCase(), group, provider, model });
const LANES = [
  lane('f1', 'Fast', 'f1:cloud'), lane('f2', 'Fast', 'f2:cloud'), lane('f3', 'Fast', 'f3:cloud'),
  lane('d1', 'Deep', 'd1:cloud'), lane('d2', 'Deep', 'd2:cloud'), lane('d3', 'Deep', 'd3:cloud'),
  lane('claude', 'Agent', null, 'claude'), lane('gpt', 'Agent', null, 'codex'),
];
// A stats row as summarize builds it: quality and seconds to first text per group, failed answers.
const st = (fq, ff, dq, df, fails = 0) => ({ quality: { Fast: fq, Deep: dq, Vision: null }, first: { Fast: ff, Deep: df, Vision: null },
  firstAll: ff, fails, failNotes: fails ? ['fast-json-list: not valid JSON'] : [], tested: 8 });
const BASE_STATS = { 'f1:cloud': st(4, 1, 3, 1), 'f2:cloud': st(3.5, 1, 3, 1), 'f3:cloud': st(3, 1, 3, 1),
  'd1:cloud': st(3, 5, 4.5, 5), 'd2:cloud': st(3, 5, 4, 5), 'd3:cloud': st(3, 5, 3.5, 5) };
const NONE = new Set();

test('summarize: a failed answer counts 0, Vision failures are reported but are not "fails"', () => {
  const tests = [{ id: 'f', group: 'Fast' }, { id: 'g', group: 'Fast' }, { id: 'v', group: 'Vision' }];
  const results = [{ model: 'm', test: 'f', fail: null, firstTextMs: 1000 }, { model: 'm', test: 'g', fail: 'empty answer', firstTextMs: null },
    { model: 'm', test: 'v', fail: 'not the meal JSON the app parses', firstTextMs: 300 }];
  const s = summarize({ models: ['m'], tests, results, scores: { f: { m: 4 } } })['m'];
  assert.equal(s.quality.Fast, 2, '(4 + 0) / 2');
  assert.equal(s.quality.Vision, 0);
  assert.equal(s.fails, 1);
  assert.equal(s.first.Fast, 1);
  assert.equal(rank(s, 'Fast'), 2 - 0.3 * 1);
  assert.equal(rank(s, 'Deep'), -Infinity, 'no Deep evidence ranks last, never first');
});

test('round 1 → round 2: failures out with the reason, the fastest clean newcomers in, at most the limit', () => {
  const newcomers = ['a', 'b', 'c', 'x'].map((n) => ({ name: n, model: `${n}:cloud` }));
  const r = (m, ms, fail = null) => ({ model: m, test: 't', firstTextMs: ms, fail });
  const { picked, dropped } = pickRound2({ newcomers, limit: 2,
    results: [r('a:cloud', 900), r('b:cloud', 300), r('c:cloud', 500), r('x:cloud', 100, 'not valid JSON')] });
  assert.deepEqual(picked.map((n) => n.name), ['b', 'c']);
  assert.deepEqual(dropped.x, { kind: 'failed', why: 't: not valid JSON' });
  assert.equal(dropped.a.kind, 'slower');
  assert.match(dropped.a.why, /slower than the 2 picked/);
});

test('references: derived defaults, the first (default) lane and job-pinned models are never removable', () => {
  const cfg = { health_llm: 'f2', research: { llm: 'f2' }, assess_models: ['d1', 'claude'], vision_default: 'glmflash', one_shot_model: 'claude' };
  assert.deepEqual([...referencedIds(cfg, LANES, ['d2'])].sort(), ['claude', 'd1', 'd2', 'f1', 'f2', 'glmflash']);
});

test('a newcomer clearly better replaces the weakest REMOVABLE lane, in place', () => {
  const stats = { ...BASE_STATS, 'new:cloud': st(4.5, 0.8, 3, 1) };
  const refs = new Set(['f3']);   // the weakest Fast lane is referenced, so the next weakest goes
  const { changes } = decideChanges({ lanes: LANES, stats, newcomers: [{ name: 'new', model: 'new:cloud' }], refs, settings: S });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].out.id, 'f2');
  assert.deepEqual(changes[0].in, { id: 'new', label: 'new', group: 'Fast', provider: 'ollama', model: 'new:cloud' });
  const next = applyChanges(LANES, changes);
  assert.deepEqual(next.map((l) => l.id), ['f1', 'new', 'f3', 'd1', 'd2', 'd3', 'claude', 'gpt'], 'same place, same length');
  assert.deepEqual(next.slice(-2), LANES.slice(-2), 'Claude and Codex are never touched');
});

test('not clearly better, much slower, or one failed answer: no change, and the reason is kept', () => {
  const run = (s) => decideChanges({ lanes: LANES, stats: { ...BASE_STATS, 'n:cloud': s }, newcomers: [{ name: 'n', model: 'n:cloud' }], refs: NONE, settings: S });
  const small = run(st(3.3, 1, 3, 1));
  assert.equal(small.changes.length, 0);
  assert.equal(small.notes.n.code, 'margin');
  assert.match(small.notes.n.why, /not clearly better/);
  assert.equal(small.notes.n.bar.id, 'f3', 'the lane it had to beat');
  const slow = run(st(5, 1.6, 3, 5));
  assert.equal(slow.changes.length, 0, `5.0 quality but 1.6 s vs 1 s: ${slow.notes.n}`);
  assert.equal(slow.notes.n.code, 'slow');
  assert.match(slow.notes.n.why, /to first text/);
  const failed = run(st(5, 0.5, 5, 0.5, 1));
  assert.equal(failed.changes.length, 0);
  assert.equal(failed.notes.n.code, 'fail');
  assert.match(failed.notes.n.why, /round 2: fast-json-list/);
});

test('one model sits in one group; each group changes at most once; the better newcomer wins', () => {
  // a leads both groups (Fast by more), b only Deep, c only Fast: a takes Fast, b takes Deep, c waits.
  const stats = { ...BASE_STATS, 'a:cloud': st(4.6, 0.8, 4.9, 4), 'b:cloud': st(3, 1, 4.8, 4), 'c:cloud': st(4.2, 0.9, 3, 5) };
  const newcomers = ['a', 'b', 'c'].map((n) => ({ name: n, model: `${n}:cloud` }));
  const { changes, notes } = decideChanges({ lanes: LANES, stats, newcomers, refs: NONE, settings: S });
  assert.deepEqual(changes.map((c) => [c.group, c.in.model]).sort(), [['Deep', 'b:cloud'], ['Fast', 'a:cloud']]);
  const alone = decideChanges({ lanes: LANES, stats, newcomers: newcomers.filter((n) => n.name !== 'b'), refs: NONE, settings: S });
  assert.deepEqual(alone.changes.map((c) => [c.group, c.in.model]).sort(), [['Deep', 'a:cloud'], ['Fast', 'c:cloud']],
    'without b, a moves to Deep so that c can take Fast: two changes beat one');
  assert.equal(notes.c.code, 'lost');
  assert.match(notes.c.why, /another newcomer ranked higher/);
});

test('a group below three takes an addition; a group whose lanes are all referenced cannot change; never empty', () => {
  const two = LANES.filter((l) => l.id !== 'f3');
  const stats = { ...BASE_STATS, 'n:cloud': st(4.8, 0.7, 3, 1) };
  const add = decideChanges({ lanes: two, stats, newcomers: [{ name: 'n', model: 'n:cloud' }], refs: NONE, settings: S });
  assert.equal(add.changes[0].kind, 'add');
  assert.deepEqual(applyChanges(two, add.changes).map((l) => l.id).slice(0, 3), ['f1', 'f2', 'n'], 'after the last Fast lane');
  const locked = decideChanges({ lanes: LANES, stats, newcomers: [{ name: 'n', model: 'n:cloud' }], refs: new Set(['f1', 'f2', 'f3']), settings: S });
  assert.equal(locked.changes.filter((c) => c.group === 'Fast').length, 0);
  assert.match(locked.blocked.Fast, /used by another setting/);
  const noDeep = LANES.filter((l) => l.group !== 'Deep');
  assert.match(decideChanges({ lanes: noDeep, stats, newcomers: [], refs: NONE, settings: S }).blocked.Deep, /no Deep lane/);
});

test('new lane ids: a lowercase slug, unique, never a reserved device name', () => {
  const taken = new Set(['minimax-m3']);
  assert.equal(newLane('MiniMax-M3', 'Fast', taken).id, 'minimax-m3-2');
  assert.equal(newLane('gpt-oss:120b', 'Deep', taken).id, 'gpt-oss-120b');
  assert.equal(newLane('gpt-oss:120b', 'Deep', taken).model, 'gpt-oss:120b-cloud');
  assert.equal(newLane('con', 'Fast', taken).id, 'm-con');
});

test('round sizes fit max_calls: newcomers are cut first, the current lanes never', () => {
  const p = { laneCount: 6, quick: 3, rest: 6 };
  assert.equal(planRounds({ ...p, newcomerCount: 15, maxCalls: 200 }), 15, `(6+15)x3 + (6+${ROUND2_NEWCOMERS})x6 = 135`);
  assert.equal(planRounds({ ...p, newcomerCount: 15, maxCalls: 100 }), 5, '6 newcomers need 108 calls; 5 need (6+5)x3 + (6+5)x6 = 99');
  assert.throws(() => planRounds({ ...p, newcomerCount: 3, maxCalls: 50 }), /cannot test the 6 current lanes \(54 calls\)/);
});

test('due: never reviewed; whole days since the last; or a catalog name the last review did not see', () => {
  const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();
  const state = { reviewedAt: at(10, 3), catalogSeen: ['a', 'b'] };
  assert.equal(reviewDue({ state: { reviewedAt: 0, catalogSeen: [] }, catalog: [], settings: S, now: at(10, 3) }), true);
  assert.equal(reviewDue({ state, catalog: ['a', 'b'], settings: S, now: at(16, 23) }), false, 'six days on');
  assert.equal(reviewDue({ state, catalog: ['a', 'b'], settings: S, now: at(17, 2) }), true, 'seven calendar days, even before 03:00');
  assert.equal(reviewDue({ state, catalog: ['a', 'b', 'c'], settings: S, now: at(11, 3) }), true, 'a new catalog model');
  assert.ok(DAY_MS > 0);
});

test('the report text: verdict first, each change and why in one line, a table, the test, cost, and how to Undo', () => {
  const stats = { ...BASE_STATS, 'new:cloud': st(4.5, 0.8, 3, 1) };
  const { changes, notes, blocked, bars } = decideChanges({ lanes: LANES, stats, newcomers: [{ name: 'new', model: 'new:cloud' }], refs: NONE, settings: S });
  const r = { outcome: 'applied', changes, lanesBefore: LANES, lanesAfter: applyChanges(LANES, changes), stats, models: Object.keys(stats),
    tests: [{ group: 'Fast', quick: true }, { group: 'Deep' }, { group: 'Vision' }], round1: { old: { kind: 'failed', why: 'x: Ollama HTTP 400 — \u0007weird\nline' } },
    notes, bars, blocked, declined: ['undone-one'], settings: S, cost: { ollama: 87, claude: 9, minutes: 14.24 } };
  const body = reviewBrief(r);
  assert.equal(body.split('\n')[0], '**Changed: 1 new model in your chooser · 已更换：选择器换入 1 个新模型**', 'the answer leads');
  assert.match(body, /- Fast: F3 \(f3:cloud\) -> new \(new:cloud\) — overall \+1\.6 vs F3: quality 4\.5 vs 3\.0, first word 0\.8 s vs 1\.0 s/);
  assert.match(body, /\| new \| new · 新 -> Fast \| 4\.5 \| 3\.0 \| — \| 0\.8 \| 0\/2 \|/);
  assert.match(body, /\| F3 \(f3\) \| Fast -> out · 换下 \|/);
  assert.match(body, /The test · 测试: 3 made-up tasks \(2 text, 1 picture\), graded blind by Claude 0-5; a failed answer scores 0/);
  assert.match(body, /Cost · 成本: 87 Ollama calls, 0 agent calls, 9 Claude grading calls, 14\.2 minutes/);
  assert.ok(body.trimEnd().endsWith(UNDO_HOW), 'Undo closes the report');
  assert.match(body, /- 1 failed the quick round · 1 个在快速轮中失败: old \(x: Ollama HTTP 400 — weird line\)/, 'remote text is flattened and stripped');
  assert.match(body, /Not tried again \(taken back by Undo\) · 已撤销，不再推荐: undone-one/);
  assert.ok(!/[\p{Extended_Pictographic}]/u.test(body), 'no emojis');
  const first = reviewBrief({ ...r, outcome: 'report', lanesAfter: LANES });
  assert.match(first.split('\n')[0], /First review: report only, nothing changed/);
  assert.match(first, /Would change · 将更换:\n- Fast: F3/);
  assert.ok(!first.includes(UNDO_HOW), 'nothing changed, so nothing to undo');
});
