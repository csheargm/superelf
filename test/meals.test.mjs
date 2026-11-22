// Meal photo logging（拍照记录饮食, PLAN.md capability #3) — ingest core.
// The vision lane is ALWAYS a stub at the injection seam (deps.vision — the
// same seam web.mjs mealVision fills); replies include valid + malformed JSON
// and thrown lane errors so the schema guard and the R14 honest-failure path
// run for real. NEVER a real vision call in tests; throwaway workspaces only.
process.env.TZ = 'Asia/Shanghai';   // slot/date bucketing is local-time; pin it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mealSlot, parseMealReply, extractMeal, ingestMealPhoto, appendMeal, recentMeals,
  MEAL_PROMPT, MEAL_FLAGS, MAX_PHOTO_BYTES, MAX_MEALS_PER_MONTH } from '../lib/meals.mjs';

const mkUser = () => ({ id: 'owner', workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'meals-')) });
const VALID = JSON.stringify({ is_food: true, items: ['rice', 'stir-fried greens'],
  carb_heavy: true, fried: false, sugary_drink: false, vegetables_present: true });
const visionOf = (replies) => { // scripted stub: each call shifts the next reply (a function throws)
  const calls = [];
  const vision = async (prompt, b64) => {
    calls.push({ prompt, b64 });
    const r = replies.shift();
    if (typeof r === 'function') return r();
    return r;
  };
  return { vision, calls };
};
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64'); // PNG magic + IHDR start — enough for a stored-bytes check

test('mealSlot: local-time boundaries land in the named slots', () => {
  const at = (h, m) => new Date(2026, 8, 1, h, m);
  assert.equal(mealSlot(at(8, 0)), 'breakfast');
  assert.equal(mealSlot(at(10, 30)), 'lunch', '10:30 boundary belongs to lunch');
  assert.equal(mealSlot(at(12, 31)), 'lunch');
  assert.equal(mealSlot(at(15, 30)), 'snack', 'mid-afternoon gap is snack');
  assert.equal(mealSlot(at(20, 40)), 'dinner');
  assert.equal(mealSlot(at(23, 0)), 'dinner', 'late dinner IS the signal — dinner runs to midnight');
  assert.equal(mealSlot(at(23, 59)), 'dinner', '23:59 is still dinner, not snack');
  assert.equal(mealSlot(at(0, 30)), 'snack', 'past midnight is snack (next calendar day)');
  assert.equal(mealSlot(at(2, 0)), 'snack');
});

test('parseMealReply: strict valid JSON parses; a code fence is tolerated', () => {
  const p = parseMealReply(VALID);
  assert.equal(p.isFood, true);
  assert.deepEqual(p.items, ['rice', 'stir-fried greens']);
  assert.deepEqual(p.flags, { carb_heavy: true, fried: false, sugary_drink: false, vegetables_present: true });
  assert.ok(parseMealReply('```json\n' + VALID + '\n```'), 'fenced reply still parses');
});

test('parseMealReply: schema violations return null, never a guessed record', () => {
  assert.equal(parseMealReply('I see rice and vegetables.'), null, 'prose is not JSON');
  assert.equal(parseMealReply('[1,2]'), null, 'array is not the schema');
  const j = JSON.parse(VALID);
  for (const f of MEAL_FLAGS) {
    const miss = { ...j }; delete miss[f];
    assert.equal(parseMealReply(JSON.stringify(miss)), null, `missing flag ${f} rejected`);
    assert.equal(parseMealReply(JSON.stringify({ ...j, [f]: 'yes' })), null, `string flag ${f} rejected`);
  }
  assert.equal(parseMealReply(JSON.stringify({ ...j, is_food: 1 })), null);
  assert.equal(parseMealReply(JSON.stringify({ ...j, items: 'rice' })), null);
});

test('parseMealReply: real item names are sanitized in place; junk items reject the reply', () => {
  const j = JSON.parse(VALID);
  j.items = ['a\nb‮ evil', 'ok'];
  const p = parseMealReply(JSON.stringify(j));
  assert.deepEqual(p.items, ['a b evil', 'ok'], 'controls stripped, real names kept (≤40 chars each)');
  j.items = ['ok', 7];
  assert.equal(parseMealReply(JSON.stringify(j)), null, 'one junk item rejects the whole reply — strict, never absorbed (R14)');
});

test('extractMeal: valid first reply → analyzed:true in ONE call', async () => {
  const { vision, calls } = visionOf([VALID]);
  const r = await extractMeal(vision, PNG_B64);
  assert.equal(r.analyzed, true);
  assert.equal(r.isFood, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, MEAL_PROMPT);
  assert.equal(calls[0].b64, PNG_B64, 'the photo reaches the lane');
});

test('extractMeal: malformed then valid → ONE retry with the corrective note', async () => {
  const { vision, calls } = visionOf(['Sure! The meal has rice.', VALID]);
  const r = await extractMeal(vision, PNG_B64);
  assert.equal(r.analyzed, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.startsWith(MEAL_PROMPT) && /not valid JSON/.test(calls[1].prompt));
});

test('extractMeal: malformed twice → analyzed:false with the schema-guard reason (R14)', async () => {
  const { vision, calls } = visionOf(['nope', 'still nope']);
  const r = await extractMeal(vision, PNG_B64);
  assert.equal(r.analyzed, false);
  assert.match(r.reason, /schema guard twice/);
  assert.match(r.reason, /两次未通过/);
  assert.equal(calls.length, 2, 'exactly one retry, never more');
});

test('extractMeal: lane error → analyzed:false carrying the error, never a throw', async () => {
  const { vision } = visionOf([() => { throw new Error('Ollama HTTP 502'); }]);
  const r = await extractMeal(vision, PNG_B64);
  assert.equal(r.analyzed, false);
  assert.match(r.reason, /vision lane failed/);
  assert.match(r.reason, /Ollama HTTP 502/);
});

test('ingestMealPhoto: photo stored via the uploads store, structured record appended', async () => {
  const u = mkUser();
  const now = new Date(2026, 8, 1, 12, 31);
  const { vision } = visionOf([VALID]);
  const r = await ingestMealPhoto(u, { data: 'data:image/jpeg;base64,' + PNG_B64, name: 'IMG 0001.jpg', note: 'family\nlunch' }, { vision, now });
  assert.equal(r.ok, true);
  const rec = r.record;
  assert.equal(rec.date, '2026-09-01');
  assert.equal(rec.time, '12:31');
  assert.equal(rec.slot, 'lunch');
  assert.equal(rec.analyzed, true);
  assert.equal(rec.note, 'family lunch', 'note sanitized to one line');
  assert.match(rec.photo, /^uploads\/\d+_meal_[0-9a-f]{8}_IMG_0001\.jpg$/, '/api/upload naming mechanics + collision-proof random suffix');
  assert.match(rec.id, /^meal-\d+-[0-9a-f]{8}$/, 'id carries the same random suffix');
  assert.deepEqual(fs.readFileSync(path.join(u.workspace, rec.photo)), Buffer.from(PNG_B64, 'base64'), 'stored bytes = decoded photo');
  const stored = JSON.parse(fs.readFileSync(path.join(u.workspace, 'meals', '2026-09.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, rec.id);
});

test('ingestMealPhoto: bad payloads rejected, nothing stored', async () => {
  const u = mkUser();
  const { vision, calls } = visionOf([VALID]);
  assert.equal((await ingestMealPhoto(u, {}, { vision })).ok, false, 'missing data');
  assert.equal((await ingestMealPhoto(u, { data: 'not*base64!' }, { vision })).ok, false, 'invalid base64 charset');
  const big = Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64');
  const r = await ingestMealPhoto(u, { data: big }, { vision });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large · 照片过大/);
  assert.ok(!fs.existsSync(path.join(u.workspace, 'meals')), 'no records written');
  assert.ok(!fs.existsSync(path.join(u.workspace, 'uploads')), 'no photos written');
  assert.equal(calls.length, 0, 'the lane never sees a rejected payload');
});

test('ingestMealPhoto: vision failure still saves an HONEST record (R14)', async () => {
  const u = mkUser();
  const { vision } = visionOf([() => { throw new Error('lane down'); }]);
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision, now: new Date(2026, 8, 1, 19, 0) });
  assert.equal(r.ok, true, 'the photo lands even when analysis fails');
  assert.equal(r.record.analyzed, false);
  assert.match(r.record.reason, /lane down/);
  assert.equal(r.record.items, undefined, 'no invented extraction');
  assert.equal(r.record.slot, 'dinner');
});

test('appendMeal: at the month cap the append REFUSES loudly — eviction is gone', () => {
  const u = mkUser();
  for (let i = 0; i < MAX_MEALS_PER_MONTH; i++) {
    appendMeal(u, { id: `m${i}`, ts: i, date: '2026-09-01', time: '12:00', slot: 'lunch', photo: 'x', analyzed: false, reason: 'r' });
  }
  assert.throws(() => appendMeal(u, { id: 'overflow', ts: 9e9, date: '2026-09-01', time: '12:00', slot: 'lunch', photo: 'x', analyzed: false, reason: 'r' }),
    /at cap/, 'the ingest refuses first (429); this throw is the loud backstop, never silent eviction');
  const stored = JSON.parse(fs.readFileSync(path.join(u.workspace, 'meals', '2026-09.json'), 'utf8'));
  assert.equal(stored.length, MAX_MEALS_PER_MONTH);
  assert.equal(stored[0].id, 'm0', 'oldest record intact');
});

test('recentMeals: 7-day window spans a month boundary and sorts by time', () => {
  const u = mkUser();
  const now = new Date(2026, 8, 3, 12, 0);   // 2026-09-03: window reaches into August
  const at = (mo, d, h) => new Date(2026, mo, d, h, 0).getTime();
  appendMeal(u, { id: 'aug', ts: at(7, 29, 18), date: '2026-08-29', time: '18:00', slot: 'dinner', photo: 'x', analyzed: true, isFood: true, items: [], flags: {} });
  appendMeal(u, { id: 'sep', ts: at(8, 2, 8), date: '2026-09-02', time: '08:00', slot: 'breakfast', photo: 'x', analyzed: true, isFood: true, items: [], flags: {} });
  appendMeal(u, { id: 'old', ts: at(7, 20, 12), date: '2026-08-20', time: '12:00', slot: 'lunch', photo: 'x', analyzed: true, isFood: true, items: [], flags: {} });
  const rows = recentMeals(u, 7, now);
  assert.deepEqual(rows.map((r) => r.id), ['aug', 'sep'], 'both months read; out-of-window row excluded');
});
