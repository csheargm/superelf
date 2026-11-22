// Adherence loop（跟进闭环）— PLAN.md capability #2. The weekly 健康简报 used
// to suggest and never look back; this closes the loop: every intervention the
// approval loop executed (create-reminder actions, joined to their registered
// reminder by the PRODUCER FLAG the reminder carries — lib/actions.mjs
// execCreateReminder stamps it; legacy reminders match by the create action's
// semantic identity), and every one denied or since removed, is judged against
// the SAME daily rollups the analysis reads: the 7 days before its anchor vs
// the 7 days ending yesterday. Verdict lines ride the existing weekly brief
// (zero new messages, P2) and follow-ups go through the EXISTING approval loop.
//
// Deterministic producer rules ONLY (R14): the named constants below decide
// every verdict and every proposal — the LLM never sees these lines and never
// invents a follow-up. Missing data is reported as missing ("insufficient
// data · 数据不足"), never guessed over — and a mean of ZERO with real
// coverage is DATA, never "missing" (R13 finding: an all-zero baseline week
// is a fact to improve on, not a gap).
//
// Pure functions: callers pass state in ({reminders, actionsHistory, rows});
// nothing here touches disk. Stats via the ONE existing windowStats (R3; the
// import cycle with health-analyze.mjs is call-time only — safe in ESM).
import { windowStats, daysAgo, FROM_ZERO_TEXT } from './health-analyze.mjs';
import { DAY_MS, localDateStr } from './schedule.mjs';
import { sanitizeLine } from './webutil.mjs';
import { ACTION_TYPES, latestRetirement } from './actions.mjs';
import { REMINDER_NAME_MAX } from './reminders.mjs';

// Comparison windows: `after` = the 7 calendar days ending YESTERDAY (today is
// a partial day for cumulative metrics — analyzeHealth's rationale); `before`
// = the 7 days ending the day BEFORE the intervention's anchor (start for an
// active reminder, re-anchored to its last adjustment; removal/denial date
// for a gone one). NO verdict of any kind before a full after-window has
// elapsed — younger, the "after" evidence is mostly pre-intervention data and
// any verdict would credit (or blame) a trend the intervention never touched.
export const ADHERENCE_WINDOW_DAYS = 7;
// A mean-verdict window with fewer data DAYS than this yields NO verdict —
// the line says "insufficient data · 数据不足" instead (R14). Present-days
// decide sufficiency; the mean's VALUE (zero included) never does.
export const ADHERENCE_MIN_DATA_DAYS = 4;
// Mean improved at least this percent vs before → "keeping it · 保持".
export const ADHERENCE_IMPROVE_PCT = 10;
// Coverage (data-gap reminders): at least this many MORE data days → improved.
export const ADHERENCE_COVERAGE_IMPROVE_DAYS = 3;
// "No change" is only called — and a follow-up proposed — after this many
// active days: behavior change is slower than a week (mirrors the reasoning
// of EXECUTED_COOLDOWN_DAYS in lib/actions.mjs). Younger and not improved →
// silence, by design, not a verdict.
export const ADHERENCE_NO_CHANGE_DAYS = 14;
// Evaluation window: past this age an intervention is ESTABLISHED and leaves
// the weekly evaluation — silence, by design (6 weeks = three no-change
// cycles). Without this cap an old intervention's before-window slides off
// the data horizon and degrades into an eternal 'insufficient data' line
// (R13 finding); flag ownership (activeFlags) never ages out.
export const ADHERENCE_EVAL_MAX_DAYS = 42;
// Caps: the weekly brief stays a digest, not a report (P1/P2).
export const ADHERENCE_MAX_LINES = 3;
export const ADHERENCE_MAX_PROPOSALS = 1;
// Deterministic adjust-time rule: the evening slot IS the walk producer's own
// (health-analyze.mjs healthProposals imports this binding — R3, one literal);
// the morning slot is the alternate to try. Slots already tried live on the
// reminder (triedTimes, lib/reminders.mjs) and are never re-proposed; all
// slots spent with still no change → retire (terminal — no oscillation).
export const WALK_REMINDER_TIME = '18:00';
export const ADJUST_ALT_TIMES = ['07:30', WALK_REMINDER_TIME];
const STILL_NO_DATA = '数据仍缺失'; // shared by the coverage line AND the retire why (R3)

// Producer flags → the rollup field their verdict reads. kind 'mean' compares
// window means (higher is better for both steps and sleep minutes); kind
// 'coverage' compares data-days present (data-gap check reminders).
const FLAG_METRICS = {
  steps_min_daily: { field: 'steps', label: 'steps 步数', kind: 'mean' },
  sleep_min_minutes: { field: 'sleepMinutes', label: 'sleep 睡眠', kind: 'mean' },
  gap_sleep: { field: 'sleepMinutes', label: 'sleep data 睡眠数据', kind: 'coverage' },
};

const pctOf = (before, after) => Math.round(((after - before) / before) * 100);
const fmtPct = (d) => `${d >= 0 ? '+' : ''}${d}%`;
const cov = (w) => `${w.present}/${w.expected}`;
// CALENDAR days between two instants — never elapsed/DAY_MS, which undercounts
// across DST and for later-in-day anchors (R13 finding: a reminder approved
// Sunday 09:30 read "13 days" at the 14-calendar-day Sunday-08:00 brief).
const calDays = (now, ts) =>
  Math.round((Date.parse(localDateStr(new Date(now))) - Date.parse(localDateStr(new Date(ts)))) / DAY_MS);

// ── ONE phrasing per change kind (R3/R14) ────────────────────────────────────
// The verdict line and the proposal's why（原因）sentence must quote the SAME
// computed numbers the same way. A zero baseline with real coverage is data,
// not absence: percent change is undefined, so the absolute rise is shown.
function meanChange(m, w) {
  if (w.before.mean === 0)
    return `${m.label} 7d avg 0 → ${w.after.mean}${w.after.mean > 0 ? FROM_ZERO_TEXT : ''}`;
  return `${m.label} 7d avg ${w.before.mean} → ${w.after.mean} (${fmtPct(pctOf(w.before.mean, w.after.mean))})`;
}
const meanImproved = (w) => w.before.mean === 0
  ? w.after.mean > 0
  : pctOf(w.before.mean, w.after.mean) >= ADHERENCE_IMPROVE_PCT;
const covChange = (m, w) => `${m.label} ${cov(w.before)} → ${cov(w.after)} days`;

// ── The flag→reminder join ───────────────────────────────────────────────────
// A reminder carries the producer flag it answers (written at creation since
// this change). Legacy reminders without one match a DONE create action's
// semantic identity — text+time+day, the addReminder dedupe key — because a
// re-approved flag mints a fresh action id and returns the EXISTING reminder,
// so the latest action's id may match no reminder at all (R13 finding).
function liveReminderFor(reminders, flag, creates) {
  const list = reminders || [];
  const byFlag = list.find((r) => r && r.flag === flag);
  if (byFlag) return byFlag;
  for (const a of creates) {
    if (a.status !== 'done') continue;
    const p = a.payload;
    const hit = list.find((r) => r && r.flag === undefined
      && r.text === p.text && r.time === p.time && r.day === p.day);
    if (hit) return hit;
  }
  return null;
}

// One intervention per flag. A LIVE reminder ALWAYS classifies 'active' — a
// later denied re-proposal must never shadow the executed intervention whose
// reminder still fires daily (R13 finding). Anchors（基线锚点）: active =
// max(created, adjustedAt) so an approved adjustment is measured, not the
// original slot forever; removed = the recorded retirement date (falling back
// to the create decision for legacy removals); denied = the denial decision.
function interventions(reminders, history) {
  const byFlag = new Map();
  for (const a of history || []) {
    if (!a || a.type !== 'create-reminder' || !a.payload || !FLAG_METRICS[a.payload.flag]) continue;
    if (a.status !== 'done' && a.status !== 'denied') continue;
    const g = byFlag.get(a.payload.flag) || { latest: null, creates: [] };
    g.creates.push(a);
    if (!g.latest || (a.created || 0) > (g.latest.created || 0)) g.latest = a;
    byFlag.set(a.payload.flag, g);
  }
  const out = [];
  for (const [flag, g] of byFlag) {
    const rem = liveReminderFor(reminders, flag, g.creates);
    const a = g.latest;
    const started = rem
      ? Math.max(rem.created || 0, rem.adjustedAt || 0) || a.decided || a.created || 0
      : a.status === 'denied' ? (a.decided || a.created || 0)
        : ((latestRetirement(history, flag) || {}).at || a.decided || a.created || 0);
    if (!started) continue; // no provable anchor date → no honest window (fail safe)
    out.push({ flag, reminder: rem, started,
      state: rem ? 'active' : a.status === 'denied' ? 'denied' : 'removed' });
  }
  return out.sort((x, y) => x.started - y.started);
}

// How many daily rows the CALLER must fetch so every EVALUATED intervention's
// before-window sits inside the data horizon: oldest evaluated anchor + the
// window + 1 (the day before the anchor). Aged-out and too-young interventions
// need no rows — they are silent by design. 0 = no adherence rows needed.
export function adherenceHorizonDays({ reminders, actionsHistory, now = new Date() } = {}) {
  let max = 0;
  for (const iv of interventions(reminders, actionsHistory)) {
    const days = calDays(now, iv.started);
    if (days < ADHERENCE_WINDOW_DAYS || days > ADHERENCE_EVAL_MAX_DAYS) continue;
    max = Math.max(max, days + ADHERENCE_WINDOW_DAYS + 1);
  }
  return max;
}

// The why（原因）sentences quote ONLY numbers computed here (R14). payload.flag
// 'adherence_<reminderId>' is the dedupe key the EXISTING suppression
// machinery matches (denied/executed/pending, lib/actions.mjs); retire
// proposals also carry retiredFlag = the ORIGINAL producer flag, so an
// approved retirement enters the retirement cooldown (retiredRecently) and
// the next brief cannot re-propose the reminder it just removed.
function mkProposal(type, iv, why, extra = {}) {
  return { type, title: ACTION_TYPES[type].label, summary: `why: ${why}`,
    payload: { flag: `adherence_${iv.reminder.id}`, reminderId: iv.reminder.id, ...extra } };
}

// Verdict for an ACTIVE intervention → { line, proposal? } or null (nothing
// honest to say — silence by design, not a missing case).
function verdictActive(iv, m, w, days) {
  const name = sanitizeLine(iv.reminder.text, REMINDER_NAME_MAX);
  if (m.kind === 'coverage') {
    if (w.after.present - w.before.present >= ADHERENCE_COVERAGE_IMPROVE_DAYS)
      return { line: `- ${name} — active ${days} days · ${covChange(m, w)} · keeping it · 保持` };
    // Data already flowing (nothing honest to add), or too early → silence.
    if (w.after.present >= ADHERENCE_MIN_DATA_DAYS || days < ADHERENCE_NO_CHANGE_DAYS) return null;
    return { line: `- ${name} — still no data after ${days} days · ${covChange(m, w)} · ${STILL_NO_DATA}`,
      proposal: mkProposal('retire-reminder', iv,
        `${m.label} still ${cov(w.after)} days after ${days} days of the check reminder — retire it · 提醒${days}天后${STILL_NO_DATA}，建议移除该提醒`,
        { retiredFlag: iv.flag }) };
  }
  if (w.before.present < ADHERENCE_MIN_DATA_DAYS || w.after.present < ADHERENCE_MIN_DATA_DAYS)
    return { line: `- ${name} — insufficient data · 数据不足 (${cov(w.before)} days before 前 / ${cov(w.after)} after 后)` };
  if (meanImproved(w))
    return { line: `- ${name} — active ${days} days · ${meanChange(m, w)} · keeping it · 保持` };
  if (days < ADHERENCE_NO_CHANGE_DAYS) return null;
  const tried = iv.reminder.triedTimes || [];
  const to = ADJUST_ALT_TIMES.find((t) => t !== iv.reminder.time && !tried.includes(t));
  const line = `- ${name} — no change after ${days} days · ${meanChange(m, w)} · 无明显变化`;
  if (to) return { line, proposal: mkProposal('adjust-reminder-time', iv,
    `${meanChange(m, w)} after ${days} days at ${iv.reminder.time} — try ${to} instead · ${days}天无明显变化，建议提醒时间改为${to}`,
    { time: to }) };
  // Every alternate slot already tried, still no change → terminal: retire.
  return { line, proposal: mkProposal('retire-reminder', iv,
    `${meanChange(m, w)} after ${days} days — every slot tried (${[iv.reminder.time, ...tried].join(', ')}) — retire it · 各时段已试过仍无改善，建议移除该提醒`,
    { retiredFlag: iv.flag }) };
}

// A denied or since-removed reminder whose metric improved anyway earns ONE
// positive line and never a proposal — the user's decision stood and the data
// self-corrected. Anything else about it is silence: a denial is respected,
// not re-litigated (the cooldown philosophy of lib/actions.mjs). Windows are
// anchored at the denial/removal date, so "improved WITHOUT it" compares the
// week before the decision against now — never the pre-creation era.
function verdictGone(iv, m, w) {
  const how = iv.state === 'denied'
    ? 'without the reminder (denied) · 提醒被拒后自行改善'
    : 'after the reminder was removed · 提醒移除后自行改善';
  if (m.kind === 'coverage') {
    if (w.after.present - w.before.present < ADHERENCE_COVERAGE_IMPROVE_DAYS) return null;
    return { line: `- ${covChange(m, w)} · recovered ${how} · no action needed · 无需行动` };
  }
  if (w.before.present < ADHERENCE_MIN_DATA_DAYS || w.after.present < ADHERENCE_MIN_DATA_DAYS) return null;
  if (!meanImproved(w)) return null;
  return { line: `- ${meanChange(m, w)} · improved ${how} · no action needed · 无需行动` };
}

// The report the weekly brief composes in: bounded bilingual lines + proposals
// for the existing approval loop. activeFlags = flags with a live reminder,
// so the caller stops healthProposals re-proposing a create-reminder that
// already exists (the adherence verdict owns that flag now).
export function adherenceReport({ reminders, actionsHistory, rows, now = new Date(), isSuppressed = () => false } = {}) {
  const byDate = {}; for (const r of rows || []) byDate[r.date] = r;
  const lines = [], proposals = [], activeFlags = new Set();
  for (const iv of interventions(reminders, actionsHistory)) {
    if (iv.state === 'active') activeFlags.add(iv.flag); // flag ownership never ages out
    const days = calDays(now, iv.started);
    if (days < ADHERENCE_WINDOW_DAYS) continue;  // young（新干预静默）: no full after-window yet — any verdict would credit pre-intervention data
    if (days > ADHERENCE_EVAL_MAX_DAYS) continue; // established（评估期已过）: silence, never 'insufficient data forever'
    if (lines.length >= ADHERENCE_MAX_LINES) continue; // the cap bounds LINES; flag ownership is still collected
    const m = FLAG_METRICS[iv.flag];
    const start = new Date(iv.started);
    const w = { before: windowStats(byDate, m.field, daysAgo(start, ADHERENCE_WINDOW_DAYS), daysAgo(start, 1)),
      after: windowStats(byDate, m.field, daysAgo(now, ADHERENCE_WINDOW_DAYS), daysAgo(now, 1)) };
    const v = iv.state === 'active' ? verdictActive(iv, m, w, days) : verdictGone(iv, m, w);
    if (!v) continue;
    // A suppressed follow-up silences its LINE too: denied → the answer was
    // already given (no weekly nag · 拒绝后不唠叨); pending/just-executed →
    // the ask is already in flight. Only the verdict WITH its ask repeats.
    if (v.proposal && isSuppressed(v.proposal.payload.flag)) continue;
    let line = v.line;
    if (v.proposal && proposals.length < ADHERENCE_MAX_PROPOSALS) {
      proposals.push(v.proposal);
      // 'pending · 待定', deliberately NOT 'proposing': the store-time
      // duplicate filter (web.mjs runJobSerialized) may drop THIS run's
      // action instance when an overlapping run stored it first — a pending
      // proposal for the flag exists either way, so the wording stays true.
      line += v.proposal.type === 'retire-reminder' ? ' · retirement pending · 移除待定' : ' · adjustment pending · 调整待定';
    }
    lines.push(line);
  }
  return { lines, proposals, activeFlags };
}
