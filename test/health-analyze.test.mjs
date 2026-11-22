import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeHealth, buildSuggestionPrompt, renderBriefing, healthBriefBody } from '../lib/health-analyze.mjs';
import { ingestHealth } from '../lib/health.mjs';

const NOW = new Date(2026, 7, 30, 12);   // local 2026-08-30 — all rows built relative to this
const THRESH = { steps_min_daily: 5000, sleep_min_minutes: 360, weight_delta_kg_7d: 1.5 };
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const mkUser = () => ({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'hanalyze-')), id: 'owner' });

// Synthetic 30-day series. Steps is CUMULATIVE, so its windows END YESTERDAY
// (offset 0 = a partial today, always excluded): offsets 1-7 → 6000, 8-14 →
// 8000, older → 7500, today a partial 1500 that must never enter a window.
// Sleep 400 min on even offsets only; weight drifts 71.0 → 70.42 (0.02/day).
function synthRows({ noRecentSleep = false } = {}) {
  const rows = [];
  for (let n = 29; n >= 0; n--) {
    const r = { date: day(n), steps: n === 0 ? 1500 : (n <= 7 ? 6000 : (n <= 14 ? 8000 : 7500)) };
    if (n % 2 === 0 && !(noRecentSleep && n < 7)) r.sleepMinutes = 400;
    r.weight = Math.round((71.0 - (29 - n) * 0.02) * 100) / 100;
    rows.push(r);
  }
  return rows;
}

test('trends: 7d/30d mean+median, delta vs prior window — exact numbers', () => {
  const a = analyzeHealth(synthRows(), { thresholds: THRESH, now: NOW });
  assert.equal(a.metrics.steps.d7.mean, 6000, 'offsets 1-7 — the partial today (1500) is excluded');
  assert.equal(a.metrics.steps.d7.median, 6000);
  assert.equal(a.metrics.steps.d7.present, 7);
  assert.equal(a.metrics.steps.d7.expected, 7, 'expected derived from the window range');
  assert.equal(a.metrics.steps.prior7.mean, 8000, 'offsets 8-14');
  assert.equal(a.metrics.steps.deltaPct, -25, '(6000-8000)/8000');
  assert.equal(a.metrics.steps.d30.mean, Math.round(((7 * 6000 + 7 * 8000 + 15 * 7500) / 29) * 10) / 10);
  assert.equal(a.metrics.steps.d30.present, 29, 'offsets 1-29 (rows stop at 29)');
  assert.equal(a.metrics.steps.d30.expected, 30);
  assert.equal(a.metrics.sleep.d7.present, 4, 'even offsets 0,2,4,6 — sleep windows still include today (complete by morning)');
  assert.equal(a.metrics.sleep.d7.mean, 400);
  assert.equal(a.metrics.weight.d7.present, 7);
});

test('R14 gaps: a metric absent this week is REPORTED missing, never guessed', () => {
  const a = analyzeHealth(synthRows({ noRecentSleep: true }), { thresholds: THRESH, now: NOW });
  assert.equal(a.metrics.sleep.d7.present, 0);
  assert.ok(a.gaps.some((g) => /no sleep data this week/.test(g) && /本周无睡眠数据/.test(g)));
  assert.ok(!a.flags.some((f) => f.metric === 'sleep'), 'no data → gap, NOT a threshold flag');
  const brief = renderBriefing(a, '- suggestion 建议');
  assert.match(brief, /no sleep data this week · 本周无睡眠数据/);
});

test('threshold flags fire with exact numbers; quiet when healthy', () => {
  const low = synthRows().map((r) => ({ ...r, steps: r.steps - 2000, sleepMinutes: r.sleepMinutes ? 300 : undefined }));
  const a = analyzeHealth(low, { thresholds: THRESH, now: NOW });
  const stepFlag = a.flags.find((f) => f.metric === 'steps');
  assert.equal(stepFlag.value, 4000);
  assert.equal(stepFlag.threshold, 5000);
  assert.match(stepFlag.text, /4000/);
  assert.ok(a.flags.find((f) => f.metric === 'sleep'));
  const healthy = analyzeHealth(synthRows(), { thresholds: THRESH, now: NOW });
  assert.deepEqual(healthy.flags, [], 'no breach → no flags');
});

test('weight-delta flag uses first→last of the 7d window', () => {
  const rows = synthRows().map((r, i, all) => ({ ...r, weight: i === all.length - 1 ? r.weight + 2.5 : r.weight }));
  const a = analyzeHealth(rows, { thresholds: THRESH, now: NOW });
  const f = a.flags.find((x) => x.metric === 'weight');
  assert.ok(f, 'a 2.5 kg jump in-window must flag');
  assert.match(f.text, /kg/);
});

test('correlations: reported only with n>=10 and always with n', () => {
  const a = analyzeHealth(synthRows(), { thresholds: THRESH, now: NOW });
  assert.equal(a.correlations[0].n, 14, 'even-offset paired days in the 30-day window ending YESTERDAY (2..28)');
  assert.equal(typeof a.correlations[0].r, 'number');
  assert.match(a.correlations[0].note, /not causation/);
  const few = synthRows().map((r, i) => (i < 25 ? { date: r.date, steps: r.steps } : r));  // only 3 paired days left
  const b = analyzeHealth(few, { thresholds: THRESH, now: NOW });
  assert.equal(b.correlations[0].r, undefined, 'no r below n=10');
  assert.match(b.correlations[0].note, /n=\d+ < 10/);
});

test('LLM prompt carries AGGREGATES ONLY — no per-day rows, no sample timestamps', () => {
  const rows = synthRows();
  const a = analyzeHealth(rows, { thresholds: THRESH, now: NOW });
  const prompt = buildSuggestionPrompt(a);
  for (const r of rows) assert.ok(!prompt.includes(r.date), `raw day ${r.date} leaked into the prompt`);
  assert.ok(!prompt.includes('"ts"') && !prompt.includes('"date"'), 'no sample/date fields');
  assert.match(prompt, /6000/, 'computed aggregate present');
  assert.match(prompt, /never invent/, 'no-invented-numbers rule stated');
});

test('healthBriefBody: mocked LLM → bilingual digest from aggregates; prompt inspected', async () => {
  const u = mkUser();
  const rows = synthRows();
  for (const r of rows) ingestHealth(u, { date: r.date, ...r });
  let seenPrompt = '';
  const out = await healthBriefBody(u, { llm: async (p) => { seenPrompt = p; return '- walk after dinner 饭后散步 (steps 6000 < prior 8000)'; },
    thresholds: THRESH, now: NOW, manual: false });
  assert.match(out.body, /健康简报/);
  assert.match(out.body, /7d avg 6000/);
  assert.match(out.body, /饭后散步/);
  assert.match(out.body, /not medical advice/);
  for (const r of rows) assert.ok(!seenPrompt.includes(r.date), 'no raw day left the machine boundary');
});

test('R14: failed or empty LLM pass → NO briefing (throws, never an empty all-good)', async () => {
  const u = mkUser();
  for (const r of synthRows()) ingestHealth(u, { date: r.date, ...r });
  await assert.rejects(() => healthBriefBody(u, { llm: async () => { throw new Error('lane down'); }, thresholds: THRESH, now: NOW }),
    /no briefing produced/);
  await assert.rejects(() => healthBriefBody(u, { llm: async () => '   ', thresholds: THRESH, now: NOW }),
    /empty/);
});

test('empty store: explicit "no data yet" only when run manually; scheduled → null', async () => {
  const u = mkUser();
  const manual = await healthBriefBody(u, { llm: async () => 'x', thresholds: THRESH, now: NOW, manual: true });
  assert.match(manual.body, /No health data received yet/);
  assert.match(manual.body, /尚未收到任何健康数据/);
  const scheduled = await healthBriefBody(u, { llm: async () => 'x', thresholds: THRESH, now: NOW, manual: false });
  assert.equal(scheduled, null, 'scheduled + empty store → no briefing at all');
});

test('R13-5 regression: 08:00 with a partial TODAY — cumulative steps window ends yesterday, no false flag', () => {
  // Re-pointed 2026-10-11: this invariant was pinned through the daily exception line, which
  // was removed with the daily brief. The weekly analysis scores the SAME window, so it is
  // pinned here on the code that remains.
  // 7 complete healthy days (5500 ≥ the 5000 threshold), then this morning's
  // partial 300 steps. Old windows included today: mean (300+6*5500)/7 ≈ 4757 →
  // FALSE flag at 08:00. New windows end yesterday: mean 5500 → silence.
  const rows = [];
  for (let n = 7; n >= 1; n--) rows.push({ date: day(n), steps: 5500, sleepMinutes: 420, weight: 70 });
  rows.push({ date: day(0), steps: 300 });
  const at8 = new Date(NOW); at8.setHours(8, 0, 0, 0);
  const a = analyzeHealth(rows, { thresholds: THRESH, now: at8 });
  assert.equal(a.metrics.steps.d7.mean, 5500, 'the 7d steps window ends yesterday — today\'s partial count is not in it');
  assert.ok(!a.flags.some((f) => f.metric === 'steps'), 'partial today must not fire the threshold');
});

test('R13-9: briefing footer names the LLM lane (aggregates only) when a label is injected', async () => {
  const u = mkUser();
  for (const r of synthRows()) ingestHealth(u, { date: r.date, ...r });
  const out = await healthBriefBody(u, { llm: async () => '- ok 好', llmLabel: 'DeepSeek', thresholds: THRESH, now: NOW });
  assert.match(out.body, /analyzed via DeepSeek \(aggregates only\) · 仅聚合数据/);
  const bare = await healthBriefBody(u, { llm: async () => '- ok 好', thresholds: THRESH, now: NOW });
  assert.ok(!/analyzed via/.test(bare.body), 'no label → no footer line');
});

test('R14 falsy-zero: a genuine ZERO prior week with real coverage reports absolute change, never "no prior data"', () => {
  // Prior steps week (offsets 8-14, cumulative windows end yesterday) is all
  // REAL zeros — 7/7 days of coverage. Percent change vs 0 is undefined, so
  // deltaPct stays null, but the rendered line must say 0 → 6000 (the
  // adherence meanChange precedent), never claim the week is missing.
  const rows = synthRows().map((r, i, all) => {
    const n = all.length - 1 - i; // offset from NOW (rows are oldest→newest)
    return (n >= 8 && n <= 14) ? { ...r, steps: 0 } : r;
  });
  const a = analyzeHealth(rows, { thresholds: THRESH, now: NOW });
  assert.equal(a.metrics.steps.prior7.mean, 0, 'zero baseline is data');
  assert.equal(a.metrics.steps.prior7.present, 7, 'full coverage');
  assert.equal(a.metrics.steps.deltaPct, null, 'percent vs a zero baseline is undefined — stays null');
  const brief = renderBriefing(a, '- s 建议');
  assert.match(brief, /prior 7d avg 0 → 6000/, 'absolute change shown');
  assert.match(brief, /从0开始/, 'bilingual from-zero marker (adherence precedent)');
  assert.ok(!/no prior week to compare/.test(brief) && !/无上周数据可比/.test(brief),
    'a zero baseline must never be reported as missing data (R14)');
  // A prior week with truly NO rows still reads as missing — the two cases stay distinct.
  const gone = synthRows().filter((r, i, all) => { const n = all.length - 1 - i; return !(n >= 8 && n <= 14); });
  const b = analyzeHealth(gone, { thresholds: THRESH, now: NOW });
  assert.equal(b.metrics.steps.prior7.present, 0);
  assert.match(renderBriefing(b, '- s 建议'), /no prior week to compare · 无上周数据可比/);
});

