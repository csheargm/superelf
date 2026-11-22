process.env.TZ = 'Asia/Shanghai';   // once-per-LOCAL-day marks — pin TZ so asserts hold anywhere
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobsTick, readJobRuns, recordJobRun, MAX_CONSECUTIVE_JOB_FAILURES } from '../lib/jobruns.mjs';
import { localDateStr } from '../lib/schedule.mjs';

const mkUser = (id = 'owner') => ({ id, status: 'active', workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'jobruns-')) });
const runsFile = (u) => path.join(u.workspace, 'job-runs.json');
const NOON = new Date(2026, 7, 24, 12, 0);            // Monday, local
const JOBS = { j: { name: 'j', title: 'J', schedule: { time: '08:00' } } };
const auditor = () => { const log = []; return { audit: (ev, x) => log.push({ ev, ...x }), log }; };
const tick = (users, now, audit, runJobFor) => jobsTick({ users, jobs: JOBS, now, audit, runJobFor });

test('tick runs a due job once, marks AFTER success, never re-runs the same day', async () => {
  const u = mkUser();
  const { audit, log } = auditor();
  let ran = 0;
  await tick([u], NOON, audit, async () => { ran++; return { briefing: { id: 'b1' } }; });
  assert.equal(ran, 1);
  assert.equal(readJobRuns(u).j, localDateStr(NOON), 'mark written for today');
  assert.ok(log.some((e) => e.ev === 'job-run' && e.briefing === 'b1'));
  await tick([u], new Date(2026, 7, 24, 12, 5), audit, async () => { ran++; return {}; });
  assert.equal(ran, 1, 'second tick same day: not due again');
});

test('R13-6 regression: a manual run writes the SAME mark → the scheduled tick does not double-run', async () => {
  const u = mkUser();
  // The manual /api/jobs/:name/run flow: report-already, run, record the mark.
  assert.equal(readJobRuns(u)['j'] === localDateStr(NOON), false, 'not yet run today (route reports this)');
  recordJobRun(u, 'j', NOON);                          // manual run succeeded at noon
  assert.equal(readJobRuns(u)['j'] === localDateStr(NOON), true, 'a second manual run would report alreadyRanToday');
  const { audit, log } = auditor();
  let ran = 0;
  await tick([u], new Date(2026, 7, 24, 20, 0), audit, async () => { ran++; return {}; });
  assert.equal(ran, 0, 'tick sees the manual mark — no duplicate briefing');
  assert.ok(!log.some((e) => e.ev === 'job-run'));
});

test('lost-update regression: a stale runs snapshot can NEVER erase a mark another writer landed', () => {
  const u = mkUser();
  // The old tickUser/remindersTick pattern: read a snapshot, hold it across a
  // long await, then pass it to recordJobRun — which wrote the WHOLE stale
  // object back, erasing marks written meanwhile (duplicate briefing/reminder).
  const staleSnapshot = readJobRuns(u);            // {} — taken before the "await"
  recordJobRun(u, 'reminder.walk', NOON);          // the other writer lands its mark
  recordJobRun(u, 'health-brief', NOON, staleSnapshot); // old code trusted the 4th arg; fresh-merge must ignore it
  const runs = readJobRuns(u);
  assert.equal(runs['reminder.walk'], localDateStr(NOON), 'the interleaved mark SURVIVES — no lost update');
  assert.equal(runs['health-brief'], localDateStr(NOON), 'the new mark landed too');
});

test('R13-7a regression: corrupt job-runs.json → tick SKIPPED loudly, marks never reset', async () => {
  const u = mkUser();
  fs.writeFileSync(runsFile(u), '{ definitely not json');
  const before = fs.readFileSync(runsFile(u), 'utf8');
  const { audit, log } = auditor();
  let ran = 0;
  await tick([u], NOON, audit, async () => { ran++; return {}; });
  assert.equal(ran, 0, 'no job may fire off unreadable marks');
  assert.equal(fs.readFileSync(runsFile(u), 'utf8'), before, 'the corrupt file is left for a human — never overwritten with {}');
  const err = log.find((e) => e.ev === 'job-state-error');
  assert.ok(err && /tick skipped/.test(err.error), 'surfaced in the audit log (R5), not swallowed');
});

test('R13-7b regression: failed run stays UNMARKED and is retried; retries are bounded by a named constant', async () => {
  const u = mkUser();
  const { audit, log } = auditor();
  let attempts = 0;
  const failing = async () => { attempts++; throw new Error('lane down'); };
  for (let m = 0; m < MAX_CONSECUTIVE_JOB_FAILURES; m++) {
    await tick([u], new Date(2026, 7, 24, 12, m), audit, failing);
    if (m < MAX_CONSECUTIVE_JOB_FAILURES - 1)
      assert.equal(readJobRuns(u).j, undefined, `after failure ${m + 1}: unmarked so the next tick retries`);
  }
  assert.equal(attempts, MAX_CONSECUTIVE_JOB_FAILURES);
  assert.equal(readJobRuns(u).j, localDateStr(NOON), 'exhausted: marked done for today so a broken job cannot hammer the lane');
  assert.ok(log.some((e) => e.ev === 'job-retries-exhausted' && e.attempts === MAX_CONSECUTIVE_JOB_FAILURES));
  await tick([u], new Date(2026, 7, 24, 12, 30), audit, failing);
  assert.equal(attempts, MAX_CONSECUTIVE_JOB_FAILURES, 'no further attempts today');
});

test('R13-7b: transient failure then success — mark written, failure counter cleared', async () => {
  const u = mkUser();
  const { audit, log } = auditor();
  await tick([u], NOON, audit, async () => { throw new Error('blip'); });
  assert.equal(readJobRuns(u).j, undefined);
  assert.ok(log.some((e) => e.ev === 'job-failed' && e.attempt === 1));
  await tick([u], new Date(2026, 7, 24, 12, 1), audit, async () => ({ briefing: { id: 'b2' } }));
  const runs = readJobRuns(u);
  assert.equal(runs.j, localDateStr(NOON), 'the weekly brief survives a one-minute outage');
  assert.equal(runs._failures, undefined, 'counter cleared on success');
});

test('time gate: before any job\'s time, no per-user state is even read (corrupt file stays un-audited)', async () => {
  const u = mkUser();
  fs.writeFileSync(runsFile(u), '{ corrupt');
  const { audit, log } = auditor();
  let ran = 0;
  await tick([u], new Date(2026, 7, 24, 7, 0), audit, async () => { ran++; return {}; });
  assert.equal(ran, 0);
  assert.equal(log.length, 0, 'nothing due by time → marks never read → no error, no I/O per user');
});

test('users tick independently: one user\'s failure never blocks another\'s job', async () => {
  const a = mkUser('a'), b = mkUser('b'), pending = { ...mkUser('p'), status: 'pending' };
  const { audit, log } = auditor();
  const who = [];
  await tick([a, b, pending], NOON, audit, async (user) => {
    who.push(user.id);
    if (user.id === 'a') throw new Error('a is broken');
    return { briefing: { id: 'b-ok' } };
  });
  assert.deepEqual(who.sort(), ['a', 'b'], 'active users only; both attempted');
  assert.ok(log.some((e) => e.ev === 'job-failed' && e.who === 'a'));
  assert.ok(log.some((e) => e.ev === 'job-run' && e.who === 'b'));
  assert.equal(readJobRuns(b).j, localDateStr(NOON));
});
