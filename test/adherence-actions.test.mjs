// Adherence loop（跟进闭环）— executors + weekly-brief wiring. The approval
// loop runs FOR REAL here: proposeAction → approveAction → lib/actions.mjs
// executors mutate a reminders.json, and healthBriefBody composes the brief
// with the real suppression predicate. Workspaces are throwaway mkdtemp dirs
// (never live data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkUser } from './helpers.mjs';
import { ACTION_TYPES, executeAction, isFlagSuppressed, recordReminderRetirement, latestRetirement,
  RETIRED_COOLDOWN_DAYS } from '../lib/actions.mjs';
import { proposeAction, approveAction, denyAction, setActionStatus, loadActions, pendingActions } from '../lib/autonomy.mjs';
import { addReminder, loadReminders, removeReminder } from '../lib/reminders.mjs';
import { healthBriefBody } from '../lib/health-analyze.mjs';
import { ingestHealth } from '../lib/health.mjs';
import { DAY_MS } from '../lib/schedule.mjs';

const NOW = new Date(2026, 7, 30, 12);
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const THRESH = { steps_min_daily: 5000, sleep_min_minutes: 240, weight_delta_kg_7d: 5 };
function seedRows(u, fn) { for (let n = 30; n >= 1; n--) { const r = fn(n); if (r) ingestHealth(u, { date: day(n), ...r }); } }

// ── Executors（执行器）────────────────────────────────────────────────────────

test('adjust-reminder-time round-trip: approve → the reminder time really changes', async () => {
  const u = mkUser('adh-');
  addReminder(u, { id: 'rem1', text: 'Walk · 散步', time: '18:00' });
  proposeAction(u, { id: 'p1', type: 'adjust-reminder-time', title: 'Adjust · 调整',
    payload: { flag: 'adherence_rem1', reminderId: 'rem1', time: '07:30' }, created: Date.now() });
  const done = await approveAction(u, 'p1', { execute: executeAction });
  assert.equal(done.status, 'done');
  assert.match(done.result.note, /18:00 → 07:30/);
  assert.equal(loadReminders(u)[0].time, '07:30');
});

test('adjust with unknown reminder or invalid time → honest failed status, nothing changed', async () => {
  const u = mkUser('adh-');
  addReminder(u, { id: 'rem1', text: 'Walk · 散步', time: '18:00' });
  proposeAction(u, { id: 'p1', type: 'adjust-reminder-time', title: 'x',
    payload: { flag: 'f1', reminderId: 'nope', time: '07:30' }, created: Date.now() });
  const f1 = await approveAction(u, 'p1', { execute: executeAction });
  assert.equal(f1.status, 'failed');
  assert.match(f1.error, /未找到提醒/);
  proposeAction(u, { id: 'p2', type: 'adjust-reminder-time', title: 'x',
    payload: { flag: 'f2', reminderId: 'rem1', time: '25:99' }, created: Date.now() });
  const f2 = await approveAction(u, 'p2', { execute: executeAction });
  assert.equal(f2.status, 'failed');
  assert.equal(loadReminders(u)[0].time, '18:00', 'an invalid time is never written');
});

test('retire-reminder round-trip: approve → reminder gone; unknown id fails honestly', async () => {
  const u = mkUser('adh-');
  addReminder(u, { id: 'rem1', text: 'Walk · 散步', time: '18:00' });
  proposeAction(u, { id: 'p1', type: 'retire-reminder', title: 'Retire · 移除',
    payload: { flag: 'adherence_rem1', reminderId: 'rem1' }, created: Date.now() });
  const done = await approveAction(u, 'p1', { execute: executeAction });
  assert.equal(done.status, 'done');
  assert.match(done.result.note, /提醒已移除/);
  assert.deepEqual(loadReminders(u), []);
  proposeAction(u, { id: 'p2', type: 'retire-reminder', title: 'x',
    payload: { flag: 'f', reminderId: 'rem1' }, created: Date.now() });
  const f = await approveAction(u, 'p2', { execute: executeAction });
  assert.equal(f.status, 'failed');
  assert.match(f.error, /未找到提醒/);
});

test('new types registered non-outward; NOT in any pre-approved default', () => {
  for (const t of ['adjust-reminder-time', 'retire-reminder']) {
    assert.ok(ACTION_TYPES[t], `${t} registered`);
    assert.equal(ACTION_TYPES[t].outward, false);
  }
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const pre = example.preapproved_action_types || [];
  assert.ok(!pre.includes('adjust-reminder-time') && !pre.includes('retire-reminder'),
    'adherence follow-ups stay approval-gated by default');
});

// ── Weekly-brief wiring（接线）───────────────────────────────────────────────

// An executed create-reminder 15 days old (beyond the executed cooldown), with
// flat sub-threshold steps: the adherence verdict is "no change" → adjust.
function seedIntervention(u) {
  const created = NOW.getTime() - 15 * DAY_MS;
  seedRows(u, (n) => ({ steps: n > 15 ? 4900 : 4800, ...(n % 2 === 0 ? { sleepMinutes: 400 } : {}), weight: 70 }));
  addReminder(u, { id: 'hb-0-a0', text: 'Walk 20 minutes · 散步20分钟', time: '18:00', created });
  proposeAction(u, { id: 'hb-0-a0', type: 'create-reminder', title: 'Walk · 散步',
    payload: { flag: 'steps_min_daily', text: 'Walk 20 minutes · 散步20分钟', time: '18:00' }, created });
  setActionStatus(u, 'hb-0-a0', 'done', { decided: created, done: created });
  return created;
}
const briefDeps = (u) => ({ llm: async () => '- keep walking 坚持散步', thresholds: THRESH,
  now: NOW, manual: false, isSuppressed: (f) => isFlagSuppressed(u, f, NOW.getTime()) });

test('weekly brief carries the adherence section + adjust proposal; the active flag is not re-proposed as create-reminder', async () => {
  const u = mkUser('adh-');
  seedIntervention(u);
  const out = await healthBriefBody(u, briefDeps(u));
  assert.match(out.body, /## Adherence · 跟进/);
  assert.match(out.body, /no change after 15 days/);
  const types = out.actions.map((a) => a.type);
  assert.ok(types.includes('adjust-reminder-time'));
  assert.ok(!types.includes('create-reminder'),
    'an active reminder owns its flag — the steps breach must not re-propose creation even though the 14d executed cooldown lapsed');
});

test('denied adjustment suppresses the LINE too — no weekly nag until the cooldown lapses (R13 finding 18)', async () => {
  const u = mkUser('adh-');
  seedIntervention(u);
  proposeAction(u, { id: 'adj-1', type: 'adjust-reminder-time', title: 'Adjust · 调整',
    payload: { flag: 'adherence_hb-0-a0', reminderId: 'hb-0-a0', time: '07:30' }, created: NOW.getTime() - DAY_MS });
  denyAction(u, 'adj-1', NOW.getTime() - DAY_MS);
  const out = await healthBriefBody(u, briefDeps(u));
  assert.ok(!out.actions.some((a) => a.type === 'adjust-reminder-time'), 'denied within DENIED_COOLDOWN_DAYS → suppressed');
  assert.ok(!out.body.includes('no change after'), 'the no-change nag text is silenced with its denied proposal');
  assert.ok(!out.body.includes('Adherence'), 'no lines left → no section at all');
  assert.ok(!out.actions.some((a) => a.type === 'create-reminder' && a.payload.flag === 'steps_min_daily'),
    'the silenced flag is still OWNED — create-reminder is not re-proposed either');
});

test('no interventions → no Adherence section at all', async () => {
  const u = mkUser('adh-');
  seedRows(u, () => ({ steps: 6000, sleepMinutes: 400, weight: 70 }));
  const out = await healthBriefBody(u, { llm: async () => '- ok 好', thresholds: THRESH, now: NOW, manual: false });
  assert.ok(!out.body.includes('Adherence'));
});

// ── R13 review regressions（审查回归）— the loop runs for REAL here ──────────

test('execCreateReminder stamps the producer flag onto the reminder — the adherence join key', async () => {
  const u = mkUser('adh-');
  proposeAction(u, { id: 'c1', type: 'create-reminder', title: 'x',
    payload: { flag: 'steps_min_daily', text: 'Walk · 散步', time: '18:00' }, created: Date.now() });
  const done = await approveAction(u, 'c1', { execute: executeAction });
  assert.equal(done.status, 'done');
  assert.equal(loadReminders(u)[0].flag, 'steps_min_daily');
});

test('approved retirement enters the ORIGINAL flag\'s cooldown — the next brief does NOT re-propose it', async () => {
  const u = mkUser('adh-');
  seedRows(u, () => ({ steps: 6000, weight: 70 }));              // sleep data absent throughout
  const created = NOW.getTime() - 20 * DAY_MS;                   // past EXECUTED_COOLDOWN_DAYS
  addReminder(u, { id: 'g1', text: 'Check the Health Shortcut sync · 检查健康快捷指令同步',
    time: '09:00', day: 6, flag: 'gap_sleep', created });
  proposeAction(u, { id: 'g1', type: 'create-reminder', title: 'x',
    payload: { flag: 'gap_sleep', text: 'Check the Health Shortcut sync · 检查健康快捷指令同步', time: '09:00', day: 6 }, created });
  setActionStatus(u, 'g1', 'done', { decided: created, done: created });
  // The retire follow-up, approved through the REAL loop 2 days ago — its done
  // record carries retiredFlag (lib/adherence.mjs proposals always do).
  proposeAction(u, { id: 'ret1', type: 'retire-reminder', title: 'x',
    payload: { flag: 'adherence_g1', reminderId: 'g1', retiredFlag: 'gap_sleep' }, created: NOW.getTime() - 2 * DAY_MS });
  const done = await approveAction(u, 'ret1', { execute: executeAction, now: NOW.getTime() - 2 * DAY_MS });
  assert.equal(done.status, 'done');
  assert.deepEqual(loadReminders(u), []);
  assert.ok(isFlagSuppressed(u, 'gap_sleep', NOW.getTime()), 'retiredRecently holds the flag');
  const out = await healthBriefBody(u, briefDeps(u));
  assert.ok(!(out.actions || []).some((a) => a.type === 'create-reminder'),
    'the reminder the family retired last week is not re-proposed this week');
});

test('manual DELETE-path retirement records the removal: cooldown + a real verdict anchor', () => {
  const u = mkUser('adh-');
  addReminder(u, { id: 'g1', text: 'Check · 检查', time: '09:00', day: 6, flag: 'gap_sleep', created: NOW.getTime() - 20 * DAY_MS });
  const rem = removeReminder(u, 'g1');
  const at = NOW.getTime() - DAY_MS;
  recordReminderRetirement(u, rem, at);
  assert.ok(isFlagSuppressed(u, 'gap_sleep', NOW.getTime()), 'deleting by hand is an answer — no immediate re-proposal');
  assert.deepEqual(latestRetirement(loadActions(u), 'gap_sleep'), { at }, 'the verdict anchors to the real removal date');
  assert.equal(pendingActions(u).length, 0, 'the record is history, never an approvable action');
});

test('retirement cooldown LAPSES like a denial — suppression is a window, not forever', () => {
  const u = mkUser('adh-');
  addReminder(u, { id: 'g1', text: 'Check · 检查', time: '09:00', flag: 'gap_sleep', created: NOW.getTime() - 60 * DAY_MS });
  recordReminderRetirement(u, removeReminder(u, 'g1'), NOW.getTime() - (RETIRED_COOLDOWN_DAYS + 1) * DAY_MS);
  assert.ok(!isFlagSuppressed(u, 'gap_sleep', NOW.getTime()));
});

test('adjust executor stamps adjustedAt + triedTimes — the loop measures the adjustment and never re-tries a slot', async () => {
  const u = mkUser('adh-');
  addReminder(u, { id: 'rem1', text: 'Walk · 散步', time: '18:00', flag: 'steps_min_daily', created: NOW.getTime() - 20 * DAY_MS });
  proposeAction(u, { id: 'p1', type: 'adjust-reminder-time', title: 'x',
    payload: { flag: 'adherence_rem1', reminderId: 'rem1', time: '07:30' }, created: Date.now() });
  const done = await approveAction(u, 'p1', { execute: executeAction });
  assert.equal(done.status, 'done');
  const rem = loadReminders(u)[0];
  assert.equal(rem.time, '07:30');
  assert.equal(typeof rem.adjustedAt, 'number', 're-baseline anchor recorded');
  assert.deepEqual(rem.triedTimes, ['18:00'], 'the slot being left is proven ineffective — never re-proposed');
});
