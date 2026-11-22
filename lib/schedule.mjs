// The ONE day-length constant (R3): actions/health and others each grew
// a bare 86400000 — import this instead (test/schedule.test.mjs enforces it).
export const DAY_MS = 86400000;

// The ONE strict HH:MM shape (R3) — the job store, jobs/when.mjs and reminders.mjs
// validate against THIS binding; never inline a copy.
export const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

// A schedule fires once per local day, at or any time after its HH:MM.
// (If the server was down at HH:MM, it catches up on the next tick that day.)
export function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Job-engine entries (JOB_ENGINE_PLAN trigger runtime): code-backed, no prompt.
// Entries are { name, time:'HH:MM', day? }: `day` = weekday 0(Sun)-6 makes an
// entry weekly, absent = daily. Once-per-local-day + same-day catch-up.
// (The bot's config `schedules` shared this core through dueSchedules until the
// Telegram bot was removed, docs/adr/0006.)
export function dueJobs(entries, lastRuns, now = new Date()) {
  const today = localDateStr(now);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return (entries || []).filter((e) => {
    if (!e || !e.name) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(e.time || '');
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return false;
    if (e.day !== undefined && e.day !== now.getDay()) return false;
    return minutesNow >= Number(m[1]) * 60 + Number(m[2]) && (lastRuns || {})[e.name] !== today;
  });
}
