process.env.TZ = 'Asia/Shanghai';   // sample→local-day bucketing depends on TZ; pin it so asserts hold on any machine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestHealth, recentHealth, monthlyRollups, METRICS, MAX_SAMPLES, METRIC_UNITS } from '../lib/health.mjs';

const mkUser = () => ({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'health-')), id: 'owner' });

// Synthetic v2 payload (schema health.v2) — steps/sleep/weight, two days.
const v2Payload = () => ({
  schema: 'health.v2', source: 'iphone-shortcut',
  metrics: [
    { metric: 'steps', unit: 'count', samples: [
      { ts: '2026-08-29T08:00:00+08:00', value: 1200 }, { ts: '2026-08-29T18:00:00+08:00', value: 4300 },
      { ts: '2026-08-30T09:00:00+08:00', value: 2500 } ] },
    { metric: 'sleep', unit: 'min', samples: [
      { ts: '2026-08-29T23:10:00+08:00', end: '2026-08-30T06:40:00+08:00', value: 450, stage: 'asleep' } ] },
    { metric: 'weight', unit: 'kg', samples: [
      { ts: '2026-08-30T07:30:00+08:00', value: 70.4 }, { ts: '2026-08-29T07:30:00+08:00', value: 70.9 } ] },
  ],
});

test('ingest + read a day, newest last', () => {
  const u = mkUser();
  ingestHealth(u, { date: '2026-08-29', steps: 8432, sleepMinutes: 435 });
  ingestHealth(u, { date: '2026-08-30', steps: 10120, exerciseMinutes: 42 });
  const rows = recentHealth(u, 7);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].date, '2026-08-30');   // oldest→newest
  assert.equal(rows[1].steps, 10120);
  assert.equal(rows[0].sleepMinutes, 435);
});

test('same-day ingest merges, does not clobber', () => {
  const u = mkUser();
  ingestHealth(u, { date: '2026-08-30', steps: 5000 });
  ingestHealth(u, { date: '2026-08-30', sleepMinutes: 420 });
  const [row] = recentHealth(u, 1);
  assert.equal(row.steps, 5000);
  assert.equal(row.sleepMinutes, 420);
});

test('sanitize: drops bad keys, non-finite numbers, objects; truncates strings', () => {
  const u = mkUser();
  const { metrics } = ingestHealth(u, {
    date: '2026-08-30',
    steps: 8000,
    'bad key!': 1,                 // invalid key
    nested: { x: 1 },              // object dropped
    weird: Infinity,               // non-finite dropped
    note: 'x'.repeat(500),         // truncated
  });
  assert.equal(metrics.steps, 8000);
  assert.ok(!('bad key!' in metrics) && !('nested' in metrics) && !('weird' in metrics));
  assert.equal(metrics.note.length, 120);
});

test('defaults to today when no date given', () => {
  const u = mkUser();
  const { date } = ingestHealth(u, { steps: 100 });
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(recentHealth(u, 1)[0].steps, 100);
});

test('history is capped at 120 days (no unbounded growth)', () => {
  const u = mkUser();
  for (let y = 2000; y < 2130; y++) ingestHealth(u, { date: `${y}-01-01`, steps: y });  // 130 distinct dates
  assert.equal(recentHealth(u, 999).length, 120);
});

// ── v2 sample-level ingest (schema health.v2) ─────────────────────────────────

test('v1 storage is unchanged by the v2 code path (honest control)', () => {
  const u = mkUser();
  ingestHealth(u, { date: '2026-08-30', steps: 8000, weight: 70.2 });
  const stored = JSON.parse(fs.readFileSync(path.join(u.workspace, 'health.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored), ['2026-08-30']);
  assert.deepEqual(Object.keys(stored['2026-08-30']).sort(), ['steps', 'updated', 'weight']); // exact v1 shape, no v2 fields
  assert.ok(!fs.existsSync(path.join(u.workspace, 'health')), 'v1 must not create the samples dir');
});

test('v2 ingest: samples land, daily rollup + GET-contract fields appear', () => {
  const u = mkUser();
  const r = ingestHealth(u, v2Payload());
  assert.equal(r.ok, true);
  assert.equal(r.added, 6);
  assert.equal(r.duplicates, 0);
  assert.deepEqual(r.rejected, []);
  const rows = recentHealth(u, 400);
  const d29 = rows.find((x) => x.date === '2026-08-29'), d30 = rows.find((x) => x.date === '2026-08-30');
  assert.equal(d29.steps, 5500, 'steps sum per day');
  assert.equal(d29.weight, 70.9);
  assert.equal(d30.steps, 2500);
  assert.equal(d30.sleepMinutes, 450, 'sleep counts on the morning it ENDS');
  assert.equal(d30.weight, 70.4);
  assert.ok(fs.existsSync(path.join(u.workspace, 'health', '2026-08-29.json')), 'per-day raw sample file');
});

test('v2 ingest is idempotent: re-running the same payload changes NOTHING', () => {
  const u = mkUser();
  ingestHealth(u, v2Payload());
  const raw1 = fs.readFileSync(path.join(u.workspace, 'health', '2026-08-29.json'), 'utf8');
  const rows1 = JSON.stringify(recentHealth(u, 400).map(({ updated, ...r }) => r));
  const r2 = ingestHealth(u, v2Payload());
  assert.equal(r2.added, 0);
  assert.equal(r2.duplicates, 6);
  assert.equal(r2.updated, 0, 'byte-identical retry is a duplicate, not an update');
  assert.equal(fs.readFileSync(path.join(u.workspace, 'health', '2026-08-29.json'), 'utf8'), raw1, 'raw store byte-identical');
  assert.equal(JSON.stringify(recentHealth(u, 400).map(({ updated, ...r }) => r)), rows1, 'rollup values unchanged');
});

test('v2: unknown metric rejected per-metric, valid ones still stored', () => {
  const u = mkUser();
  const p = v2Payload();
  p.metrics.push({ metric: 'glucose', unit: 'mg/dL', samples: [{ ts: '2026-08-30T07:30:00-0700', value: 105 }] });
  const r = ingestHealth(u, p);
  // CONTRACT CHANGE (the silent-drop fix): this used to answer ok:true. Losing
  // a metric is not a clean success — ok now means "everything you sent is on
  // disk", and the good metrics are still stored, per-metric as before.
  assert.equal(r.ok, false, 'a dropped metric must not answer as a clean success');
  assert.equal(r.added, 6, 'locked-set metrics stored');
  assert.equal(r.stored, 6);
  assert.equal(r.dropped, 1, 'the glucose sample is counted, not just mentioned');
  assert.equal(r.status, 207, 'partial store → 207, never 200');
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].metric, 'glucose');
  assert.equal(r.rejected[0].samples, 1);
  assert.match(r.rejected[0].reason, /unknown metric/);
  // The first wave was steps/sleep/weight, with heart/workouts explicitly named as LATER
  // waves. That wave landed 2026-09-10 (Apple Watch), so this pins the two things that must
  // stay true rather than a frozen list: the originals survive, and the set is closed.
  for (const m of ['steps', 'sleep', 'weight']) assert.ok(METRICS.includes(m), `${m} must survive any widening`);
  assert.ok(!METRICS.includes('blood_pressure'), 'the set stays CLOSED — unknown metrics are refused, not stored');
});

test('v2: invalid samples skipped with a stated reason; nothing invented', () => {
  const u = mkUser();
  const r = ingestHealth(u, { schema: 'health.v2', metrics: [
    { metric: 'steps', samples: [{ ts: 'not-a-date', value: 1 }, { ts: '2026-08-30T10:00:00Z', value: Infinity }, { ts: '2026-08-30T11:00:00Z', value: 900 }] },
  ] });
  assert.equal(r.added, 1);
  assert.match(r.rejected[0].reason, /2 invalid sample/);
});

test('v2: payload with no usable metrics stores nothing and says so', () => {
  const u = mkUser();
  const r1 = ingestHealth(u, { schema: 'health.v2', metrics: [] });
  assert.equal(r1.ok, false);
  const r2 = ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'glucose', samples: [{ ts: '2026-08-30T07:30:00Z', value: 105 }] }] });
  assert.equal(r2.ok, false);
  assert.equal(r2.rejected.length, 1);
  assert.ok(!fs.existsSync(path.join(u.workspace, 'health.json')), 'nothing stored');
});

test('v2: sample cap enforced (abuse-safe), overflow reported', () => {
  const u = mkUser();
  const samples = Array.from({ length: MAX_SAMPLES + 5 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 7, 1, 0, 0, i % 60, i)).toISOString(), value: 10 }));
  const r = ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'steps', samples }] });
  assert.equal(r.added, MAX_SAMPLES);
  assert.match(r.rejected[0].reason, /cap/);
});

test('v2: monthly rollups are written (kept beyond the 120-day raw window)', () => {
  const u = mkUser();
  ingestHealth(u, v2Payload());
  const months = monthlyRollups(u);
  assert.equal(months.length, 1);
  assert.equal(months[0].month, '2026-08');
  assert.equal(months[0].days, 2);
  assert.equal(months[0].stepsAvg, 4000, '(5500+2500)/2');
  assert.equal(months[0].weightLast, 70.4);
});

// ── R13 review regressions ────────────────────────────────────────────────────

test('R13-1 regression: stray sample older than the raw window must NOT clobber the month rollup', () => {
  const u = mkUser();
  const steps = (ts, value) => ({ schema: 'health.v2', metrics: [{ metric: 'steps', samples: [{ ts, value }] }] });
  // Fill Jan 2020 (31 days), then 120 later days so every Jan day is pruned
  // from the daily map while the Jan monthly rollup (kept indefinitely) remains.
  for (let d = 1; d <= 31; d++) ingestHealth(u, steps(`2020-01-${String(d).padStart(2, '0')}T12:00:00+08:00`, 1000));
  for (let i = 0; i < 120; i++) ingestHealth(u, steps(new Date(Date.UTC(2020, 2, 1 + i, 4)).toISOString(), 2000));
  const jan = monthlyRollups(u).find((m) => m.month === '2020-01');
  assert.equal(jan.days, 31);
  assert.equal(jan.stepsAvg, 1000);
  // Backfill ONE stray Jan sample — the stored Jan rollup must stay untouched
  // (before the fix it was recomputed from 0 surviving days: days:0, all null).
  ingestHealth(u, steps('2020-01-15T13:00:00+08:00', 50));
  const jan2 = monthlyRollups(u).find((m) => m.month === '2020-01');
  assert.equal(jan2.days, 31, 'kept-indefinitely rollup not degraded by a pruned-month backfill');
  assert.equal(jan2.stepsAvg, 1000);
});

test('R13-2 regression: overlapping inBed + stage records — only asleep-class stages count, never awake', () => {
  const u = mkUser();
  const s = (ts, end, value, stage) => ({ ts, end, value, stage });
  ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'sleep', unit: 'min', samples: [
    s('2026-08-29T23:00:00+08:00', '2026-08-30T07:00:00+08:00', 480, 'inBed'),   // whole-night span, overlaps everything below
    s('2026-08-29T23:20:00+08:00', '2026-08-30T02:40:00+08:00', 200, 'core'),
    s('2026-08-30T02:40:00+08:00', '2026-08-30T04:20:00+08:00', 100, 'rem'),
    s('2026-08-30T04:20:00+08:00', '2026-08-30T06:00:00+08:00', 60, 'deep'),
    s('2026-08-30T06:00:00+08:00', '2026-08-30T06:30:00+08:00', 30, 'awake'),
  ] }] });
  const row = recentHealth(u, 400).find((r) => r.date === '2026-08-30');
  assert.equal(row.sleepMinutes, 360, 'core+rem+deep = 360 — inBed not double-counted, awake never counted');
});

test('R13-2: inBed is the fallback ONLY when no asleep-class record exists that day', () => {
  const u = mkUser();
  ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'sleep', unit: 'min', samples: [
    { ts: '2026-08-29T23:00:00+08:00', end: '2026-08-30T07:00:00+08:00', value: 480, stage: 'inBed' },
  ] }] });
  assert.equal(recentHealth(u, 400).find((r) => r.date === '2026-08-30').sleepMinutes, 480, 'inBed-only night still yields minutes');
});

test('R13-4 regression: day-bucket re-export (same key, new value) → last write wins, reported as updated', () => {
  const u = mkUser();
  const p = (v) => ({ schema: 'health.v2', source: 'iphone-shortcut', metrics: [{ metric: 'steps', unit: 'count', samples: [{ ts: '2026-08-30T00:00:00+08:00', value: v }] }] });
  assert.equal(ingestHealth(u, p(1200)).added, 1);
  const retry = ingestHealth(u, p(1200));                     // byte-identical retry
  assert.equal(retry.duplicates, 1);
  assert.equal(retry.updated, 0);
  const reexport = ingestHealth(u, p(4300));                  // evening re-export: the day bucket grew
  assert.equal(reexport.updated, 1, 'revised value replaces, not silently dropped');
  assert.equal(reexport.added, 0);
  assert.equal(reexport.duplicates, 0);
  assert.equal(recentHealth(u, 400).find((r) => r.date === '2026-08-30').steps, 4300, 'rollup recomputed from the new value');
});

test('R13-8 regression: out-of-order backfill — monthly weightLast is the latest DATE, not the last ingested', () => {
  const u = mkUser();
  const w = (day, v) => ({ schema: 'health.v2', metrics: [{ metric: 'weight', unit: 'kg', samples: [{ ts: `2026-08-${day}T07:00:00+08:00`, value: v }] }] });
  ingestHealth(u, w('30', 70.4));
  ingestHealth(u, w('01', 72.0));   // backfill an EARLIER day after the later one
  const aug = monthlyRollups(u).find((m) => m.month === '2026-08');
  assert.equal(aug.days, 2);
  assert.equal(aug.weightLast, 70.4, 'Aug 30 reading — insertion order must not decide');
});

test('v2: raw per-day sample files follow the 120-day retention', () => {
  const u = mkUser();
  for (let i = 0; i < 125; i++) {
    const ts = new Date(Date.UTC(2020, 0, 1 + i, 12, 0, 0)).toISOString();
    ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'steps', samples: [{ ts, value: 100 }] }] });
  }
  const files = fs.readdirSync(path.join(u.workspace, 'health')).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  assert.equal(files.length, 120);
  assert.ok(monthlyRollups(u).length >= 4, 'monthly rollups survive the prune');
});

// ── The Apple Watch wave（Apple Watch 数据）────────────────────────────────────────────────
// The metric set was steps/sleep/weight only, which was the real blocker: a Shortcut sending
// exercise minutes had every sample refused, and from the phone that looks exactly like a
// working upload that stores nothing.
test('activity, exercise and heart metrics are accepted', () => {
  const u = mkUser();
  const at = '2026-09-10T08:00:00-0700';
  const r = ingestHealth(u, { schema: 'health.v2', source: 'iphone-shortcut', metrics: [
    { metric: 'active_energy', unit: 'kcal', samples: [{ ts: at, value: 560 }] },
    { metric: 'exercise_minutes', unit: 'min', samples: [{ ts: at, value: 42 }] },
    { metric: 'stand_hours', unit: 'count', samples: [{ ts: at, value: 11 }] },
    { metric: 'resting_heart_rate', unit: 'bpm', samples: [{ ts: at, value: 54 }] },
    { metric: 'heart_rate_variability', unit: 'ms', samples: [{ ts: at, value: 48 }] },
    { metric: 'vo2max', unit: 'ml/kg/min', samples: [{ ts: at, value: 41.2 }] },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.added, 6, 'every Watch metric stores');
  assert.deepEqual(r.rejected, []);
});

test('an unknown metric is still refused — and the refusal NAMES what is allowed', () => {
  const u = mkUser();
  const r = ingestHealth(u, { schema: 'health.v2', source: 's', metrics: [
    { metric: 'steps', unit: 'count', samples: [{ ts: '2026-09-10T08:00:00-0700', value: 8200 }] },
    { metric: 'blood_pressure', unit: 'mmHg', samples: [{ ts: '2026-09-10T08:00:00-0700', value: 120 }] },
  ] });
  assert.equal(r.added, 1, 'one bad metric must not lose the good ones — per-metric, not per-payload');
  assert.equal(r.stored, 1);
  assert.equal(r.ok, false, 'but a payload that lost a metric is not a clean success (the silent-drop fix)');
  assert.equal(r.dropped, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].metric, 'blood_pressure');
  assert.match(r.rejected[0].reason, /exercise_minutes/, 'a Shortcut author must see the enabled set to fix it');
});

test('every metric declares its unit, and the two lists cannot drift', () => {
  assert.deepEqual(METRICS, Object.keys(METRIC_UNITS), 'METRICS is derived from METRIC_UNITS (R3)');
  for (const m of METRICS) assert.ok(METRIC_UNITS[m], `${m} needs a unit for the Shortcut to send`);
  // The original three must survive the widening — existing stores are keyed on them.
  for (const m of ['steps', 'sleep', 'weight']) assert.ok(METRICS.includes(m), `${m} must not be dropped`);
});
