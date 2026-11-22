process.env.TZ = 'Asia/Shanghai';   // sample→local-day bucketing depends on TZ; pin it so asserts hold on any machine
// Health ingest must never lose data behind a success.
//
// THE DEFECT: `MAX_SAMPLES` (2000) discarded every sample past the cap and
// /api/health/ingest still answered `200 ok:true`, so a backfill or a multi-day
// catch-up lost its tail with nothing anywhere to see. One layer down, the same
// shape: retention keeps the newest MAX_DAYS days PRESENT IN THE STORE, not the
// last MAX_DAYS calendar days — so a day older than all of them was written,
// rolled up, and deleted again by pruneDays/pruneSampleFiles INSIDE THE SAME
// CALL, still reported as `added:N, ok:true`.
//
// WHAT IS ASSERTED HERE — the one invariant, from both directions:
//     ok === true  ⇔  dropped === 0  ⇔  everything you sent is on disk.
//   plus the arithmetic (stored + dropped === what was sent), the counts in
//   every rejection, and — the part that makes this more than bookkeeping —
//   that the store on disk really matches what the answer claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestHealth, recentHealth, MAX_SAMPLES, MAX_DAYS, HTTP_PARTIAL } from '../lib/health.mjs';

const mkUser = () => ({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'health-drop-')), id: 'owner' });
const stepsAt = (ts, value = 100) => ({ schema: 'health.v2', metrics: [{ metric: 'steps', unit: 'count', samples: [{ ts, value }] }] });
const dayFiles = (u) => fs.readdirSync(path.join(u.workspace, 'health')).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
// n samples on one day, each a distinct instant so none dedupe away.
const nSamples = (n) => Array.from({ length: n }, (_, i) => ({ ts: new Date(Date.UTC(2026, 7, 1, 0, 0, i % 60, i % 1000)).toISOString(), value: 10 }));

test('over MAX_SAMPLES: the dropped tail is COUNTED and the answer is not a success', () => {
  const u = mkUser();
  const sent = MAX_SAMPLES + 7;
  const r = ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'steps', unit: 'count', samples: nSamples(sent) }] });

  assert.equal(r.stored, MAX_SAMPLES, 'the cap still bounds the work');
  assert.equal(r.dropped, 7, 'the tail is counted, not merely mentioned');
  assert.equal(r.stored + r.dropped, sent, 'every sample sent is accounted for in exactly one bucket');
  assert.equal(r.ok, false, 'a lost tail is NOT a clean success (this answered 200 ok:true)');
  assert.equal(r.status, HTTP_PARTIAL, 'partial store → 207, so the HTTP answer is honest too');
  assert.equal(r.code, 'partial');
  assert.match(r.error, /7/, 'the error states how many were lost');
  const cap = r.rejected.find((x) => /cap/.test(x.reason));
  assert.ok(cap, 'the cap rejection is named');
  assert.equal(cap.samples, 7, 'and it carries the count — "rest dropped" could not tell 1 from 8000');
});

test('the cap drops LATER metrics whole, and says how many of each', () => {
  const u = mkUser();
  const r = ingestHealth(u, { schema: 'health.v2', metrics: [
    { metric: 'steps', unit: 'count', samples: nSamples(MAX_SAMPLES) },
    { metric: 'weight', unit: 'kg', samples: [{ ts: '2026-08-02T07:00:00+08:00', value: 70 }, { ts: '2026-08-03T07:00:00+08:00', value: 71 }] },
  ] });
  assert.equal(r.stored, MAX_SAMPLES);
  assert.equal(r.dropped, 2, 'both weight samples are lost to the cap and both are counted');
  assert.equal(r.ok, false);
  const w = r.rejected.find((x) => x.metric === 'weight');
  assert.equal(w.samples, 2);
  assert.equal(recentHealth(u, MAX_DAYS).some((row) => 'weight' in row), false, 'the report matches the store: no weight was actually written');
});

test('a clean upload still answers clean — ok:true, dropped:0, no status override', () => {
  const u = mkUser();
  const r = ingestHealth(u, { schema: 'health.v2', metrics: [{ metric: 'steps', unit: 'count', samples: nSamples(3) }] });
  assert.equal(r.ok, true);
  assert.equal(r.dropped, 0);
  assert.equal(r.stored, 3);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.status, undefined, 'nothing dropped → the route answers its plain 200 (R14: this control must stay passable)');
});

test('v2 retention eviction: a day deleted by the SAME call is reported, not counted as stored', () => {
  const u = mkUser();
  // Fill the window with MAX_DAYS newer days, then backfill one older day.
  for (let i = 0; i < MAX_DAYS; i++) ingestHealth(u, stepsAt(new Date(Date.UTC(2020, 2, 1 + i, 4)).toISOString()));
  assert.equal(dayFiles(u).length, MAX_DAYS, 'the window is full before the backfill');

  const r = ingestHealth(u, stepsAt('2020-01-15T13:00:00+08:00', 50));

  assert.equal(r.added, 1, 'the write really happened');
  assert.equal(r.stored, 0, 'and was undone by retention in this same call — nothing survived');
  assert.equal(r.dropped, 1);
  assert.equal(r.ok, false, 'this answered ok:true, added:1 for a sample that no longer existed anywhere');
  assert.equal(r.status, 400, 'nothing stored → 400, not 207');
  const ret = r.rejected.find((x) => x.metric === '(retention)');
  assert.ok(ret, 'the retention eviction is named as such');
  assert.equal(ret.day, '2020-01-15');
  assert.match(ret.reason, new RegExp(`${MAX_DAYS}`), 'the reason names the window');
  // The report must match the disk, or it is just a different lie.
  assert.equal(fs.existsSync(path.join(u.workspace, 'health', '2020-01-15.json')), false, 'the raw day file is really gone');
  assert.equal(recentHealth(u, MAX_DAYS).some((row) => row.date === '2020-01-15'), false, 'and so is the daily row');
});

test('v2 ordinary ageing-out is reported too — retention is no longer silent', () => {
  const u = mkUser();
  for (let i = 0; i < MAX_DAYS; i++) ingestHealth(u, stepsAt(new Date(Date.UTC(2020, 2, 1 + i, 4)).toISOString()));
  const r = ingestHealth(u, stepsAt(new Date(Date.UTC(2020, 2, 1 + MAX_DAYS, 4)).toISOString()));
  assert.equal(r.ok, true, 'a day ageing out as designed is not a failed upload');
  assert.equal(r.dropped, 0, 'nothing THIS caller sent was lost');
  assert.deepEqual(r.pruned, { days: 1, files: 1 }, 'but what retention removed is reported, so the route can audit it');
  assert.equal(dayFiles(u).length, MAX_DAYS);
});

test('v1 retention eviction: the day just written, pruned by the same call, is refused honestly', () => {
  const u = mkUser();
  for (let y = 2000; y < 2000 + MAX_DAYS; y++) ingestHealth(u, { date: `${y}-01-01`, steps: y });  // MAX_DAYS distinct dates
  const good = ingestHealth(u, { date: '2130-01-01', steps: 1 });
  assert.equal(good.ok, true, 'a normal newer day is unaffected');
  assert.deepEqual(good.pruned, { days: 1 }, 'and the aged-out day is reported');

  const r = ingestHealth(u, { date: '1999-01-01', steps: 8000 });
  assert.equal(r.ok, false, 'this answered ok:true with the row already deleted');
  assert.equal(r.stored, 0);
  assert.equal(r.dropped, 1);
  assert.match(r.error, new RegExp(`${MAX_DAYS}`), 'the refusal names the retention window');
  assert.equal(recentHealth(u, MAX_DAYS).some((row) => row.date === '1999-01-01'), false, 'the store agrees with the answer');
});

test('invalid samples and unknown metrics are counted, not just narrated', () => {
  const u = mkUser();
  const r = ingestHealth(u, { schema: 'health.v2', metrics: [
    { metric: 'steps', samples: [{ ts: 'not-a-date', value: 1 }, { ts: '2026-08-30T10:00:00Z', value: Infinity }, { ts: '2026-08-30T11:00:00Z', value: 900 }] },
    { metric: 'glucose', samples: [{ ts: '2026-08-30T11:00:00Z', value: 5 }, { ts: '2026-08-30T12:00:00Z', value: 6 }] },
  ] });
  assert.equal(r.stored, 1);
  assert.equal(r.dropped, 4, '2 invalid + 2 under an unknown metric');
  assert.equal(r.ok, false);
  assert.equal(r.rejected.find((x) => x.metric === 'glucose').samples, 2, 'an unknown metric reports how much it cost');
  assert.equal(r.rejected.find((x) => x.metric === 'steps').samples, 2);
});
