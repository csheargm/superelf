// The model review's email (docs/adr/0020): the answer first, bars the owner can read at a glance on
// an honest scale, Vision "—" for a model that cannot see pictures, the closest challengers in plain
// words, the rest grouped by reason, and an HTML part Gmail shows as sent (tables and inline styles
// only). Pure functions over a fake review built with the real update rule; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideChanges, applyChanges } from '../lib/model-review-pick.mjs';
import { reviewBrief, reviewView, tableCells, VERDICT, UNDO_HOW, NO_VISION, CHALLENGERS } from '../lib/model-review-report.mjs';
import { reviewHtml, barCells, COLORS, QUALITY_MAX } from '../lib/model-review-email.mjs';
import { MODEL_REVIEW_DEFAULTS } from '../lib/model-review-config.mjs';

const S = { ...MODEL_REVIEW_DEFAULTS };
const lane = (id, group, model, provider = 'ollama') => ({ id, label: id.toUpperCase(), group, provider, model });
const LANES = [lane('f1', 'Fast', 'f1:cloud'), lane('f2', 'Fast', 'f2:cloud'), lane('f3', 'Fast', 'f3:cloud'),
  lane('d1', 'Deep', 'd1:cloud'), lane('d2', 'Deep', 'd2:cloud'), lane('d3', 'Deep', 'd3:cloud'), lane('claude', 'Agent', null, 'claude')];
// quality and seconds to first text per group, Vision quality (null = no answer, 0 = could not see the picture)
const st = (fq, ff, dq, df, vision = 4) => ({ quality: { Fast: fq, Deep: dq, Vision: vision }, first: { Fast: ff, Deep: df, Vision: null },
  firstAll: ff, fails: 0, failNotes: [], tested: 9 });
const BASE = { 'f1:cloud': st(4, 1, 3, 1), 'f2:cloud': st(3.5, 1, 3, 1), 'f3:cloud': st(3, 1, 3, 1, 0),
  'd1:cloud': st(3, 5, 4.5, 5), 'd2:cloud': st(3, 5, 4, 5), 'd3:cloud': st(3, 5, 3.5, 5, 0) };
const TESTS = [...['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, group: 'Fast', quick: i < 3 })),
  ...['f', 'g', 'h'].map((id) => ({ id, group: 'Deep', quick: false })), { id: 'v', group: 'Vision', quick: false }];
const COST = { ollama: 141, claude: 9, minutes: 2.5 };

// A review as lib/model-review.mjs conclude() hands it to the report, from the real decideChanges.
function review(newStats, { outcome, round1 = {}, refs = new Set() } = {}) {
  const stats = { ...BASE, ...newStats };
  const newcomers = Object.keys(newStats).map((m) => ({ name: m.replace(/:cloud$/, ''), model: m }));
  const d = decideChanges({ lanes: LANES, stats, newcomers, refs, settings: S });
  const out = outcome || (d.changes.length ? 'applied' : 'none');
  return { outcome: out, why: null, rebuilt: null, changes: d.changes, lanesBefore: LANES,
    lanesAfter: out === 'applied' ? applyChanges(LANES, d.changes) : LANES, stats, models: Object.keys(stats), tests: TESTS,
    round1, notes: d.notes, bars: d.bars, blocked: d.blocked, declined: [], settings: S, cost: COST };
}
const NO_CHANGE = review({ 'n1:cloud': st(3.2, 0.8, 3, 1, 0), 'n2:cloud': st(3.1, 0.9, 3, 1), 'n3:cloud': st(2.5, 1, 2, 1, 0),
  'n4:cloud': st(2, 1, 2, 1, 0), 'n5:cloud': st(1, 2, 1, 2, null) });
const CHANGED = review({ 'star:cloud': st(4.9, 0.6, 3, 1) });
const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

test('verdict first, in one plain line: no change, changed, first review (report only)', () => {
  const none = reviewBrief(NO_CHANGE);
  assert.equal(none.split('\n')[0], `**${VERDICT.none}**`);
  assert.equal(VERDICT.none, 'No change: your current models are still the best fit · 无变化：当前模型仍是最佳');
  assert.match(none.split('\n')[1], /^5 new models tried, 5 reached the full test, none clearly better than yours · /);
  assert.ok(!none.includes(UNDO_HOW), 'nothing changed, nothing to undo');

  const changed = reviewBrief(CHANGED);
  assert.equal(changed.split('\n')[0], `**${VERDICT.applied(1)}**`);
  assert.match(changed, /What changed · 更换 .*:\n- Fast: F3 \(f3:cloud\) -> star \(star:cloud\) — overall \+\d\.\d vs F3: quality 4\.9 vs 3\.0/);
  assert.ok(changed.trimEnd().endsWith(UNDO_HOW), 'how to Undo, when something changed');

  const first = reviewBrief({ ...CHANGED, outcome: 'report', lanesAfter: LANES });
  assert.equal(first.split('\n')[0], `**${VERDICT.report}**`);
  assert.match(first, /Would change · 将更换:\n- Fast: F3/);
  assert.ok(!first.includes(UNDO_HOW));

  for (const [r, verdict] of [[NO_CHANGE, VERDICT.none], [CHANGED, VERDICT.applied(1)], [{ ...CHANGED, outcome: 'report', lanesAfter: LANES }, VERDICT.report]]) {
    const html = visible(reviewHtml(r));
    assert.ok(html.indexOf(verdict) >= 0 && html.indexOf(verdict) < html.indexOf('Fast tasks'), `HTML leads with: ${verdict}`);
    assert.equal(html.includes(UNDO_HOW), r.outcome === 'applied');
  }
});

test('Vision: a model that cannot see pictures shows "—", never 0.0, in the text and the HTML table', () => {
  const v = reviewView(NO_CHANGE);
  const cells = tableCells(v);
  const col = cells[0].indexOf('Vision · 看图');
  const row = (name) => cells.find((c) => c[0].startsWith(name));
  assert.equal(row('F3')[col], NO_VISION, 'scored 0 on the picture');
  assert.equal(row('n5')[col], NO_VISION, 'no answer on the picture');
  assert.equal(row('F1')[col], '4.0', 'a model that sees keeps its score');
  assert.ok(cells.slice(1).every((c) => c[col] !== '0.0'));
  assert.match(reviewBrief(NO_CHANGE), /\| F3 \(f3\) \| Fast \| 3\.0 \| 3\.0 \| — \| 1\.0 \| 0\/8 \|/);
  assert.match(reviewHtml(NO_CHANGE), />—<\/td>/);
});

test('bars: quality on an honest 0-5 scale that starts at 0; speed from 0 s, shorter is better', () => {
  const cell = (w, color) => `<td width="${w}%" height="14" bgcolor="${color}"`;
  assert.equal(QUALITY_MAX, 5);
  const full = barCells(5, 5, COLORS.lane);
  assert.ok(full.includes(cell(100, COLORS.lane)) && !full.includes(COLORS.track), '5.0 fills the bar');
  const half = barCells(2.5, 5, COLORS.new);
  assert.ok(half.includes(cell(50, COLORS.new)) && half.includes(cell(50, COLORS.track)), '2.5 is half, not a zoomed-in sliver');
  for (const none of [0, null]) assert.ok(!barCells(none, 5, COLORS.lane).includes(COLORS.lane) && barCells(none, 5, COLORS.lane).includes(cell(100, COLORS.track)));
  assert.ok(barCells(9, 5, COLORS.lane).includes(cell(100, COLORS.lane)), 'never past the end');
  const html = reviewHtml(NO_CHANGE);
  assert.ok(html.includes(cell(80, COLORS.bar)) || html.includes(cell(80, COLORS.lane)), 'F1 Fast 4.0 of 5 = 80%');
  assert.match(visible(html), /Fast tasks \(5\) · 快速任务 — quality 0-5, higher is better/);
  assert.match(visible(html), /Speed · 速度 — seconds to the first word, shorter is better/);
  assert.match(visible(html), / 0 2\.5 5 /, 'the quality axis is labelled from 0 to 5');
  assert.match(visible(html), / 0 s 2\.5 s 5 s /, 'the slowest model (5 s) sets the speed axis, from 0');
});

test('charts: the group\'s lanes are marked "in use", the one to beat named, newcomers marked "new"', () => {
  const html = visible(reviewHtml(NO_CHANGE));
  assert.match(html, /F3 f3 · in use, the one to beat · 在用，需超过它/);
  assert.match(html, /F1 f1 · in use · 在用/);
  assert.match(html, /n1 new · 新/);
  assert.match(html, /A new model gets in only by beating F3 \(dark bar\), the weakest Fast model a review may replace \(a model another setting uses is never replaced\), by \+0\.5 overall/);
  const fast = html.slice(html.indexOf('Fast tasks'), html.indexOf('Deep tasks'));
  assert.ok(!fast.includes('D1'), 'a Deep lane is not in the Fast comparison');
  const changed = visible(reviewHtml(CHANGED));
  assert.match(changed, /star new, picked for Fast · 新，入选 Fast/);
  assert.match(changed, /F3 f3 · replaced · 换下/);
  assert.match(changed, /by beating F3 \(replaced\), the weakest Fast model a review may replace/, 'a replaced bar is grey, so the caption does not call it dark');
  const both = reviewHtml(review({ 'star:cloud': st(4.9, 0.6, 3, 1), 'nova:cloud': st(2, 1, 4.9, 2) }));
  const fastBoth = both.slice(both.indexOf('Fast tasks'), both.indexOf('Deep tasks'));
  const novaRow = fastBoth.slice(fastBoth.indexOf('>nova<'), fastBoth.indexOf('</tr>', fastBoth.indexOf('>nova<')));
  assert.match(novaRow, /new, picked for Deep · 新，入选 Deep/);
  assert.ok(novaRow.includes(COLORS.new) && !novaRow.includes(COLORS.picked), 'picked for Deep: a plain newcomer in the Fast chart');
});

// Regression (R13 review): last week's Fast bar was glm-5.2, the group's TOP quality bar, because the
// two weaker Fast lanes are used by other settings; the caption called it "your weakest Fast model".
test('charts: the one to beat is "the weakest a review may replace", not "your weakest", when other settings hold the rest', () => {
  const held = review({ 'n1:cloud': st(3.2, 0.8, 3, 1) }, { refs: new Set(['f2', 'f3']) });
  assert.equal(held.bars.Fast.lane.id, 'f1', 'only F1 may be replaced, and it has the top Fast bar (4.0)');
  const fast = visible(reviewHtml(held)).split('Deep tasks')[0];
  assert.match(fast, /by beating F1 \(dark bar\), the weakest Fast model a review may replace \(a model another setting uses is never replaced\), by \+0\.5 overall/);
  assert.match(fast, /新模型需综合超过 F1（深色条，可更换的 Fast 模型中最弱的）\+0\.5 分才能入选/);
  assert.ok(!fast.includes('your weakest'), 'F1 is not the weakest Fast model');
  const add = visible(reviewHtml({ ...NO_CHANGE, bars: { ...NO_CHANGE.bars, Fast: { kind: 'add', lane: LANES[2] } } }));
  assert.match(add, /This group has room: a new model joins by beating F3 \(dark bar\), your weakest Fast model, by \+0\.5 overall/,
    'an addition beats the weakest lane of the whole group, so "your weakest" stays true there');
});

test('closest challengers: at most three, closest first, in plain words with what it needed', () => {
  const v = reviewView(NO_CHANGE);
  assert.equal(v.challengers.length, CHALLENGERS);
  assert.match(v.challengers[0], /^n1 vs F3 on Fast: quality 3\.2 vs 3\.0, first word 0\.8 s vs 1\.0 s — overall \+0\.3, needs \+0\.5 to replace it · 综合 \+0\.3，需 \+0\.5$/);
  assert.match(v.challengers[1], /^n2 vs F3 on Fast/);
  assert.match(v.challengers[2], /^n3 vs F3 on Fast: .* overall -0\.5, needs \+0\.5/);
  assert.deepEqual(v.others, ['2 further behind · 2 个差距更大: n4, n5'], 'the rest: one line, not one per model');
});

test('models not compared are grouped by reason, one line each, with a failure\'s reason', () => {
  const slower = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((n) => [n, { kind: 'slower', why: 'slower than the 6 picked · 第一轮较慢' }]));
  const r = review({ 'n1:cloud': st(3.2, 0.8, 3, 1) }, { round1: { ...slower,
    'clef:27b': { kind: 'failed', why: 'fast-zh-short: Ollama HTTP 400 — clef:27b is a decision model' },
    'gpt-oss:20b': { kind: 'failed', why: 'fast-json-list: not valid JSON' }, late: { kind: 'untested', why: 'not tested: max_calls' } } });
  const v = reviewView(r);
  assert.match(v.context, /^12 new models tried, 1 reached the full test/, 'tried = round 2 + round 1 answered; the untested one is not "tried"');
  assert.deepEqual(v.others, [
    '9 slower in the quick round (the 6 fastest went on) · 9 个在快速轮中较慢（最快的 6 个进入完整测试）: a, b, c, d, e, f, g, h, i',
    '2 failed the quick round · 2 个在快速轮中失败: clef:27b (fast-zh-short: Ollama HTTP 400 — clef:27b is a decision model), gpt-oss:20b (fast-json-list: not valid JSON)',
    '1 not tested (call limit) · 1 个未测试（调用上限）: late']);
  assert.ok(reviewBrief(r).includes(`- ${v.others[0]}`) && visible(reviewHtml(r)).includes(v.others[1]));
});

test('HTML is Gmail-safe: tables and inline styles only, nothing to fetch or run, every name escaped', () => {
  const evil = review({ '<script>x</script>:cloud': st(3, 1, 3, 1) });
  for (const html of [reviewHtml(NO_CHANGE), reviewHtml(CHANGED), reviewHtml(evil)]) {
    assert.ok(!/<script|<svg|<img|<style|<link|<iframe|<object|<form|url\(|javascript:|\son\w+=/i.test(html), 'no script, svg, image, style block, link or handler');
    assert.ok(!/https?:\/\//i.test(html), 'no external URL');
    assert.ok(!/[\p{Extended_Pictographic}]/u.test(html), 'no emojis');
    assert.match(html, /^<!doctype html><html>/);
  }
  assert.match(reviewHtml(evil), /&lt;script&gt;x&lt;\/script&gt;/);
});

test('size: a big review stays far below Gmail\'s 102 KB clip', () => {
  const lanes = Array.from({ length: 12 }, (_, i) => lane(`lane-with-a-long-id-${i}`, i % 2 ? 'Deep' : 'Fast', `some-long-model-name-${i}:cloud`));
  const stats = Object.fromEntries(lanes.map((l) => [l.model, st(4, 1, 4, 2)]));
  const news = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`another-long-newcomer-${i}:cloud`, st(3.5, 1, 3.5, 2)]));
  const d = decideChanges({ lanes, stats: { ...stats, ...news }, newcomers: Object.keys(news).map((m) => ({ name: m, model: m })), refs: new Set(), settings: S });
  const html = reviewHtml({ ...NO_CHANGE, lanesBefore: lanes, lanesAfter: lanes, stats: { ...stats, ...news }, models: [...Object.keys(stats), ...Object.keys(news)],
    notes: d.notes, bars: d.bars, blocked: d.blocked, changes: [] });
  assert.ok(Buffer.byteLength(html) < 80 * 1024, `${Buffer.byteLength(html)} bytes`);
});
