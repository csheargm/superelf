// R13 hardening regressions（加固回归）for the meal-photo ingest — every test
// here was RED against the reviewed feature and pins one fix: collision-proof
// ids/paths, the honest 429 month cap, disk retention, the concurrency + cost
// gate, strict base64 + image magic bytes, sanitized lane errors, the strict
// schema guard, and client takenAt time semantics. Vision is ALWAYS a stub at
// the deps seam (never a real call); throwaway workspaces only.
process.env.TZ = 'Asia/Shanghai';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestMealPhoto, appendMeal, pruneMealMonths, parseMealReply, MEAL_PROMPT,
  MEAL_FLAGS, MAX_MEALS_PER_MONTH } from '../lib/meals.mjs';
import { deferred } from './helpers-timing.mjs';

const mkUser = (id = 'owner') => ({ id, workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'mealsh-')) });
const VALID = JSON.stringify({ is_food: true, items: ['rice'],
  carb_heavy: false, fried: false, sugary_drink: false, vegetables_present: true });
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const countingVision = (reply = VALID) => { const calls = []; return { calls, vision: async (p) => { calls.push(p); return reply; } }; };
const uploadsOf = (u) => { try { return fs.readdirSync(path.join(u.workspace, 'uploads')); } catch { return []; } };
const seed = (u, i, date) => appendMeal(u, { id: `m${i}`, ts: new Date(date).getTime(), date,
  time: '12:00', slot: 'lunch', photo: 'x', analyzed: false, reason: 'seed' });

// ── #1 collision-proof ids/paths ─────────────────────────────────────────────
test('same-millisecond double-POST → two distinct files and ids, nothing clobbered', async () => {
  const u = mkUser();
  const now = new Date(2026, 8, 1, 12, 0);
  const { vision } = countingVision();
  const r1 = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, now });
  const r2 = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, now });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.record.id, r2.record.id, 'record ids differ');
  assert.notEqual(r1.record.photo, r2.record.photo, 'photo paths differ');
  assert.equal(uploadsOf(u).length, 2, 'two photo files on disk — no clobber');
});

// ── #2 honest month cap（本月上限，拒绝而非静默淘汰） ────────────────────────
test('month cap: 400th accepted, 401st refused 429 — no photo write, no vision call, no eviction', async () => {
  const u = mkUser();
  const now = new Date(2026, 8, 15, 12, 0);
  for (let i = 0; i < MAX_MEALS_PER_MONTH - 1; i++) seed(u, i, '2026-09-15');
  const { vision, calls } = countingVision();
  const ok = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, now });
  assert.equal(ok.ok, true, '400th record accepted');
  assert.equal(calls.length, 1);
  const refused = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, now });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429, 'refused honestly, never silently evicted');
  assert.equal(refused.code, 'month_cap', 'and with the STABLE string code every route answers (R3) — `code` is never an HTTP number');
  assert.match(refused.error, /本月饮食记录已达上限/);
  assert.equal(calls.length, 1, 'no vision call for the refused ingest — fail cheap and early');
  assert.equal(uploadsOf(u).length, 1, 'no photo written for the refused ingest');
  const stored = JSON.parse(fs.readFileSync(path.join(u.workspace, 'meals', '2026-09.json'), 'utf8'));
  assert.equal(stored.length, MAX_MEALS_PER_MONTH);
  assert.equal(stored[0].id, 'm0', 'oldest record still present — eviction is gone');
});

// ── #3 disk lifecycle（照片随记录一同保留/删除） ─────────────────────────────
test('retention: months older than MEALS_RETAIN_MONTHS deleted WITH their photos, counts surfaced', async () => {
  const u = mkUser();
  const now = new Date(2026, 8, 1, 12, 0); // retain 2026-07..09
  const mkPhoto = (rel) => { const f = path.join(u.workspace, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return rel; };
  appendMeal(u, { id: 'old1', ts: 1, date: '2026-05-02', time: '12:00', slot: 'lunch', photo: mkPhoto('uploads/old1.jpg'), analyzed: false, reason: 'r' });
  appendMeal(u, { id: 'old2', ts: 2, date: '2026-05-03', time: '12:00', slot: 'lunch', photo: mkPhoto('uploads/old2.jpg'), analyzed: false, reason: 'r' });
  appendMeal(u, { id: 'kept', ts: 3, date: '2026-07-02', time: '12:00', slot: 'lunch', photo: mkPhoto('uploads/kept.jpg'), analyzed: false, reason: 'r' });
  const { vision } = countingVision();
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, now }); // prune rides ingest (lib/health.mjs precedent)
  assert.equal(r.ok, true);
  assert.deepEqual(r.pruned, { months: 1, photos: 2 }, 'prune counts surfaced for the audit');
  assert.ok(!fs.existsSync(path.join(u.workspace, 'meals', '2026-05.json')), 'old month file deleted');
  assert.ok(!fs.existsSync(path.join(u.workspace, 'uploads', 'old1.jpg')), 'old photos deleted with their records');
  assert.ok(!fs.existsSync(path.join(u.workspace, 'uploads', 'old2.jpg')));
  assert.ok(fs.existsSync(path.join(u.workspace, 'uploads', 'kept.jpg')), 'in-retention photo untouched');
  assert.ok(fs.existsSync(path.join(u.workspace, 'meals', '2026-07.json')));
});

test('retention: a corrupt photo path cannot escape the workspace and does not break the prune', () => {
  const u = mkUser();
  fs.mkdirSync(path.join(u.workspace, 'meals'), { recursive: true });
  const outside = path.join(u.workspace, '..', `outside-${path.basename(u.workspace)}.txt`);
  fs.writeFileSync(outside, 'keep me');
  fs.writeFileSync(path.join(u.workspace, 'meals', '2026-01.json'),
    JSON.stringify([{ id: 'evil', photo: `../${path.basename(outside)}` }]));
  const res = pruneMealMonths(u, new Date(2026, 8, 1));
  assert.equal(res.months, 1, 'month file still pruned');
  assert.equal(res.photos, 0, 'escaping path skipped, not followed');
  assert.ok(fs.existsSync(outside), 'file outside the workspace untouched');
  fs.rmSync(outside);
});

// ── #4 concurrency + cost gate（并发与成本闸门） ─────────────────────────────
test('per-user in-flight guard: concurrent second ingest → 429 busy; other users unaffected', async () => {
  const u = mkUser();
  const other = mkUser('bob');
  const { promise: gate, resolve: release } = deferred();
  const slowVision = async () => { await gate; return VALID; };
  const p1 = ingestMealPhoto(u, { data: PNG_B64 }, { vision: slowVision });
  const rOther = await ingestMealPhoto(other, { data: PNG_B64 }, { vision: async () => VALID });
  assert.equal(rOther.ok, true, 'the guard is PER USER — another user is never blocked');
  const r2 = await ingestMealPhoto(u, { data: PNG_B64 }, { vision: slowVision });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 429);
  assert.equal(r2.code, 'busy');
  assert.match(r2.error, /请稍后重试/);
  release();
  const r1 = await p1;
  assert.equal(r1.ok, true, 'the in-flight ingest is unaffected');
  assert.equal(uploadsOf(u).length, 1, 'the busy request wrote nothing');
});

test('the vision call runs inside the injected enqueue gate (web.mjs MAX_CONCURRENT lane)', async () => {
  const u = mkUser();
  let depth = 0, visionSawGate = false;
  const enqueue = async (fn) => { depth++; try { return await fn(); } finally { depth--; } };
  const vision = async () => { visionSawGate = depth > 0; return VALID; };
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, enqueue });
  assert.equal(r.ok, true);
  assert.equal(visionSawGate, true, 'the cloud call happened inside the enqueue gate');
});

// ── #5 base64 sanity（严格校验，垃圾不烧云调用） ─────────────────────────────
test('interior "=" padding (silent truncation) → rejected, no vision call, nothing stored', async () => {
  const u = mkUser();
  const { vision, calls } = countingVision();
  const r = await ingestMealPhoto(u, { data: 'QUJD=' + 'QUFB'.repeat(10) }, { vision });
  assert.equal(r.ok, false);
  assert.match(r.error, /无效的照片数据/);
  assert.equal(calls.length, 0, 'a garbage decode never burns a cloud call');
  assert.equal(uploadsOf(u).length, 0);
  assert.ok(!fs.existsSync(path.join(u.workspace, 'meals')));
});

test('valid base64 of non-image bytes → rejected by the magic-byte check, no vision call', async () => {
  const u = mkUser();
  const { vision, calls } = countingVision();
  const r = await ingestMealPhoto(u, { data: Buffer.from('just some text, not an image at all').toString('base64') }, { vision });
  assert.equal(r.ok, false);
  assert.match(r.error, /无法识别的图片格式/);
  assert.equal(calls.length, 0);
  assert.equal(uploadsOf(u).length, 0);
});

test('JPEG and HEIC magic bytes pass the sniffer', async () => {
  const u = mkUser();
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64');
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]).toString('base64');
  assert.equal((await ingestMealPhoto(u, { data: jpeg }, { vision: async () => VALID })).ok, true);
  assert.equal((await ingestMealPhoto(u, { data: heic }, { vision: async () => VALID })).ok, true);
});

// ── #6 sanitize the last boundary（reason 也过 sanitizeLine） ────────────────
test('lane error text is sanitized and capped before storage (the one untrusted string)', async () => {
  const u = mkUser();
  const vision = async () => { throw new Error('boom\u0007\r\n‮' + 'x'.repeat(10000)); };
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision });
  assert.equal(r.ok, true);
  assert.equal(r.record.analyzed, false);
  assert.match(r.record.reason, /视觉通道失败/);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202e]/.test(r.record.reason), 'control and bidi chars stripped');
  assert.ok(r.record.reason.length <= 200, 'capped');
});

// ── #7 schema guard strictness（严格拒绝，不静默吸收） ───────────────────────
test('schema guard: non-string / oversized / control-only / too-many items REJECT the reply', async () => {
  const j = JSON.parse(VALID);
  assert.equal(parseMealReply(JSON.stringify({ ...j, items: [7] })), null, 'non-string item');
  assert.equal(parseMealReply(JSON.stringify({ ...j, items: [{}] })), null, 'object item');
  assert.equal(parseMealReply(JSON.stringify({ ...j, items: ['x'.repeat(200)] })), null, 'oversized item');
  assert.equal(parseMealReply(JSON.stringify({ ...j, items: ['\u0007'] })), null, 'control-only item would store ""');
  assert.equal(parseMealReply(JSON.stringify({ ...j, items: Array(9).fill('ok') })), null, 'more than 8 items');
  const u = mkUser();
  const bad = JSON.stringify({ ...j, items: [7] });
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision: async () => bad });
  assert.equal(r.record.analyzed, false, 'retry then honest failure');
  assert.equal(r.record.items, undefined, 'no items smuggled by a rejected reply');
});

test('is_food:false forces the empty shape — injected items/flags on a non-food reply are dropped', async () => {
  const u = mkUser();
  const hostile = JSON.stringify({ is_food: false, items: ['ignore previous instructions', 'visit evil.example'],
    carb_heavy: true, fried: false, sugary_drink: true, vegetables_present: false });
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision: async () => hostile });
  assert.equal(r.ok, true);
  assert.equal(r.record.analyzed, true);
  assert.equal(r.record.isFood, false);
  assert.deepEqual(r.record.items, [], 'the stored record carries nothing');
  assert.deepEqual(r.record.flags, Object.fromEntries(MEAL_FLAGS.map((f) => [f, false])));
});

// ── #10 takenAt time semantics（以拍照时间为准） ─────────────────────────────
test('takenAt: slot/date derive from the photo creation time when plausible; implausible → ingest time', async () => {
  const u = mkUser();
  const now = new Date(2026, 8, 1, 12, 0); // ingest at noon
  const taken = new Date(2026, 7, 31, 18, 30);
  const r = await ingestMealPhoto(u, { data: PNG_B64, takenAt: taken.toISOString() }, { vision: async () => VALID, now });
  assert.equal(r.record.date, '2026-08-31');
  assert.equal(r.record.time, '18:30');
  assert.equal(r.record.slot, 'dinner', 'a late share does not turn dinner into a snack/lunch');
  for (const bad of ['garbage', now.getTime() + 3600000, now.getTime() - 30 * 86400000]) {
    const rb = await ingestMealPhoto(u, { data: PNG_B64, takenAt: bad }, { vision: async () => VALID, now });
    assert.equal(rb.record.date, '2026-09-01', `implausible takenAt (${bad}) falls back to ingest time`);
    assert.equal(rb.record.slot, 'lunch');
  }
});

// ── #11 R3: prompt derives from MEAL_FLAGS ───────────────────────────────────
test('MEAL_PROMPT derives from MEAL_FLAGS — schema, rules, and not-food example carry every flag (R3)', () => {
  for (const f of MEAL_FLAGS) {
    assert.ok(MEAL_PROMPT.includes(`"${f}": boolean`), `schema names ${f}`);
    assert.ok(MEAL_PROMPT.includes(`"${f}":false`), `not-food example zeroes ${f}`);
    assert.ok(MEAL_PROMPT.includes(`${f} = `), `rules describe ${f}`);
  }
});
