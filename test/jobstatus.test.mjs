// Jobs view（任务视图）derivation — lib/jobstatus.mjs. The honesty rules under
// test (R14): lastOutcome comes ONLY from the audit log (never a mark), the
// audit scan is BOUNDED, and rows are per-user (another user's entries about
// the same job name must never bleed into this user's status).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanSchedule, nextDueAt, lastOutcome, readAuditTail, jobsView, AUDIT_TAIL_BYTES, lastReport, lastDelivery, ON_DEMAND } from '../lib/jobstatus.mjs';
import { localDateStr } from '../lib/schedule.mjs';

const at = (h, m) => { const d = new Date(2026, 8, 1); d.setHours(h, m, 0, 0); return d; }; // Tue 2026-09-01

test('humanSchedule: bilingual daily and weekly forms', () => {
  assert.equal(humanSchedule({ time: '07:30' }), 'daily · 每日 07:30');
  assert.equal(humanSchedule({ day: 0, time: '20:00' }), 'Sun · 周日 20:00');
  assert.equal(humanSchedule({ day: 6, time: '09:00' }), 'Sat · 周六 09:00');
  assert.equal(humanSchedule(null), '—');
});

test('nextDueAt: daily — before time, catch-up after time, tomorrow once marked', () => {
  const now = at(6, 0);
  assert.equal(nextDueAt({ time: '07:30' }, null, now), at(7, 30).getTime());
  const late = at(8, 0);
  assert.equal(nextDueAt({ time: '07:30' }, null, late), late.getTime(), 'past HH:MM, unmarked → due NOW (same-day catch-up)');
  const marked = nextDueAt({ time: '07:30' }, localDateStr(late), late);
  assert.equal(new Date(marked).getDate(), 2, 'marked today → tomorrow');
  assert.equal(new Date(marked).getHours(), 7);
});

test('nextDueAt: weekly — next weekday; ran on its own day → +7', () => {
  const tue = at(12, 0); // 2026-09-01 is a Tuesday
  const sun = new Date(nextDueAt({ day: 0, time: '20:00' }, null, tue));
  assert.equal(sun.getDay(), 0);
  assert.equal(sun.getDate(), 6, 'next Sunday');
  const tueSched = new Date(nextDueAt({ day: 2, time: '20:00' }, null, tue));
  assert.equal(tueSched.getDate(), 1, 'today IS the day, before time → today');
  const ran = new Date(nextDueAt({ day: 2, time: '20:00' }, localDateStr(tue), tue));
  assert.equal(ran.getDate(), 8, 'ran today → next week');
  assert.equal(nextDueAt({ time: 'junk' }, null, tue), null, 'bad time → null, never NaN');
});

test('lastOutcome: latest relevant entry wins; skipped honest; per-user isolation', () => {
  const entries = [
    { ev: 'job-run', who: 'bob', job: 'daily-brief', skipped: false, at: 't1' }, // another user — must not leak
    { ev: 'job-run', who: 'owner', job: 'daily-brief', skipped: false, at: 't2' },
    { ev: 'job-failed', who: 'owner', job: 'daily-brief', at: 't3' },
    { ev: 'job-run', who: 'owner', job: 'health-brief', skipped: true, at: 't4' },
    { ev: 'reminder-sent', who: 'owner', reminder: 'walk', at: 't5' },
    { ev: 'reminder-failed', who: 'bob', reminder: 'walk', at: 't6' },
  ];
  assert.deepEqual(lastOutcome(entries, 'owner', { job: 'daily-brief' }), { outcome: 'failed', at: 't3' },
    'the failure AFTER the ok wins — never show ok when the audit says failed (R14)');
  assert.deepEqual(lastOutcome(entries, 'owner', { job: 'health-brief' }), { outcome: 'skipped', at: 't4' });
  assert.deepEqual(lastOutcome(entries, 'owner', { reminder: 'walk' }), { outcome: 'ok', at: 't5' },
    "bob's reminder-failed must not shadow owner's reminder-sent");
  assert.deepEqual(lastOutcome(entries, 'bob', { job: 'daily-brief' }), { outcome: 'ok', at: 't1' });
  assert.deepEqual(lastOutcome(entries, 'owner', { job: 'nope' }), { outcome: null, at: null });
});

test('readAuditTail: bounded — reads only the tail of a large log, drops the torn first line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-audit-')); // throwaway, never a live file
  const f = path.join(dir, 'audit.log');
  const line = (i) => JSON.stringify({ at: `t${i}`, ev: 'job-run', who: 'owner', job: 'daily-brief', i }) + '\n';
  let body = '';
  for (let i = 0; i < 5000; i++) body += line(i);
  fs.writeFileSync(f, body);
  assert.ok(body.length > AUDIT_TAIL_BYTES, 'fixture larger than the scan window');
  const tail = readAuditTail(f);
  assert.ok(tail.length > 0 && tail.length < 5000, 'only the tail parsed, not the whole file');
  assert.equal(tail[tail.length - 1].i, 4999, 'newest entry present');
  assert.ok(tail.every((e) => e.ev === 'job-run'), 'no torn half-entries survive');
  const small = readAuditTail(f, 200);
  assert.ok(small.length >= 1 && small.length <= 3, 'window is honored');
  assert.deepEqual(readAuditTail(path.join(dir, 'missing.log')), [], 'no file yet → empty, not a throw');
});

test('jobsView: one row per scheduled job + per reminder; mark can NEVER paint ok over a failed audit', () => {
  const now = at(9, 0);
  const jobs = {
    'daily-brief': { name: 'daily-brief', title: '每日一报 · Daily Brief', schedule: { time: '07:30' } },
    'health-brief': { name: 'health-brief', title: '健康简报 · Weekly Health Brief', schedule: { day: 0, time: '20:00' } },
    'no-schedule': { name: 'no-schedule', title: 'x' }, // unscheduled entries stay out of the view
  };
  const marks = { 'daily-brief': localDateStr(now), 'reminder.walk': '2026-08-31' };
  const auditEntries = [{ ev: 'job-failed', who: 'owner', job: 'daily-brief', at: 'tX' }];
  const rows = jobsView({ jobs, reminders: [{ id: 'walk', text: 'Walk 散步', time: '18:00' }], marks, audit: auditEntries, who: 'owner', now });
  assert.equal(rows.length, 3);
  const daily = rows.find((r) => r.name === 'daily-brief');
  assert.equal(daily.lastRun, localDateStr(now), 'the mark IS shown as lastRun');
  assert.equal(daily.lastOutcome, 'failed', 'but the outcome comes from the audit — failed, despite a today mark (R14)');
  assert.equal(daily.label, '每日一报 · Daily Brief');
  assert.ok(new Date(daily.nextDue).getDate() === 2, 'marked today → next due tomorrow');
  const rem = rows.find((r) => r.kind === 'reminder');
  assert.equal(rem.id, 'walk');
  assert.match(rem.label, /提醒 · Reminder: Walk 散步/);
  assert.equal(rem.schedule, 'daily · 每日 18:00');
  assert.equal(rem.lastRun, '2026-08-31');
  assert.equal(rem.lastOutcome, null, 'no audit entry → no claimed outcome (never a fake ok)');
});

test('jobsView: an on-demand built-in (the model review\'s Undo) gets a row with no next run, never a schedule', () => {
  const now = at(9, 0);
  const jobs = { undo: { name: 'undo', title: 'Undo', onDemand: true, run: () => null } };
  const [row] = jobsView({ jobs, marks: {}, audit: [], who: 'owner', now });
  assert.equal(row.schedule, ON_DEMAND);
  assert.equal(row.nextDue, null);
  assert.equal(row.paused, false);
});

// `at` is an ISO STRING in the real audit log, not epoch ms. T() keeps this harness in the
// production shape — a mock that uses a different type is how a real bug hides.
const T = (n) => new Date(1789000000000 + n * 1000).toISOString();

// ── "it ran" is not "it said something" is not "it arrived" ───────────────────────────────
// Three separate questions; the view answered only the first. A job returning null forever
// passes "ran ok", so a mis-set threshold looked exactly like a quiet month — and a broken
// push never showed at all, because lib/notify.mjs never throws by design.
test('a job that reports nothing is distinguishable from a quiet day', () => {
  const audit = [
    { ev: 'job-run', who: 'u', job: 'p', briefing: 'p-1', skipped: false, at: T(1000) },
    { ev: 'job-run', who: 'u', job: 'p', briefing: null, skipped: true, at: T(2000) },
    { ev: 'job-run', who: 'u', job: 'p', briefing: null, skipped: true, at: T(3000) },
  ];
  assert.deepEqual(lastReport(audit, 'u', 'p'), { at: T(1000), silentRuns: 2 });
  assert.deepEqual(lastReport(audit, 'u', 'never'), { at: null, silentRuns: 0 });
  const onlySilent = [{ ev: 'job-run', who: 'u', job: 'q', briefing: null, skipped: true, at: T(9) }];
  assert.deepEqual(lastReport(onlySilent, 'u', 'q'), { at: null, silentRuns: 1 },
    'a job that has NEVER said anything must be visible as such');
  // another user's runs must not count toward this one
  assert.deepEqual(lastReport([...audit, { ev: 'job-run', who: 'other', job: 'p', briefing: 'x', at: T(4000) }], 'u', 'p'),
    { at: T(1000), silentRuns: 2 });
});

test('a failed delivery is attributable to its job, and a NEWER briefing clears it', () => {
  const ran1 = { ev: 'job-run', who: 'u', job: 'p', briefing: 'p-1', skipped: false, at: T(90) };
  const fail = { ev: 'briefing-notify-failed', who: 'u', job: 'p', briefing: 'p-1', channel: 'telegram', error: 'timeout', at: T(100) };
  assert.deepEqual(lastDelivery([ran1, fail], 'u', 'p'),
    { status: 'failed', at: T(100), channel: 'telegram', error: 'timeout', briefing: 'p-1' });

  // Success is NOT audited (that contract is pinned in test/notify.test.mjs — an entry per
  // successful send every day is noise). Recovery is read from IDENTITY instead: a newer
  // briefing with no failure against it delivered fine.
  const ran2 = { ev: 'job-run', who: 'u', job: 'p', briefing: 'p-2', skipped: false, at: T(200) };
  assert.equal(lastDelivery([ran1, fail, ran2], 'u', 'p'), null, 'a stale failure must not stick forever');

  // …and a failure against the CURRENT briefing still reports.
  const fail2 = { ev: 'briefing-notify-failed', who: 'u', job: 'p', briefing: 'p-2', channel: 'email', error: 'bounced', at: T(210) };
  assert.equal(lastDelivery([ran1, fail, ran2, fail2], 'u', 'p').briefing, 'p-2');

  assert.equal(lastDelivery([], 'u', 'p'), null, 'no history = nothing to report');
  assert.equal(lastDelivery([ran1, fail], 'u', 'other-job'), null, "one job's failure is not another's");
  assert.equal(lastDelivery([{ ev: 'job-run', who: 'u', job: 'p', briefing: null, skipped: true, at: T(5) }], 'u', 'p'), null,
    'a job that never produced a briefing has nothing to deliver');
});

test('the view carries all three, so the UI can tell them apart', () => {
  const audit = [
    { ev: 'job-run', who: 'u', job: 'q', briefing: 'q-1', skipped: false, at: T(4000) },
    { ev: 'briefing-notify-failed', who: 'u', job: 'q', briefing: 'q-1', channel: 'telegram', error: 'timeout', at: T(4001) },
  ];
  const [row] = jobsView({ jobs: { q: { name: 'q', title: 'News', schedule: { time: '07:00' } } },
    audit, who: 'u', marks: { q: '2026-09-09' } });
  assert.equal(row.lastOutcome, 'ok', 'the RUN succeeded — delivery must not fail the job');
  assert.equal(row.lastReportAt, T(4000));
  assert.equal(row.delivery.status, 'failed', '…and yet it never arrived, which is now visible');
});
