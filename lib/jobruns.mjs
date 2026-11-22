// Once-per-day job-run marks + the scheduler tick core, extracted from web.mjs
// so the tick's reliability rules are unit-testable (R6).
//
// job-runs.json (per user workspace, gitignored personal state):
//   { [jobName]: 'YYYY-MM-DD', _failures: { [jobName]: { date, count } } }
// '_failures' is a RESERVED key — never name a job that. (dueJobs only looks up
// real job names in this map, so the reserved key can never make one due.)
import fs from 'node:fs';
import path from 'node:path';
import { dueJobs, localDateStr } from './schedule.mjs';
import { writeJsonFile } from './webutil.mjs';

// Bounded retries: a failing job is retried on later ticks the SAME day (a
// one-minute lane outage must not skip a weekly brief), but after this many
// consecutive same-day failures the day is marked done anyway — audited as
// job-retries-exhausted — so a hard-broken job can't hammer an LLM lane
// once a minute for hours.
export const MAX_CONSECUTIVE_JOB_FAILURES = 3;
const FAILURES_KEY = '_failures';
const runsFile = (u) => path.join(u.workspace, 'job-runs.json');

// STRICT read: a missing file is a first run ({}), but an unreadable/corrupt
// file THROWS so the caller can surface it — it must never be silently treated
// as "no marks", which re-fired every past-due job for the day (R5).
export function readJobRuns(user) {
  let txt;
  try { txt = fs.readFileSync(runsFile(user), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const o = JSON.parse(txt);   // corrupt JSON throws here — caller audits + skips
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('job-runs.json is not an object');
  return o;
}
const writeRuns = (user, runs) => writeJsonFile(runsFile(user), runs); // atomic (shared helper, R3)

// Un-mark a job for TODAY only — the adjust-reminder-time seam (lib/reminders
// updateReminderTime): a reminder moved to a LATER slot today must fire at the
// new slot, and the old fire's mark would silently swallow it. Any other
// day's mark is history and stays. Fresh read-merge-write like recordJobRun.
export function clearJobRunToday(user, name, now = new Date()) {
  const r = readJobRuns(user);   // may throw on a corrupt file — caller surfaces (R5)
  if (r[name] !== localDateStr(now)) return false;
  delete r[name];
  writeRuns(user, r);
  return true;
}

// Mark a job done for today — call AFTER a successful run (a failed run stays
// unmarked so the next tick retries). Clears the job's failure counter. Manual
// /api/jobs/:name/run uses this too, so tick and manual share ONE mark.
// FRESH read-merge-write per key: a caller-held snapshot taken before a long
// await (LLM pass, email send) silently erased marks other writers landed
// meanwhile — the duplicate-briefing/duplicate-reminder lost-update scar.
export function recordJobRun(user, name, now = new Date()) {
  const r = readJobRuns(user);   // may throw on a corrupt file — caller audits
  r[name] = localDateStr(now);
  if (r[FAILURES_KEY]) { delete r[FAILURES_KEY][name]; if (!Object.keys(r[FAILURES_KEY]).length) delete r[FAILURES_KEY]; }
  writeRuns(user, r);
  return r;
}

// Same fresh-merge rule as recordJobRun — never writes a stale whole-file snapshot.
function noteFailure(user, name, now) {
  const runs = readJobRuns(user);
  const today = localDateStr(now);
  const f = runs[FAILURES_KEY] = runs[FAILURES_KEY] || {};
  const count = (f[name] && f[name].date === today ? f[name].count : 0) + 1;
  f[name] = { date: today, count };
  writeRuns(user, runs);
  return count;
}

async function tickUser(user, _entries, jobs, now, audit, runJobFor) {
  // Resolve THIS user's jobs now — built-ins plus whatever is on disk this minute.
  // A resolver that throws must not take the tick down for everyone (R5).
  let map;
  try { map = jobsOf(jobs, user); }
  catch (e) { audit('job-state-error', { who: user.id, error: `jobs unreadable — tick skipped: ${String(e && e.message || e)}` }); return; }
  const entries = entriesOf(map);
  if (!dueJobs(entries, {}, now).length) return;   // cheap gate, before reading job-runs.json
  let runs;
  try { runs = readJobRuns(user); }
  catch (e) {
    // R5: surfaced in the owner-visible audit log and the cycle is SKIPPED —
    // marks are never reset, so nothing re-fires because a file went bad.
    audit('job-state-error', { who: user.id, error: `job-runs.json unreadable — tick skipped, marks kept (fix or delete the file): ${String(e && e.message || e)}` });
    return;
  }
  for (const due of dueJobs(entries, runs, now)) {
    const job = map[due.name];
    try {
      const out = await runJobFor(user, job);
      recordJobRun(user, due.name, now);   // mark AFTER success only (fresh merge — never this loop's stale snapshot)
      audit('job-run', { who: user.id, job: due.name, briefing: out && out.briefing ? out.briefing.id : null, skipped: !!(out && out.skipped) });
    } catch (e) {
      // A failed run stores NO briefing (R14) and stays UNMARKED → retried on
      // the next tick, up to MAX_CONSECUTIVE_JOB_FAILURES for the day.
      const count = noteFailure(user, due.name, now);
      audit('job-failed', { who: user.id, job: due.name, attempt: count, error: String(e && e.message || e) });
      if (count >= MAX_CONSECUTIVE_JOB_FAILURES) {
        recordJobRun(user, due.name, now);
        audit('job-retries-exhausted', { who: user.id, job: due.name, attempts: count });
      }
    }
  }
}

// One scheduler tick. Cheap TIME GATE first: during the ~23 hours when no job
// is due by clock time at all, no per-user file is read. Then active users run
// CONCURRENTLY (allSettled — one user's problem never blocks another's jobs;
// per-job errors are caught in tickUser, so a rejection here is unexpected and
// still audited, never swallowed).
// `jobs` is either a static map (built-ins only) or a FUNCTION of the user, so a user's own
// job files are re-read every tick and a new job runs without a restart. The cheap time gate
// is kept for the static case; for the per-user case each tick's gate is inside tickUser,
// which still returns before touching job-runs.json when nothing is due.
export const jobsOf = (jobs, user) => (typeof jobs === 'function' ? jobs(user) : jobs);
export const entriesOf = (map) => Object.values(map)
  .filter((j) => j.schedule && j.enabled !== false)   // a paused job has no turn
  .map((j) => ({ name: j.name, ...j.schedule }));

export async function jobsTick({ users, jobs, now = new Date(), audit, runJobFor }) {
  if (typeof jobs !== 'function' && !dueJobs(entriesOf(jobs), {}, now).length) return;
  const active = (users || []).filter((u) => u.status === 'active');
  const results = await Promise.allSettled(active.map((u) => tickUser(u, null, jobs, now, audit, runJobFor)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') audit('job-tick-error', { who: active[i].id, error: String(r.reason && r.reason.message || r.reason) });
  });
}
