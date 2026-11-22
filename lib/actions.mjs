// The approval loop（审批闭环）core — PLAN.md Part III Phase A.
//
// Proposals are produced by DETERMINISTIC job code (never LLM-invented, R14),
// stored via lib/autonomy.mjs proposeAction, and decided by a human in the app
// queue (web.mjs routes; the longevity app's Pending Approvals) — EXCEPT types
// the owner standing-pre-approved in cfg.preapproved_action_types（预批准）,
// which execute immediately and are REPORTED as done, never asked.
//
// The ONE typed registry (R3): every proposable action type lives here with its
// executor and its `outward` flag. `outward: true` = the action sends beyond
// the user's own channels (email, posts, messages to others) — such a type can
// NEVER be pre-approved, enforced in validatePreapprovedTypes (code, not
// convention). An unknown type has no executor and always fails safe.
import { loadActions, saveActions, approveAction, getBriefing, saveBriefing } from './autonomy.mjs';
import { addReminder, removeReminder, updateReminderTime, REMINDER_NAME_MAX } from './reminders.mjs';
import { DAY_MS } from './schedule.mjs';
import { sanitizeLine } from './webutil.mjs';

// A proposal nobody decided expires — it is marked, never silently executed.
export const PROPOSAL_TTL_DAYS = 7;
// A denied proposal's flag is not re-proposed within this window (one weekly
// brief is skipped — re-asking on the very next brief would ignore the denial).
export const DENIED_COOLDOWN_DAYS = 14;
// An EXECUTED proposal's flag is not re-proposed within this window either —
// one approve must not re-ask every later brief (each approve stacked another
// identical reminder; behavior change takes longer than a week to show).
export const EXECUTED_COOLDOWN_DAYS = 14;
// An action stuck at 'approved' longer than this had its executor interrupted
// (crash/kill between the approved write and done/failed) — closed as failed.
export const EXEC_LIMBO_MINUTES = 10;
// Retiring a reminder is a decision about its ORIGINAL producer flag: for this
// window the flag is treated like a denial（同拒绝冷静期）— the next brief must
// not re-propose the reminder the family just removed (R13 finding).
export const RETIRED_COOLDOWN_DAYS = DENIED_COOLDOWN_DAYS;
// The manual off switch's record type (DELETE /api/reminders/:id) — an
// approved retire-reminder action needs no extra record: its own done entry
// carries payload.retiredFlag (lib/adherence.mjs retire proposals).
export const REMINDER_RETIRED_TYPE = 'reminder-retired';

async function execCreateReminder(user, action) {
  const p = action.payload || {};
  // Validation lives in addReminder (throws → approveAction marks 'failed').
  // The producer flag is stamped ON the reminder — the adherence join key
  // (lib/adherence.mjs joins flag→reminder, never by a dedupe-shifted id).
  const rem = addReminder(user, { id: action.id, text: p.text, time: p.time, day: p.day, flag: p.flag });
  return { ok: true, note: `reminder registered · 提醒已创建 (${rem.time}${rem.day !== undefined ? ', day ' + rem.day : ' daily'})` };
}

// Adherence follow-ups（跟进闭环, produced by lib/adherence.mjs): tune or
// retire an EXISTING reminder. Non-outward, but deliberately in NO
// pre-approved default anywhere — changing a standing nudge is a decision,
// not a routine. Unknown reminder id → throw (approveAction records 'failed'
// with the honest bilingual reason — nothing pretends to have adjusted).
async function execAdjustReminderTime(user, action) {
  const p = action.payload || {};
  const rem = updateReminderTime(user, p.reminderId, p.time); // invalid time throws (R5)
  if (!rem) throw new Error('reminder not found — nothing adjusted · 未找到提醒，未作调整');
  return { ok: true, note: `reminder time updated · 提醒时间已调整 (${rem.prevTime} → ${rem.time})` };
}
async function execRetireReminder(user, action) {
  const rem = removeReminder(user, (action.payload || {}).reminderId);
  if (!rem) throw new Error('reminder not found — nothing retired · 未找到提醒，未作移除');
  return { ok: true, note: `reminder retired · 提醒已移除 (${sanitizeLine(rem.text, REMINDER_NAME_MAX)})` };
}

export const ACTION_TYPES = {
  'create-reminder': { label: 'Create reminder · 创建提醒', outward: false, execute: execCreateReminder },
  'adjust-reminder-time': { label: 'Adjust reminder time · 调整提醒时间', outward: false, execute: execAdjustReminderTime },
  'retire-reminder': { label: 'Retire reminder · 移除提醒', outward: false, execute: execRetireReminder },
  'noop': { label: 'Acknowledge · 确认', outward: false, execute: async () => ({ ok: true, note: 'acknowledged · 已确认' }) },
  // Outward-facing（对外行动）: declared so the pre-approval ban is enforced on a
  // REAL registry entry (R14 — the guard must have something to refuse). No
  // connector yet → executor fails honestly instead of pretending to send.
  'send_email': { label: 'Send email · 发送邮件', outward: true,
    execute: async () => { throw new Error('email connector not wired yet — nothing was sent · 邮件通道未接线，未发送任何内容'); } },
};

// Config gate for cfg.preapproved_action_types — called at config load, throws
// on an unknown type and on ANY outward-facing type (never pre-approvable).
export function validatePreapprovedTypes(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('preapproved_action_types must be an array of action type names');
  for (const t of list) {
    const def = ACTION_TYPES[t];
    if (!def) throw new Error(`preapproved_action_types: unknown action type "${t}" — registered types: ${Object.keys(ACTION_TYPES).join(', ')}`);
    if (def.outward) throw new Error(`preapproved_action_types: "${t}" is outward-facing（对外行动）and can NEVER be pre-approved — remove it`);
  }
  return list.map(String);
}

// Phase-2 executor dispatch. Unknown type → reject (fail safe: approveAction
// records status 'failed', nothing runs). async so the unknown-type throw is
// a rejection like any executor failure — one failure path for callers.
export async function executeAction(user, action) {
  const def = ACTION_TYPES[String(action && action.type)];
  if (!def) throw new Error(`no executor registered for action type "${action && action.type}" — fail safe, nothing executed`);
  return def.execute(user, action);
}

// Sweep: pending proposals past their TTL become 'expired' — visible, decided-
// by-time, and never executable (approveAction refuses non-pending). A pending
// action with NO created timestamp cannot prove freshness → expired (fail safe).
// Batched: ONE read + ONE write, however many expire (the per-item
// setActionStatus loop was k+1 parses and k rewrites per sweep).
export function expireStaleActions(user, now = Date.now()) {
  const list = loadActions(user);
  const expired = [];
  for (const a of list) {
    if (a.status !== 'pending') continue;
    if (typeof a.created !== 'number' || now - a.created > PROPOSAL_TTL_DAYS * DAY_MS) {
      a.status = 'expired'; a.decided = now; expired.push(a);
    }
  }
  if (expired.length) saveActions(user, list);
  return expired;
}

// Crash recovery: an 'approved' action whose executor never resolved (process
// died between the approved write and the done/failed write) is otherwise
// stranded forever — no queue shows it, the only-pending guard refuses it, the
// TTL sweep skips it. Past EXEC_LIMBO_MINUTES it is closed as failed
// ("interrupted · 执行中断"), audited, its outcome reported wherever the
// action's status is shown (app decide response, audit).
export function sweepStrandedApprovals(user, now = Date.now(), audit = () => {}) {
  const list = loadActions(user);
  const swept = [];
  for (const a of list) {
    if (a.status !== 'approved') continue;
    // No timestamp at all cannot prove the executor is still running → close it.
    const started = a.executeStartedAt || a.decided || 0;
    if (now - started > EXEC_LIMBO_MINUTES * 60000) {
      a.status = 'failed'; a.error = 'interrupted · 执行中断'; a.done = now;
      swept.push(a);
      audit('action-interrupted', { who: user.id, action: a.id, type: a.type });
    }
  }
  if (swept.length) saveActions(user, list);
  return swept;
}

const flagMatch = (a, flag) => a.payload && a.payload.flag === flag;

// ── Retirement records（移除记录）─────────────────────────────────────────────
// Two shapes prove a retirement of a producer flag's reminder: an approved
// retire-reminder action (payload.retiredFlag) and the manual-delete mark
// recordReminderRetirement writes. Both anchor the adherence verdict to the
// REAL removal date and feed the retirement cooldown below.
const isRetirement = (a, flag) => !!a && !!a.payload
  && ((a.type === 'retire-reminder' && a.status === 'done' && a.payload.retiredFlag === flag)
    || (a.type === REMINDER_RETIRED_TYPE && a.payload.flag === flag));

// Latest retirement of `flag`'s reminder → { at } (epoch ms) or null.
export function latestRetirement(list, flag) {
  let at = 0;
  for (const a of list || []) if (isRetirement(a, flag)) at = Math.max(at, a.done || a.decided || a.created || 0);
  return at ? { at } : null;
}

// Retirement cooldown: a just-retired reminder's ORIGINAL flag is not
// re-proposed for RETIRED_COOLDOWN_DAYS — deleting a nudge is an answer, and
// the very next brief asking to recreate it would re-litigate it (R13 finding).
export function retiredRecently(user, flag, now = Date.now(), list = loadActions(user)) {
  if (!flag) return false;
  const r = latestRetirement(list, flag);
  return !!r && now - r.at <= RETIRED_COOLDOWN_DAYS * DAY_MS;
}

// The manual off switch (web.mjs DELETE /api/reminders/:id) leaves the SAME
// evidence an approved retire-reminder does. Callers hold the per-user lock.
export function recordReminderRetirement(user, rem, now = Date.now()) {
  const list = loadActions(user);
  const rec = { id: `retired-${rem.id}-${now}`, type: REMINDER_RETIRED_TYPE, status: 'done',
    title: ACTION_TYPES['retire-reminder'].label, summary: 'removed by hand · 手动移除',
    payload: { flag: rem.flag || null, reminderId: rem.id }, created: now, decided: now, done: now };
  list.push(rec);
  saveActions(user, list);
  return rec;
}

// Denial cooldown: was a proposal carrying this dedupe key (payload.flag)
// denied within the window? Producers skip such flags (never re-nag).
// `list` lets isFlagSuppressed share ONE parse across all three predicates.
export function deniedRecently(user, flag, now = Date.now(), list = loadActions(user)) {
  if (!flag) return false;
  return list.some((a) => a.status === 'denied' && flagMatch(a, flag)
    && now - (a.decided || a.created || 0) <= DENIED_COOLDOWN_DAYS * DAY_MS);
}

// Executed cooldown: an approved-and-done flag is not re-asked inside its
// window — re-approval would stack a duplicate side effect (reminders).
export function executedRecently(user, flag, now = Date.now(), list = loadActions(user)) {
  if (!flag) return false;
  return list.some((a) => a.status === 'done' && flagMatch(a, flag)
    && now - (a.done || a.decided || a.created || 0) <= EXECUTED_COOLDOWN_DAYS * DAY_MS);
}

// A flag with a proposal still awaiting decision must not be asked again
// (repeated manual brief runs would otherwise stack duplicate proposals).
export function hasOpenProposal(user, flag, list = loadActions(user)) {
  if (!flag) return false;
  return list.some((a) => a.status === 'pending' && flagMatch(a, flag));
}

// The producers' one suppression predicate: denied-recently OR executed-
// recently OR retired-recently OR still pending. One store parse total
// (efficiency finding: the old form parsed the file 2-3 times per flag).
export function isFlagSuppressed(user, flag, now = Date.now()) {
  if (!flag) return false;
  const list = loadActions(user);
  return deniedRecently(user, flag, now, list) || executedRecently(user, flag, now, list)
    || retiredRecently(user, flag, now, list) || hasOpenProposal(user, flag, list);
}

// Split a job's freshly proposed actions: pre-approved types（预批准）execute
// NOW via the registry; the rest stay pending for a human. Returns
// { pending, executed, failed } (failed = pre-approved whose executor threw).
export async function settleProposals(user, proposed, { preapproved = [], audit = () => {}, now = Date.now(), execute = executeAction } = {}) {
  const pending = [], executed = [], failed = [];
  for (const p of proposed || []) {
    if (!preapproved.includes(p.type)) { pending.push(p); continue; }
    const done = await approveAction(user, p.id, { execute, now });
    const ok = done && done.status === 'done';
    audit(ok ? 'action-preapproved-done' : 'action-preapproved-failed',
      { who: user.id, action: p.id, type: p.type, ...(done && done.error ? { error: done.error } : {}) });
    (ok ? executed : failed).push(done || p);
  }
  return { pending, executed, failed };
}

// Report pre-approved outcomes IN the saved briefing body（预批准执行）— the
// briefing asks about pending proposals elsewhere; executed/failed ones are
// stated as fact here, in-app and in the email alike.
export function annotateBriefing(user, briefing, settled) {
  if (!settled || (!settled.executed.length && !settled.failed.length)) return briefing;
  const stored = getBriefing(user, briefing.id) || briefing;
  const lines = ['', '## Actions · 行动'];
  for (const a of settled.executed) lines.push(`- done（预批准执行）: ${a.title}${a.result && a.result.note ? ' — ' + a.result.note : ''}`);
  for (const a of settled.failed) lines.push(`- FAILED（执行失败）: ${a.title} — ${a.error || 'unknown error'}`);
  const next = { ...stored, body: String(stored.body || '') + lines.join('\n') };
  delete next.html;   // the HTML part no longer says what the body says, so the email falls back to the text (docs/adr/0020)
  return saveBriefing(user, next);
}
