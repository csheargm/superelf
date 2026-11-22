// Jobs view（任务视图）derivation core for GET /api/jobs — pure functions over
// injected fixtures (marks, audit entries, reminders) so the honesty rules are
// unit-testable (R6/R14): lastOutcome comes from the AUDIT LOG's most recent
// relevant entry, never inferred from a run mark — the view must never show ok
// when the audit says failed.
import fs from 'node:fs';
import { localDateStr, DAY_MS } from './schedule.mjs';

// Bounded audit scan: only the TAIL of audit.log is read — the file is
// append-only for the node's lifetime, so an unbounded read would make opening
// the Jobs section scale with total history. 256KB ≈ thousands of entries,
// far more than any recent-outcome lookup needs.
export const AUDIT_TAIL_BYTES = 256 * 1024;

export function readAuditTail(file, maxBytes = AUDIT_TAIL_BYTES) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch { return []; } // no audit file yet (first boot) → no outcomes to report — a valid empty, not an error
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // a mid-file start lands inside an entry — drop the torn first line
    return lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally { fs.closeSync(fd); }
}

// Most recent audit entry about this user's job (or reminder) wins.
// Jobs:      job-run (skipped → 'skipped', else 'ok'); job-failed /
//            job-retries-exhausted → 'failed'.
// Reminders: reminder-sent → 'ok'; reminder-failed → 'failed'.
export function lastOutcome(entries, who, { job, reminder } = {}) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.who !== who) continue;
    if (job !== undefined && e.job === job) {
      if (e.ev === 'job-run') return { outcome: e.skipped ? 'skipped' : 'ok', at: e.at || null };
      if (e.ev === 'job-failed' || e.ev === 'job-retries-exhausted') return { outcome: 'failed', at: e.at || null };
    }
    if (reminder !== undefined && e.reminder === reminder) {
      if (e.ev === 'reminder-sent') return { outcome: 'ok', at: e.at || null };
      if (e.ev === 'reminder-failed') return { outcome: 'failed', at: e.at || null };
    }
  }
  return { outcome: null, at: null };
}

// Did the last thing this job produced actually REACH anyone?
//
// The run and the delivery are separate outcomes: lib/notify.mjs never throws, by design, so
// a failed send can never fail the job. Correct — but it meant a job whose push had been
// broken for a week still read "✓ ok", because the delivery entries named only a briefing id
// and nothing joined them to the job.
//
// Success is deliberately NOT audited (lib/notify.mjs, pinned by its own test: a log entry per
// successful send every day is noise). So "did it recover?" is answered by IDENTITY instead:
// a failure counts only when it names the briefing this job most recently produced. A newer
// briefing that produced no failure entry delivered fine.
//
// null = nothing to report: no failure, or none against the current briefing.
export function lastDelivery(entries, who, job) {
  const list = entries || [];
  let current = null;                     // the newest briefing this job actually produced
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.who === who && e.job === job && e.ev === 'job-run' && e.briefing) { current = e.briefing; break; }
  }
  if (!current) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e || e.who !== who || e.briefing !== current) continue;
    if (e.ev === 'briefing-notify-failed' || e.ev === 'briefing-email-failed') {
      return { status: 'failed', at: e.at || null, channel: e.channel || null, error: e.error || '', briefing: current };
    }
  }
  return null;
}

// When did this job last actually SAY something, and how many runs has it been silent since?
//
// lastRun answers "did it run", which a job returning null forever also satisfies — so a job
// that has reported nothing for a month looks exactly like a quiet month. A mis-set threshold
// is invisible without this.
export function lastReport(entries, who, job) {
  let at = null, silent = 0;
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.who !== who || e.job !== job || e.ev !== 'job-run') continue;
    if (e.briefing && !e.skipped) { at = e.at || null; break; }   // found the last real report
    silent++;                                                      // ran, said nothing
  }
  return { at, silentRuns: silent };
}

const DAY_NAMES = [['Sun', '周日'], ['Mon', '周一'], ['Tue', '周二'], ['Wed', '周三'], ['Thu', '周四'], ['Fri', '周五'], ['Sat', '周六']];

// Human-readable schedule, bilingual: 'daily · 每日 07:30' / 'Sun · 周日 20:00'.
export function humanSchedule(s) {
  if (!s || !s.time) return '—';
  if (s.day === undefined) return `daily · 每日 ${s.time}`;
  const d = DAY_NAMES[s.day] || [String(s.day), String(s.day)];
  return `${d[0]} · ${d[1]} ${s.time}`;
}

// Next fire timestamp (ms), matching lib/schedule.mjs dueJobs semantics: a job
// past its HH:MM with no mark today is due NOW (same-day catch-up); one marked
// today — or a weekly entry on another day — waits for the next occurrence.
export function nextDueAt(s, mark, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s && s.time) || '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const ranToday = mark === localDateStr(now);
  for (let i = 0; i <= 7; i++) {
    const cand = new Date(now.getTime() + i * DAY_MS);
    cand.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (s.day !== undefined && cand.getDay() !== s.day) continue;
    if (i === 0 && ranToday) continue;                     // already ran today → next occurrence
    if (i === 0 && cand <= now) return now.getTime();      // catch-up: due on the next tick
    if (cand > now) return cand.getTime();
  }
  return null;
}

// A built-in that runs only when asked (Run now), never on a schedule: the model review's Undo
// (lib/model-review.mjs, docs/adr/0017). It gets a row so Run now is one tap, with no new screen.
export const ON_DEMAND = 'on demand · 按需';

// One row per registered job + one per reminder. All inputs are injected data
// (the route does the IO); rows are per-user by construction — marks and
// reminders come from the user's own workspace, audit entries filter on who.
export function jobsView({ jobs, reminders = [], marks = {}, audit = [], who, now = new Date() }) {
  const rows = [];
  for (const j of Object.values(jobs || {})) {
    if (!j.schedule && !j.onDemand) continue;
    const o = lastOutcome(audit, who, { job: j.name });
    // A paused job has NO next run. The scheduler already skips it (lib/jobruns entriesOf);
    // showing a due time anyway would tell the user something the engine will not do — and
    // "create it paused for review" only means anything if paused is visibly paused.
    const paused = j.enabled === false;
    const rep = lastReport(audit, who, j.name);
    const del = lastDelivery(audit, who, j.name);
    rows.push({ kind: 'job', name: j.name, label: j.title, schedule: j.schedule ? humanSchedule(j.schedule) : ON_DEMAND,
      lastRun: marks[j.name] || null, lastOutcome: o.outcome, lastOutcomeAt: o.at,
      // "it ran", "it said something" and "it arrived" are three different questions.
      lastReportAt: rep.at, silentRuns: rep.silentRuns, delivery: del,
      paused, pausedReason: paused ? (j.pausedReason || '') : '',
      editable: j.source === 'file',              // built-ins are code; only file jobs can be edited
      nextDue: paused || !j.schedule ? null : nextDueAt(j.schedule, marks[j.name] || null, now) });
  }
  for (const r of reminders) {
    const key = `reminder.${r.id}`;
    const o = lastOutcome(audit, who, { reminder: r.id });
    rows.push({ kind: 'reminder', name: key, id: r.id, label: `提醒 · Reminder: ${r.text}`,
      schedule: humanSchedule({ time: r.time, day: r.day }),
      lastRun: marks[key] || null, lastOutcome: o.outcome, lastOutcomeAt: o.at,
      nextDue: nextDueAt({ time: r.time, day: r.day }, marks[key] || null, now) });
  }
  return rows;
}
