// Persistent reminders (lib/reminders.mjs) — what an approved create-reminder
// action registers, ticked on the job-engine core (dueJobs + job-runs marks).
// Workspaces are throwaway mkdtemp dirs — never a live instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadReminders, addReminder, removeReminder, updateReminderTime, remindersTick } from '../lib/reminders.mjs';
import { readJobRuns } from '../lib/jobruns.mjs';
import { mkAudit, mkUser as mkSharedUser } from './helpers.mjs';

const mkUser = () => mkSharedUser('rem-');
const LONG_AGO = new Date(2026, 0, 1).getTime(); // created well before every tick below → the first-fire gate never defers
const remindersFile = (u) => path.join(u.workspace, 'reminders.json');

test('addReminder: validates id, text, HH:MM time, weekday; idempotent by id', () => {
  const u = mkUser();
  assert.throws(() => addReminder(u, { id: '../evil', text: 'x', time: '08:00' }), /id invalid/);
  assert.throws(() => addReminder(u, { id: 'r1', text: '', time: '08:00' }), /提醒内容/);
  assert.throws(() => addReminder(u, { id: 'r1', text: 'y'.repeat(201), time: '08:00' }), /max 200/);
  assert.throws(() => addReminder(u, { id: 'r1', text: 'x', time: '25:00' }), /HH:MM/);
  assert.throws(() => addReminder(u, { id: 'r1', text: 'x', time: '08:00', day: 7 }), /0 \(Sun\) - 6/);
  const a = addReminder(u, { id: 'r1', text: 'Walk 散步 ', time: '18:00' });
  assert.equal(a.text, 'Walk 散步', 'trimmed');
  const dup = addReminder(u, { id: 'r1', text: 'different', time: '09:00' });
  assert.equal(dup.text, 'Walk 散步', 'same id returns the existing reminder — approve retries never duplicate');
  assert.equal(loadReminders(u).length, 1);
});

test('addReminder: SEMANTIC dedupe — a re-proposed flag approved under a fresh action id never stacks an identical reminder', () => {
  const u = mkUser();
  addReminder(u, { id: 'health-brief-T1-a0', text: 'Walk 20 minutes · 散步20分钟', time: '18:00' });
  // Week 2: same flag re-proposed → new briefing id → new action id. Id-only
  // dedupe registered a second identical 18:00 nag (R13 finding).
  const again = addReminder(u, { id: 'health-brief-T2-a0', text: 'Walk 20 minutes · 散步20分钟', time: '18:00' });
  assert.equal(again.id, 'health-brief-T1-a0', 'the existing reminder is returned');
  assert.equal(loadReminders(u).length, 1, 'no duplicate');
  addReminder(u, { id: 'health-brief-T3-a0', text: 'Walk 20 minutes · 散步20分钟', time: '19:00' });
  assert.equal(loadReminders(u).length, 2, 'a genuinely different time is a different reminder');
});

test('removeReminder: the off switch — removed reminders never fire again; unknown id reported honestly', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '18:00', created: LONG_AGO });
  assert.equal(removeReminder(u, 'nope'), null);
  const gone = removeReminder(u, 'walk');
  assert.equal(gone.id, 'walk');
  assert.deepEqual(loadReminders(u), []);
  const delivered = [];
  await remindersTick({ users: [u], audit: () => {}, deliver: async (_, r) => delivered.push(r.id), now: new Date(2026, 8, 1, 18, 5) });
  assert.deepEqual(delivered, [], 'nothing fires after removal');
});

test('first fire = NEXT occurrence: approved after HH:MM → not today (no hours-late catch-up), tomorrow instead', async () => {
  const u = mkUser();
  // The Sunday 20:00 brief proposes a daily 18:00 walk; the user approves at 20:05.
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '18:00', created: new Date(2026, 8, 1, 20, 5).getTime() });
  const { audit } = mkAudit();
  const delivered = [];
  const deliver = async (_, r) => delivered.push(r.id);
  await remindersTick({ users: [u], audit, deliver, now: new Date(2026, 8, 1, 20, 6) });
  assert.deepEqual(delivered, [], 'no nonsensical 20:06 first firing of an 18:00 reminder');
  assert.equal(readJobRuns(u)['reminder.walk'], '2026-09-01', 'the skipped occurrence is marked — one decision per day');
  await remindersTick({ users: [u], audit, deliver, now: new Date(2026, 8, 2, 18, 5) });
  assert.deepEqual(delivered, ['walk'], 'first delivery is the next real occurrence');
  // Approved BEFORE its time, same day → that day IS the next occurrence.
  const u2 = mkUser();
  addReminder(u2, { id: 'walk', text: 'Walk 散步', time: '18:00', created: new Date(2026, 8, 1, 8, 0).getTime() });
  const d2 = [];
  await remindersTick({ users: [u2], audit, deliver: async (_, r) => d2.push(r.id), now: new Date(2026, 8, 1, 18, 5) });
  assert.deepEqual(d2, ['walk']);
});

test('tick: fires once per local day after HH:MM, marks shared with the job engine', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 20 minutes · 散步20分钟', time: '18:00', created: LONG_AGO });
  const { events, audit } = mkAudit();
  const delivered = [];
  const deliver = async (usr, rem, now) => delivered.push({ id: rem.id, text: rem.text });
  const day1early = new Date(2026, 8, 1, 17, 0), day1late = new Date(2026, 8, 1, 18, 5), day2 = new Date(2026, 8, 2, 18, 5);
  await remindersTick({ users: [u], audit, deliver, now: day1early });
  assert.equal(delivered.length, 0, 'before its time — silent');
  await remindersTick({ users: [u], audit, deliver, now: day1late });
  await remindersTick({ users: [u], audit, deliver, now: day1late });
  assert.equal(delivered.length, 1, 'once per day, not per tick');
  assert.equal(readJobRuns(u)['reminder.walk'], '2026-09-01', 'mark lives in the SAME job-runs store');
  await remindersTick({ users: [u], audit, deliver, now: day2 });
  assert.equal(delivered.length, 2, 'fires again the next day');
  assert.deepEqual(events.filter((e) => e.ev === 'reminder-sent').map((e) => e.reminder), ['walk', 'walk']);
});

test('tick: weekly reminder fires only on its weekday', async () => {
  const u = mkUser();
  addReminder(u, { id: 'chk', text: 'Check Shortcut · 检查快捷指令', time: '09:00', day: 6, created: LONG_AGO });
  const { audit } = mkAudit();
  const delivered = [];
  await remindersTick({ users: [u], audit, deliver: async (_, r) => delivered.push(r.id), now: new Date(2026, 8, 4, 10, 0) }); // Friday
  assert.equal(delivered.length, 0);
  await remindersTick({ users: [u], audit, deliver: async (_, r) => delivered.push(r.id), now: new Date(2026, 8, 5, 10, 0) }); // Saturday
  assert.deepEqual(delivered, ['chk']);
});

test('tick: delivery failure is audited and NOT retried the same day (R5, no minute-spam)', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '08:00', created: LONG_AGO });
  const { events, audit } = mkAudit();
  let attempts = 0;
  const now = new Date(2026, 8, 1, 9, 0);
  await remindersTick({ users: [u], audit, deliver: async () => { attempts++; throw new Error('disk full'); }, now });
  await remindersTick({ users: [u], audit, deliver: async () => { attempts++; throw new Error('disk full'); }, now });
  assert.equal(attempts, 1, 'one attempt per day');
  const fail = events.find((e) => e.ev === 'reminder-failed');
  assert.match(fail.error, /disk full/);
});

test('tick: corrupt reminders.json is surfaced, never treated as "no reminders"', async () => {
  const u = mkUser();
  fs.writeFileSync(remindersFile(u), '{not json');
  const { events, audit } = mkAudit();
  await remindersTick({ users: [u], audit, deliver: async () => {}, now: new Date() });
  assert.equal(events[0].ev, 'reminder-state-error');
  assert.throws(() => loadReminders(u), SyntaxError);
});

test('time gate: while nothing is due by CLOCK, job-runs.json is not even read (jobsTick parity)', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '18:00', created: LONG_AGO });
  fs.writeFileSync(path.join(u.workspace, 'job-runs.json'), '{ corrupt'); // a read would throw + audit
  const { events, audit } = mkAudit();
  await remindersTick({ users: [u], audit, deliver: async () => {}, now: new Date(2026, 8, 1, 10, 0) });
  assert.deepEqual(events, [], 'pre-18:00 tick: marks never touched — the old per-tick read would have errored here');
});

test('mtime cache: an unchanged reminders.json is not re-parsed every tick', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '18:00', created: LONG_AGO });
  const { events, audit } = mkAudit();
  await remindersTick({ users: [u], audit, deliver: async () => {}, now: new Date(2026, 8, 1, 10, 0) }); // caches the parse
  // Corrupt the bytes but pin the mtime: a re-parse would throw; the cache must serve.
  const st = fs.statSync(remindersFile(u));
  fs.writeFileSync(remindersFile(u), '{ corrupt bytes, same mtime');
  fs.utimesSync(remindersFile(u), st.atime, st.mtime);
  const delivered = [];
  await remindersTick({ users: [u], audit, deliver: async (_, r) => delivered.push(r.id), now: new Date(2026, 8, 1, 18, 5) });
  if (fs.statSync(remindersFile(u)).mtimeMs === st.mtimeMs) { // utimes granularity holds on this FS → cache path proven
    assert.deepEqual(delivered, ['walk'], 'served from the cached parse — the old per-tick JSON.parse would have thrown');
    assert.deepEqual(events, []);
  } else { // fs rounded the timestamp → cache correctly invalidates and surfaces the corruption (also valid behavior)
    assert.equal(events[0] && events[0].ev, 'reminder-state-error');
  }
});

// ── R13 review regressions（审查回归）: adjust-time same-day semantics ────────

test('adjust to an EARLIER slot mid-day: NO hours-late catch-up fire today; fires at the new slot tomorrow', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '18:00', created: LONG_AGO });
  const { audit } = mkAudit();
  const delivered = [];
  const deliver = async (_, r, now) => delivered.push({ id: r.id, at: now.toTimeString().slice(0, 5) });
  // Approved at 10:00 — 07:30 has already passed today. The dueJobs catch-up
  // would deliver at 10:01, hours late (the preRegimeOccurrence scar).
  const tenAM = new Date(2026, 8, 1, 10, 0);
  const upd = updateReminderTime(u, 'walk', '07:30', tenAM.getTime());
  assert.equal(upd.prevTime, '18:00');
  await remindersTick({ users: [u], audit, deliver, now: new Date(2026, 8, 1, 10, 1) });
  assert.deepEqual(delivered, [], 'the stale 07:30 occurrence is skipped, not fired at 10:01');
  assert.equal(readJobRuns(u)['reminder.walk'], '2026-09-01', 'skipped occurrence marked — one decision per day');
  await remindersTick({ users: [u], audit, deliver, now: new Date(2026, 8, 2, 7, 31) });
  assert.deepEqual(delivered, [{ id: 'walk', at: '07:31' }], 'first delivery at the NEW slot, next day');
});

test('adjust to a LATER slot mid-day: today\'s old-slot mark is cleared so the new slot fires today', async () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '07:30', created: LONG_AGO });
  const { audit } = mkAudit();
  const delivered = [];
  const deliver = async (_, r) => delivered.push(r.id);
  await remindersTick({ users: [u], audit, deliver, now: new Date(2026, 8, 1, 7, 31) });
  assert.deepEqual(delivered, ['walk'], 'fired at the old slot this morning');
  updateReminderTime(u, 'walk', '18:00', new Date(2026, 8, 1, 10, 0).getTime());
  assert.equal(readJobRuns(u)['reminder.walk'], undefined, 'the same-day mark is cleared — the new slot is still ahead');
  await remindersTick({ users: [u], audit, deliver, now: new Date(2026, 8, 1, 18, 1) });
  assert.deepEqual(delivered, ['walk', 'walk'], 'delivered at the NEW slot the same day');
});

test('updateReminderTime records the adjustment: adjustedAt anchor + the left slot in triedTimes (no repeats)', () => {
  const u = mkUser();
  addReminder(u, { id: 'walk', text: 'Walk 散步', time: '18:00', created: LONG_AGO });
  const t1 = new Date(2026, 8, 1, 10, 0).getTime();
  updateReminderTime(u, 'walk', '07:30', t1);
  let rem = loadReminders(u)[0];
  assert.equal(rem.adjustedAt, t1, 'the adherence windows re-anchor here');
  assert.deepEqual(rem.triedTimes, ['18:00']);
  const t2 = new Date(2026, 8, 20, 10, 0).getTime();
  updateReminderTime(u, 'walk', '18:00', t2); // swung back — both slots now proven tried
  rem = loadReminders(u)[0];
  assert.equal(rem.adjustedAt, t2);
  assert.deepEqual(rem.triedTimes, ['18:00', '07:30'], 'deduped set, insertion order');
});

test('addReminder back-compat: a re-approved flag upgrades a legacy flagless reminder in place', () => {
  const u = mkUser();
  addReminder(u, { id: 'old-a0', text: 'Walk 20 minutes · 散步20分钟', time: '18:00' }); // pre-flag era
  const again = addReminder(u, { id: 'hb-2-a0', text: 'Walk 20 minutes · 散步20分钟', time: '18:00', flag: 'steps_min_daily' });
  assert.equal(again.id, 'old-a0', 'semantic dedupe returns the existing reminder');
  assert.equal(loadReminders(u)[0].flag, 'steps_min_daily', 'the legacy entry gains the adherence join key');
  assert.equal(loadReminders(u).length, 1);
});
