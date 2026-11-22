// Persistent per-user reminders — what an approved 'create-reminder' action
// registers (lib/actions.mjs executor). A reminder is a tiny scheduled note:
// daily (or weekly with `day`) at HH:MM, delivered as a one-line briefing
// (in-app 简报 + the briefing email — one delivery path, R3).
//
// REUSES the job-engine core instead of growing a second scheduler: due-ness
// via lib/schedule.mjs dueJobs and once-per-day marks in the SAME per-user
// job-runs.json (lib/jobruns.mjs), keyed 'reminder.<id>'.
//
// workspace/<user>/reminders.json (gitignored personal state):
//   [{ id, text, time:'HH:MM', day?, created, flag?, adjustedAt?, triedTimes? }]
// `flag` = the producer flag the reminder answers (the adherence join key,
// lib/adherence.mjs); `adjustedAt`/`triedTimes` = adjust-reminder-time history
// (re-baseline anchor + slots already proven ineffective).
import fs from 'node:fs';
import path from 'node:path';
import { dueJobs, TIME_RE } from './schedule.mjs'; // ONE time regex (R3 — a local copy had drifted in)
import { readJobRuns, recordJobRun, clearJobRunToday } from './jobruns.mjs';
import { writeJsonFile } from './webutil.mjs';

const file = (u) => path.join(u.workspace, 'reminders.json');
const TIME_ERR = 'reminder time must be HH:MM · 提醒时间格式应为 HH:MM';
export const REMINDER_TEXT_MAX = 200;
// Reminder text rendered inside ONE composed line (adherence verdicts, the
// retire executor's note) is capped here — ONE constant (R3), two renderers.
export const REMINDER_NAME_MAX = 40;

// Missing file = no reminders; a corrupt file THROWS so the caller surfaces it
// (R5 — never silently treated as "no reminders").
export function loadReminders(user) {
  let txt;
  try { txt = fs.readFileSync(file(user), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const l = JSON.parse(txt);
  if (!Array.isArray(l)) throw new Error('reminders.json is not an array');
  return l;
}

// Per-user parse cache for the 60s tick: reminders.json is statted every tick
// but PARSED only when its mtime moved (or after a same-process write below).
// Steady state: zero JSON parsing per tick, matching the jobsTick gate ethos.
const cache = new Map(); // reminders-file path → { mtimeMs, reminders } (path, not user.id — the file IS the identity)
function loadRemindersCached(u) {
  const f = file(u);
  const st = fs.statSync(f);
  const hit = cache.get(f);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.reminders;
  const reminders = loadReminders(u); // throws on corrupt — caller audits (R5)
  cache.set(f, { mtimeMs: st.mtimeMs, reminders });
  return reminders;
}
const saveReminders = (u, list) => { writeJsonFile(file(u), list); cache.delete(file(u)); };

// Register one reminder. Validation throws (the approval executor then records
// status 'failed'). Dedupe is by id AND by semantic identity (text+time+day):
// approving a re-proposed flag mints a fresh action id, and id-only dedupe
// stacked an identical reminder per approval (R13 finding).
export function addReminder(user, { id, text, time, day, created, flag }) {
  if (!/^[\w.-]{1,80}$/.test(String(id || ''))) throw new Error('reminder id invalid');
  const t = String(text || '').trim();
  if (!t || t.length > REMINDER_TEXT_MAX) throw new Error(`reminder text required, max ${REMINDER_TEXT_MAX} chars · 提醒内容为必填（不超过${REMINDER_TEXT_MAX}字）`);
  if (!TIME_RE.test(String(time || ''))) throw new Error(TIME_ERR);
  if (day !== undefined && !(Number.isInteger(day) && day >= 0 && day <= 6)) throw new Error('reminder day must be 0 (Sun) - 6 · 星期取值 0-6');
  const list = loadReminders(user);
  const existing = list.find((r) => r.id === id || (r.text === t && r.time === String(time) && r.day === day));
  if (existing) {
    // Back-compat upgrade: a pre-flag reminder gains the producer flag its
    // re-approved create action carries — the adherence join is flag-first.
    if (flag && !existing.flag) { existing.flag = String(flag); saveReminders(user, list); }
    return existing;
  }
  const rem = { id, text: t, time: String(time), ...(day !== undefined ? { day } : {}),
    ...(flag ? { flag: String(flag) } : {}), created: created || Date.now() };
  list.push(rem);
  saveReminders(user, list);
  return rem;
}

// Retune — the adjust-reminder-time executor's seam（跟进闭环, lib/adherence.mjs
// producer）. Returns the updated reminder with `prevTime`, or null when the id
// is unknown (the caller reports honestly). An invalid time THROWS like
// addReminder does (R5 — the approval executor then records status 'failed').
// Adjustment history: `adjustedAt` re-anchors the adherence windows (the loop
// must measure the ADJUSTMENT, not keep judging the original slot), and the
// slot being left joins `triedTimes` — proven ineffective, never re-proposed.
// Same-day semantics（当日语义, R13 finding 21）: a new slot still AHEAD today
// fires today at that slot (the old fire's run mark is cleared), while a slot
// already PASSED today stays silent — preRegimeOccurrence marks + skips the
// stale occurrence, so approval mid-morning never triggers an hours-late fire.
export function updateReminderTime(user, id, time, now = Date.now()) {
  if (!TIME_RE.test(String(time || ''))) throw new Error(TIME_ERR);
  const list = loadReminders(user);
  const rem = list.find((r) => r.id === id);
  if (!rem) return null;
  const prevTime = rem.time;
  rem.time = String(time);
  rem.adjustedAt = now;
  rem.triedTimes = [...new Set([...(rem.triedTimes || []), prevTime])];
  saveReminders(user, list);
  const m = /^(\d{1,2}):(\d{2})$/.exec(rem.time);
  const occ = new Date(now); occ.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (occ.getTime() > now) clearJobRunToday(user, `reminder.${id}`, new Date(now));
  return { ...rem, prevTime };
}

// Revocation — the off switch the state machine was missing. Returns the
// removed reminder, or null when the id is unknown (caller reports honestly).
export function removeReminder(user, id) {
  const list = loadReminders(user);
  const rem = list.find((r) => r.id === id);
  if (!rem) return null;
  saveReminders(user, list.filter((r) => r.id !== id));
  return rem;
}

// First fire = the NEXT occurrence after approval OR after a time adjustment.
// dueJobs' same-day catch-up would otherwise deliver a "18:00" reminder
// approved at 20:05 — or one adjusted to "07:30" at 10:00 — immediately,
// hours late, reading as a bug. An occurrence predating the current regime
// (max of created/adjustedAt) is marked (one decision per day) and skipped;
// delivery starts at the next real occurrence.
function preRegimeOccurrence(rem, now) {
  const anchor = Math.max(typeof rem.created === 'number' ? rem.created : 0,
    typeof rem.adjustedAt === 'number' ? rem.adjustedAt : 0);
  if (!anchor) return false; // legacy entry without timestamps: deliver (fail open — losing fires is worse than one early fire)
  const m = /^(\d{1,2}):(\d{2})$/.exec(rem.time || '');
  if (!m) return false;
  const occ = new Date(now);
  occ.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return anchor > occ.getTime();
}

// One reminders tick (web.mjs runs it AFTER jobsTick in the same serialized
// tick — the two must never write job-runs.json concurrently). Cheap gates
// first: no file → skip; unchanged mtime → cached parse; nothing due by CLOCK
// TIME → job-runs.json is not even read (the jobsTick time-gate, mirrored).
// Delivery outcome is marked EITHER WAY: the only throwing step is a local FS
// briefing save (the email leg never rejects — lib/notify.mjs), and a
// once-a-minute retry of a broken disk would only spam; the failure is
// audit-visible ('reminder-failed'), never silent (R5).
export async function remindersTick({ users, audit, deliver, now = new Date() }) {
  for (const u of (users || []).filter((x) => x.status === 'active')) {
    if (!fs.existsSync(file(u))) continue;
    let reminders;
    try { reminders = loadRemindersCached(u); }
    catch (e) { audit('reminder-state-error', { who: u.id, error: String(e && e.message || e) }); continue; }
    if (!reminders.length) continue;
    const entries = reminders.map((r) => ({ name: `reminder.${r.id}`, time: r.time, day: r.day }));
    if (!dueJobs(entries, {}, now).length) continue; // time gate: nothing due by clock → no job-runs IO
    let runs;
    try { runs = readJobRuns(u); }
    catch (e) { audit('reminder-state-error', { who: u.id, error: String(e && e.message || e) }); continue; }
    for (const due of dueJobs(entries, runs, now)) {
      const rem = reminders.find((r) => `reminder.${r.id}` === due.name);
      if (preRegimeOccurrence(rem, now)) { recordJobRun(u, due.name, now); continue; } // first fire = next occurrence
      try {
        await deliver(u, rem, now);
        audit('reminder-sent', { who: u.id, reminder: rem.id });
      } catch (e) {
        audit('reminder-failed', { who: u.id, reminder: rem.id, error: String(e && e.message || e) });
      }
      recordJobRun(u, due.name, now); // one attempt per local day, success or audited failure
    }
  }
}
