// Per-user health metrics — ingested from the iPhone (a Shortcut POSTs to
// /api/health/ingest) or entered manually. Private data, stored in the user's
// workspace (gitignored), keyed by day. Feeds the longevity app and the health
// jobs. Two payload shapes (docs/design/ios-health-ingestion.md):
//   v1 (flat day row)          — unchanged legacy path, merged into health.json
//   v2 ("health.v2", samples)  — raw samples under health/YYYY-MM-DD.json,
//                                deduped, rolled up into the SAME health.json
//                                daily map so GET /api/health sees no change.
import fs from 'node:fs';
import path from 'node:path';
import { localDateStr } from './schedule.mjs';
import { writeJsonFile, writeFileAtomic } from './webutil.mjs';
import { readJson, readJsonForUpdate } from './readjson.mjs';

// The shape every store in this file has: a plain map keyed by day / month /
// sample key. A file that parses to anything else is damaged, not a store.
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const file = (user) => path.join(user.workspace, 'health.json');
const samplesDir = (user) => path.join(user.workspace, 'health');
const dayFile = (user, date) => path.join(samplesDir(user), date + '.json');
const monthlyFile = (user) => path.join(samplesDir(user), 'monthly.json');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,32}$/;
export const MAX_DAYS = 120;   // ~4 months of daily rows AND raw sample files (exported: the retention tests must not restate the number, R3)
const MAX_KEYS = 40;    // metrics per day (v1 map)

// The v2 metric set. SINGLE source for metric names (R3): a payload naming anything else is
// rejected per-metric (not per-payload), and the rejection NAMES the enabled set so a Shortcut
// author can see immediately what to change.
//
// Widened 2026-09-10 for the Apple Watch wave — activity, exercise and heart. The narrow set
// was the actual blocker: a Shortcut sending exercise minutes had every sample refused, which
// looks from the phone exactly like a working upload that stores nothing.
//
// Names are HealthKit's own concepts in snake_case; units are what the Shortcut should send.
export const METRIC_UNITS = {
  steps: 'count',
  sleep: 'min',              // a session: ts = start, end = wake; the day is the WAKE day
  weight: 'kg',
  active_energy: 'kcal',     // Move ring
  exercise_minutes: 'min',   // Exercise ring
  stand_hours: 'count',      // Stand ring
  resting_heart_rate: 'bpm',
  heart_rate_variability: 'ms',
  vo2max: 'ml/kg/min',
  distance_walking: 'km',
  workout_minutes: 'min',    // any logged workout, whatever the type
};
export const METRICS = Object.keys(METRIC_UNITS);
export const MAX_SAMPLES = 2000;          // per payload (design §2.1 abuse cap)
export const MAX_BODY_BYTES = 262144;     // ~256 KB payload cap (design §2.1)

// ── The honesty invariant（诚实约定）, stated ONCE and obeyed by both paths ──
// THE SCAR: every sample past MAX_SAMPLES was discarded and the route still
// answered `200 ok:true`, so a backfill or a multi-day catch-up lost its tail
// with nothing to see. Same shape one layer down: retention keeps the newest
// MAX_DAYS days PRESENT IN THE STORE (not the last MAX_DAYS calendar days), so
// writing a day older than all of them stored it, rolled it up, and then
// pruneDays/pruneSampleFiles deleted it again INSIDE THE SAME CALL — still
// `ok:true, added:N`, for samples that no longer exist anywhere.
//
//   ok === true  ⇔  dropped === 0  ⇔  everything you sent is on disk.
//
// `stored` and `dropped` are counted in samples and always both present, and a
// partial write answers 207 (HTTP_PARTIAL) — never a clean 200 (R14). This is
// a DELIBERATE break for a caller that only reads `ok`: a payload with an
// unknown metric or an invalid sample used to answer ok:true. It should not —
// a holistic health view quietly missing part of an upload is worse than none.
export const HTTP_PARTIAL = 207;          // some stored, some dropped — Multi-Status

// READ-ONLY load (GET /api/health, the jobs): an unreadable store shows as
// empty rather than failing a dashboard. It must never feed a write — that is
// what loadForUpdate is for.
function load(user) {
  const o = readJson(file(user), {});
  return isMap(o) ? o : {};
}
// READ-BEFORE-WRITE load. EMPTY-OVERWRITE CLASS (2026-09-02 round 2): the
// lenient reader above turned an EACCES / a half-written health.json into {},
// and the save at the end of an ingest then stored that {} over up to 120 days
// of history, answering 200 ok:true. Throws instead (file_unreadable → 500).
const loadForUpdate = (user) => readJsonForUpdate(file(user), {}, { expect: isMap });
function save(user, map) {
  writeJsonFile(file(user), map);   // atomic (R3): a SIGTERM mid-write can no longer truncate the store
}
function today() { return localDateStr(new Date()); }

// Accept only finite numbers and short strings under safe keys; drop everything else.
function sanitize(obj) {
  const out = {}; let n = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === 'date') continue;
    if (!KEY.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length) out[k] = v.slice(0, 120);
    else continue;
    if (++n >= MAX_KEYS) break;
  }
  return out;
}

// Merge one day's metrics (default: today) — v1, unchanged. A v2 payload
// (schema:"health.v2") routes to the sample-level path instead.
export function ingestHealth(user, payload) {
  if (payload && payload.schema === 'health.v2') return ingestSamples(user, payload);
  const date = (payload && DATE.test(payload.date)) ? payload.date : today();
  const metrics = sanitize(payload);
  const map = loadForUpdate(user);   // an unreadable store aborts the ingest — it must not be replaced by today's row alone
  map[date] = { ...(map[date] || {}), ...metrics, updated: Date.now() };
  const pruned = pruneDays(map);
  save(user, map);
  // The day just written can be the day just pruned (see the invariant above):
  // older than every one of the MAX_DAYS days already in the store, it is gone
  // before this function returns. Saying `ok:true` for a row that no longer
  // exists is the exact failure this file is being cleared of.
  if (pruned.includes(date)) {
    return { ok: false, date, stored: 0, dropped: 1, metrics: {}, pruned: { days: pruned.length },
      error: `${date} is older than every one of the ${MAX_DAYS} days this store keeps — nothing was retained · ${date} 早于保留期(${MAX_DAYS}天)内的所有日期，未能保存` };
  }
  return { ok: true, date, stored: 1, dropped: 0, metrics: map[date], ...(pruned.length ? { pruned: { days: pruned.length } } : {}) };
}

// Returns the day keys it removed — retention that reports is the difference
// between "aged out as designed" and "your upload vanished" (R5/R14).
function pruneDays(map) {
  const dates = Object.keys(map).filter((d) => DATE.test(d)).sort();
  const gone = [];
  while (dates.length > MAX_DAYS) { const d = dates.shift(); delete map[d]; gone.push(d); }
  return gone;
}

// ── v2 sample-level ingest ────────────────────────────────────────────────────
// Dedupe key = metric|ts|source (one reading per metric per instant per source —
// HealthKit semantics), so a retried/overlapping Shortcut upload is always safe.
function sampleKey(metric, iso, source) { return `${metric}|${iso}|${source}`; }

// Validate one raw sample → normalized record, or null (invalid).
function normalizeSample(metric, s, unit, source) {
  if (!s || typeof s !== 'object') return null;
  const t = new Date(s.ts); if (isNaN(t)) return null;
  if (typeof s.value !== 'number' || !Number.isFinite(s.value)) return null;
  const rec = { metric, ts: t.toISOString(), value: s.value, unit, source, day: localDateStr(t) };
  if (s.end) { const e = new Date(s.end); if (!isNaN(e)) { rec.end = e.toISOString(); rec.day = localDateStr(e); } } // a sleep session counts on the morning it ENDS
  if (typeof s.stage === 'string' && s.stage) rec.stage = s.stage.slice(0, 24);
  return rec;
}

// v2 ingest: set-union raw samples into per-day files, then refresh the daily
// rollup (health.json) + monthly rollups for every affected day/month.
// Returns { ok, stored, dropped, added, duplicates, updated, rejected, pruned? }
// under the honesty invariant declared with MAX_SAMPLES above. Every rejection
// now carries a `samples` COUNT: "rest dropped" told a caller nothing about
// whether it had lost one reading or eight thousand.
function ingestSamples(user, payload) {
  const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
  if (!metrics.length) return { ok: false, stored: 0, dropped: 0, rejected: [], error: 'no metrics in payload' };
  const defSource = (typeof payload.source === 'string' && payload.source ? payload.source : 'unknown').slice(0, 40);
  const rejected = []; const perDay = new Map(); let total = 0, sawValidMetric = false, dropped = 0;
  const drop = (metric, samples, reason) => { dropped += samples; rejected.push({ metric, samples, reason }); };
  for (const m of metrics) {
    const name = m && typeof m.metric === 'string' ? m.metric : '';
    const list = Array.isArray(m && m.samples) ? m.samples : [];
    if (!METRICS.includes(name)) { drop(name || '(unnamed)', list.length, `unknown metric — enabled set: ${METRICS.join(', ')}`); continue; }
    sawValidMetric = true;
    const unit = (typeof m.unit === 'string' ? m.unit : '').slice(0, 16);
    const source = (typeof m.source === 'string' && m.source ? m.source : defSource).slice(0, 40);
    let bad = 0;
    for (let i = 0; i < list.length; i++) {
      // At the cap the REST of this metric goes, and so does every later metric
      // — count them exactly, per metric, instead of noting that a cap was hit.
      if (total >= MAX_SAMPLES) { drop(name, list.length - i, `sample cap ${MAX_SAMPLES} reached — ${list.length - i} sample(s) NOT stored; send fewer per upload`); break; }
      const rec = normalizeSample(name, list[i], unit, source);
      if (!rec) { bad++; continue; }
      total++;
      if (!perDay.has(rec.day)) perDay.set(rec.day, []);
      perDay.get(rec.day).push(rec);
    }
    if (bad) drop(name, bad, `${bad} invalid sample(s) skipped (need ts + finite value)`);
  }
  if (!sawValidMetric) return { ok: false, stored: 0, dropped, rejected, error: 'no valid metrics' };
  let added = 0, duplicates = 0, updated = 0;
  fs.mkdirSync(samplesDir(user), { recursive: true });
  const map = loadForUpdate(user);   // parsed ONCE per ingest; every day rolls up into it, saved once below
  for (const [day, recs] of perDay) {
    const f = dayFile(user, day);
    // Same empty-overwrite guard per day file: a damaged day must not be
    // silently replaced by the handful of samples in this one upload.
    const store = readJsonForUpdate(f, {}, { expect: isMap });
    for (const rec of recs) {
      const k = sampleKey(rec.metric, rec.ts, rec.source);
      const prev = store[k];
      if (prev) {
        // Byte-identical retry → duplicate (idempotent upload). A DIFFERENT
        // value under the same key is a revised/corrected export (day-bucket
        // re-exports grow through the day) → last write wins, reported as
        // `updated` — first-write-wins kept stale readings forever.
        if (JSON.stringify(prev) === JSON.stringify(rec)) { duplicates++; continue; }
        updated++;
      } else added++;
      store[k] = rec;
    }
    writeFileAtomic(f, JSON.stringify(store, null, 1));   // atomic (R3) — a torn day file is what made the guard above necessary
    rollupDay(map, day, store);
  }
  const prunedDays = pruneDays(map);
  save(user, map);
  rollupMonths(user, [...perDay.keys()], map);
  const prunedFiles = pruneSampleFiles(user);
  // RETENTION EVICTION（保留期淘汰）— the day this upload just wrote can be the
  // day retention just deleted (the invariant above spells out why). Those
  // samples were added and are already gone, so they are DROPPED, not stored.
  let evicted = 0;
  for (const day of [...perDay.keys()].sort()) {
    if (!prunedDays.includes(day) && !prunedFiles.includes(day)) continue;
    const n = perDay.get(day).length;
    evicted += n;
    dropped += n;
    rejected.push({ metric: '(retention)', samples: n, day, reason: `${day} fell outside the ${MAX_DAYS}-day retention window and was evicted again before this upload returned` });
  }
  const stored = added + duplicates + updated - evicted;
  const out = { ok: dropped === 0, stored, dropped, added, duplicates, updated, rejected };
  if (prunedDays.length || prunedFiles.length) out.pruned = { days: prunedDays.length, files: prunedFiles.length };
  if (dropped) {
    out.status = stored > 0 ? HTTP_PARTIAL : 400;
    out.code = stored > 0 ? 'partial' : 'nothing_stored';
    out.error = `${dropped} of ${stored + dropped} sample(s) were NOT stored · ${stored + dropped} 条中有 ${dropped} 条未保存 — see the rejected list`;
  }
  return out;
}

// Sleep stage classes. Apple Health exports OVERLAPPING records for one night:
// an inBed span PLUS per-stage spans (core/rem/deep/awake) — summing them all
// roughly doubled sleepMinutes and counted lying awake as sleep.
//   asleep-class (counted): core / rem / deep / asleep / asleepUnspecified,
//                           and stageless records (plain duration exports);
//   inBed:                  fallback ONLY when a day has no asleep-class record;
//   awake:                  never counted.
function sleepClass(rec) {
  const s = String(rec.stage || '').toLowerCase().replace(/[^a-z]/g, '');
  if (s.includes('awake')) return 'awake';
  if (s === 'inbed') return 'inbed';
  return 'asleep';
}

// Recompute one day's aggregates from its raw samples into the SAME daily map
// v1 writes (health.json) — steps total, asleep minutes, latest weight — so
// GET /api/health and the existing apps see richer data, zero contract change.
// One O(n) pass; the CALLER owns the map (loaded and saved once per ingest).
function rollupDay(map, day, store) {
  let steps = 0, hasSteps = false, asleepMin = 0, hasAsleep = false, inBedMin = 0, hasInBed = false;
  let weight = null, weightTs = '';
  for (const r of Object.values(store)) {
    if (r.metric === 'steps') { steps += r.value; hasSteps = true; }
    else if (r.metric === 'sleep') {
      const c = sleepClass(r);
      if (c === 'asleep') { asleepMin += r.value; hasAsleep = true; }
      else if (c === 'inbed') { inBedMin += r.value; hasInBed = true; }
      // 'awake' spans intentionally fall through — never counted
    } else if (r.metric === 'weight' && (!weightTs || r.ts > weightTs)) { weight = r.value; weightTs = r.ts; }
  }
  const agg = {};
  if (hasSteps) agg.steps = Math.round(steps);
  if (hasAsleep) agg.sleepMinutes = Math.round(asleepMin);
  else if (hasInBed) agg.sleepMinutes = Math.round(inBedMin);   // inBed only when nothing better exists
  if (weightTs) agg.weight = weight;
  map[day] = { ...(map[day] || {}), ...agg, updated: Date.now() };
}

// Monthly rollups (design decision Q5): kept INDEFINITELY after the 120-day raw
// window — long series serve the longevity mission; rollups are tiny.
// CONSERVATIVE MERGE (R13 data-loss finding): a month is recomputed from the
// daily map ONLY while the map still holds at least as many of its days as the
// stored rollup covers. A backfilled stray sample for an already-rolled-up,
// partially/fully pruned month therefore leaves the stored rollup untouched —
// "kept indefinitely" history is never degraded to fewer-day aggregates.
function rollupMonths(user, days, map) {
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  if (!months.length) return;
  // Rollups are kept INDEFINITELY, so they are the most valuable file here and
  // the least recoverable: read-before-write, never the lenient reader.
  const monthly = readJsonForUpdate(monthlyFile(user), {}, { expect: isMap });
  for (const mo of months) {
    // Sorted DATE order (not JSON insertion order), so weightLast below is the
    // month's latest calendar day even after an out-of-order backfill.
    const rows = Object.keys(map).filter((d) => d.startsWith(mo)).sort().map((d) => map[d]);
    const prev = monthly[mo];
    if (prev && typeof prev.days === 'number' && prev.days > rows.length) continue; // stored rollup saw more days than the window still holds — keep it
    const vals = (k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const avg = (a) => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
    const w = vals('weight');
    monthly[mo] = { days: rows.length, stepsAvg: avg(vals('steps')), sleepMinutesAvg: avg(vals('sleepMinutes')),
      weightAvg: avg(w), weightLast: w.length ? w[w.length - 1] : null, updated: Date.now() };
  }
  writeJsonFile(monthlyFile(user), monthly);   // atomic (R3)
}

// Raw per-day sample files follow the same 120-day retention as the daily map.
// Returns the DAYS it deleted (not the filenames), so the caller can tell
// whether an upload it just accepted is among them — lib/meals.mjs
// pruneMealMonths reports its counts the same way, and the route audits them.
function pruneSampleFiles(user) {
  const d = samplesDir(user);
  let names; try { names = fs.readdirSync(d); } catch { return []; } // no dir yet — nothing to prune
  const days = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  const gone = [];
  while (days.length > MAX_DAYS) { const f = days.shift(); fs.rmSync(path.join(d, f), { force: true }); gone.push(f.replace(/\.json$/, '')); }
  return gone;
}

// Most-recent `days` days, oldest→newest, each row is { date, ...metrics }.
export function recentHealth(user, days = 7) {
  const map = load(user);
  const n = Math.max(1, Math.min(Number(days) || 7, MAX_DAYS));
  return Object.keys(map).filter((d) => DATE.test(d)).sort().slice(-n).map((d) => ({ date: d, ...map[d] }));
}

// Monthly rollups, oldest→newest — { month: 'YYYY-MM', ...aggregates }.
export function monthlyRollups(user) {
  const monthly = readJson(monthlyFile(user), {});
  return Object.keys(monthly).sort().map((mo) => ({ month: mo, ...monthly[mo] }));
}
