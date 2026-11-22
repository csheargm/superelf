// Weekly Meals · 饮食 section（每周饮食小结, PLAN.md capability #3) — PURE
// aggregation of stored meal records into the 健康简报: deterministic lines,
// named thresholds, honest coverage, no LLM (the brief's llm stub here phrases
// suggestions only and never sees the meal lines). Throwaway workspaces.
process.env.TZ = 'Asia/Shanghai';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendMeal } from '../lib/meals.mjs';
import { mealsBriefLines, MIN_PATTERN_PHOTOS } from '../lib/meals-brief.mjs';
import { analyzeHealth, renderBriefing, healthBriefBody } from '../lib/health-analyze.mjs';
import { ingestHealth } from '../lib/health.mjs';
import { localDateStr } from '../lib/schedule.mjs';

const NOW = new Date(2026, 7, 30, 12);   // local 2026-08-30 — same anchor as health-analyze tests
const THRESH = { steps_min_daily: 5000, sleep_min_minutes: 360, weight_delta_kg_7d: 1.5 };
const mkUser = () => ({ id: 'owner', workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'mealsbrief-')) });
const FLAGS0 = { carb_heavy: false, fried: false, sugary_drink: false, vegetables_present: false };

// Seed one stored record `off` days before NOW at local `time` (HH:MM).
function meal(u, off, time, over = {}) {
  const d = new Date(NOW); d.setDate(d.getDate() - off);
  const [hh, mm] = time.split(':').map(Number); d.setHours(hh, mm, 0, 0);
  return appendMeal(u, { id: `meal-${d.getTime()}`, ts: d.getTime(), date: localDateStr(d), time,
    slot: over.slot || (hh >= 17 ? 'dinner' : 'lunch'), photo: 'uploads/x.jpg',
    analyzed: true, isFood: true, items: ['rice'], flags: { ...FLAGS0 }, ...over });
}

test('zero photos → no lines (section omitted entirely)', () => {
  assert.deepEqual(mealsBriefLines(mkUser(), { now: NOW }), []);
});

test('below MIN_PATTERN_PHOTOS → ONE honest "too few" line, no invented pattern', () => {
  const u = mkUser();
  for (let i = 0; i < MIN_PATTERN_PHOTOS - 1; i++) meal(u, 1 + i, '12:00');
  const lines = mealsBriefLines(u, { now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /too few to see a pattern · 照片不足/);
});

test('pattern week: honest coverage + dinner-late and carb-heavy lines, capped at 3 lines', () => {
  const u = mkUser();
  // 9 photos: 1 analysis failure, 1 non-food, 7 food. Dinners avg 20:40;
  // carb_heavy on 4/7 (>1/2); vegetables on 3/7 (<1/2 — crowded out by the cap).
  meal(u, 6, '19:00', { analyzed: false, isFood: undefined, items: undefined, flags: undefined, reason: 'lane down', slot: 'dinner' });
  meal(u, 6, '13:00', { isFood: false, slot: 'lunch' });
  const carb = (v) => ({ flags: { ...FLAGS0, carb_heavy: v, vegetables_present: !v } });
  meal(u, 5, '20:30', { slot: 'dinner', ...carb(true) });
  meal(u, 4, '20:50', { slot: 'dinner', ...carb(true) });
  meal(u, 3, '20:40', { slot: 'dinner', ...carb(true) });
  meal(u, 2, '20:40', { slot: 'dinner', ...carb(true) });
  meal(u, 3, '12:00', carb(false));
  meal(u, 2, '12:10', carb(false));
  meal(u, 1, '12:20', carb(false));
  const lines = mealsBriefLines(u, { now: NOW });
  assert.equal(lines.length, 3, 'coverage + at most 2 pattern lines');
  assert.match(lines[0], /8 of 9 photos analyzed this week · 本周9张照片中已分析8张/);
  assert.match(lines[1], /dinner avg 20:40 over 4 dinners, later than 20:00 · 晚餐偏晚 \(平均20:40，4次晚餐\)/);
  assert.match(lines[2], /carb-heavy 4\/7 · 碳水偏多/);
  assert.ok(!lines.some((l) => /蔬菜偏少/.test(l)), 'third pattern crowded out by the 2-line cap');
});

test('all-analyzed coverage phrasing; healthy week → coverage line only', () => {
  const u = mkUser();
  meal(u, 2, '12:00', { flags: { ...FLAGS0, vegetables_present: true } });
  meal(u, 1, '18:30', { slot: 'dinner', flags: { ...FLAGS0, vegetables_present: true } });
  const lines = mealsBriefLines(u, { now: NOW });
  assert.deepEqual(lines, ['- 2 photos this week · 本周2张照片'], 'no thresholds crossed → nothing flagged');
});

test('threshold edges: exactly half carb / half veg does NOT flag; sugary drink always counts', () => {
  const u = mkUser();
  meal(u, 3, '12:00', { flags: { ...FLAGS0, carb_heavy: true, vegetables_present: true } });
  meal(u, 2, '12:00', { flags: { ...FLAGS0, sugary_drink: true } });
  meal(u, 1, '12:00', { flags: { ...FLAGS0, vegetables_present: true } });
  meal(u, 1, '18:00', { slot: 'dinner', flags: { ...FLAGS0, carb_heavy: true } });
  // 4 food photos: carb 2/4 (=1/2, not >), veg 2/4 (=1/2, not <), sugary 1.
  const lines = mealsBriefLines(u, { now: NOW });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /sugary drinks 1\/4 · 含糖饮料1次/);
});

test('non-food photos count toward coverage, never toward pattern denominators', () => {
  const u = mkUser();
  meal(u, 3, '12:00', { isFood: false });
  meal(u, 2, '12:00', { flags: { ...FLAGS0, carb_heavy: true, vegetables_present: true } });
  meal(u, 1, '12:00', { flags: { ...FLAGS0, carb_heavy: true, vegetables_present: true } });
  const lines = mealsBriefLines(u, { now: NOW });
  assert.match(lines[0], /3 photos this week/);
  assert.match(lines[1], /carb-heavy 2\/2/, 'denominator = analyzed food photos only, never the non-food one');
});

test('R14: one analyzed food photo → coverage line ONLY, zero pattern lines', () => {
  const u = mkUser();
  meal(u, 1, '20:45', { slot: 'dinner', flags: { ...FLAGS0, fried: true, carb_heavy: true } });
  meal(u, 2, '12:00', { analyzed: false, isFood: undefined, items: undefined, flags: undefined, reason: 'lane down' });
  const lines = mealsBriefLines(u, { now: NOW });
  assert.deepEqual(lines, ['- 1 of 2 photos analyzed this week · 本周2张照片中已分析1张'],
    'one meal is never presented as a weekly pattern — the gate counts ANALYZED FOOD records');
});

test('read-back guard: a malformed food record (flags missing) counts as unanalyzed, never in denominators', () => {
  const u = mkUser();
  meal(u, 2, '12:00', { flags: { ...FLAGS0, fried: true, vegetables_present: true } });
  meal(u, 3, '12:00', { flags: { ...FLAGS0, fried: true, vegetables_present: true } });
  // Hand-corrupted row: analyzed:true food with NO flags object (agent lane /
  // hand edit / future schema drift can all write into the workspace).
  const d = new Date(NOW); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0);
  const f = path.join(u.workspace, 'meals', '2026-08.json');
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  rows.push({ id: 'corrupt', ts: d.getTime(), date: localDateStr(d), time: '12:00', slot: 'lunch', photo: 'x', analyzed: true, isFood: true });
  fs.writeFileSync(f, JSON.stringify(rows));
  const lines = mealsBriefLines(u, { now: NOW });
  assert.match(lines[0], /2 of 3 photos analyzed/, 'malformed row counts as an UNANALYZED photo');
  assert.match(lines[1], /fried 2\/2/, 'denominator excludes the malformed row');
});

test('window: calendar days ending YESTERDAY — today excluded, 7 calendar days back included, 8 excluded', () => {
  const u = mkUser();
  meal(u, 0, '08:00');   // today — not part of the brief week (same DAY convention as analyzeHealth)
  meal(u, 7, '12:00');   // 7 calendar days back — in
  meal(u, 8, '12:00');   // 8 back — out
  const lines = mealsBriefLines(u, { now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 photo this week — too few/, 'exactly one photo lands in the calendar window');
});

test('dinner-late states its n, needs MIN_DINNERS, and a 23:30 dinner counts (slot boundary)', () => {
  const u = mkUser();
  meal(u, 1, '23:30', { slot: 'dinner', flags: { ...FLAGS0, vegetables_present: true } });
  meal(u, 2, '23:30', { slot: 'dinner', flags: { ...FLAGS0, vegetables_present: true } });
  const lines = mealsBriefLines(u, { now: NOW });
  assert.match(lines[1], /dinner avg 23:30 over 2 dinners, later than 20:00 · 晚餐偏晚 \(平均23:30，2次晚餐\)/);
  const u2 = mkUser();
  meal(u2, 1, '23:30', { slot: 'dinner' });
  meal(u2, 2, '12:00');
  assert.ok(!mealsBriefLines(u2, { now: NOW }).some((l) => /晚餐偏晚/.test(l)),
    'a single dinner is one meal, not an average — no line below MIN_DINNERS');
});

test('renderBriefing: meal lines get their own Meals · 饮食 section; empty → absent', () => {
  const a = analyzeHealth([{ date: localDateStr(new Date(NOW - 86400000)), steps: 8000 }], { thresholds: THRESH, now: NOW });
  const withMeals = renderBriefing(a, '- s 建议', '', [], ['- 3 photos this week · 本周3张照片']);
  assert.match(withMeals, /## Meals · 饮食\n- 3 photos this week/);
  assert.ok(!renderBriefing(a, '- s 建议').includes('## Meals'), 'no records → no section');
});

test('healthBriefBody: stored meal records surface in the weekly body (wired like adherence)', async () => {
  const u = mkUser();
  for (let n = 1; n <= 8; n++) {
    const d = new Date(NOW); d.setDate(d.getDate() - n);
    ingestHealth(u, { date: localDateStr(d), steps: 8000 });
  }
  meal(u, 2, '12:00', { flags: { ...FLAGS0, vegetables_present: true } });
  meal(u, 1, '20:45', { slot: 'dinner', flags: { ...FLAGS0, vegetables_present: true } });
  const out = await healthBriefBody(u, { llm: async () => '- walk 散步', thresholds: THRESH, now: NOW });
  assert.match(out.body, /## Meals · 饮食/);
  assert.match(out.body, /2 photos this week · 本周2张照片/);
  assert.ok(!/晚餐偏晚/.test(out.body), 'a single 20:45 dinner is never presented as a late-dinner average (MIN_DINNERS)');
});
