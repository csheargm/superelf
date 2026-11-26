// The autonomous-actions engine.
//
// Two kinds of autonomous work, split by the SAFE-ACTION POLICY:
//   - digest  (read-only): summarize health / news / a tool's reading → a "briefing".
//                          Reading can't hurt you, so it runs fully automatically.
//   - propose (side-effecting): draft a reply, suggest a reschedule → a "pending
//                          action". Never executed until a human taps Approve.
//
// The policy is enforced by SEPARATION, not by trusting a prompt:
//   phase 1 (propose) runs the agent WITHOUT write tools — it can only draft and
//   queue; phase 2 (execute) runs only after approval, for that one action.
//
// All state lives in the user's own workspace (gitignored personal data), mirroring
// the conversations store — never in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonFile } from './webutil.mjs';

const sub = (user, name) => path.join(user.workspace, name);
const idOk = (s) => typeof s === 'string' && /^[\w.-]{1,80}$/.test(s);

// ── Briefings (read-only digests) ─────────────────────────────────────────────
function briefingsDir(user) { return sub(user, 'briefings'); }

export function saveBriefing(user, brief) {
  if (!idOk(brief.id)) throw new Error('briefing id invalid');
  writeJsonFile(path.join(briefingsDir(user), brief.id + '.json'), brief);
  return brief;
}

// Rolling retention for recurring briefing classes (reminder fires): keep the
// newest `keep` briefings of `job`, delete the rest. A daily reminder must not
// grow the store (and the app's 简报 list) by one permanent file per fire.
export function pruneBriefings(user, job, keep) {
  const d = briefingsDir(user);
  if (!fs.existsSync(d)) return 0;
  const stale = fs.readdirSync(d).filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, b: readJson(path.join(d, f), null) }))
    .filter((x) => x.b && x.b.job === job)
    .sort((a, b) => (b.b.created || 0) - (a.b.created || 0))
    .slice(keep);
  for (const x of stale) fs.unlinkSync(path.join(d, x.f));
  return stale.length;
}

export function listBriefings(user, days) {
  const d = briefingsDir(user);
  if (!fs.existsSync(d)) return [];
  const cutoff = (typeof days === 'number' && days > 0) ? Date.now() - days * 86_400_000 : 0;
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(d, f), null))
    .filter(Boolean)
    .filter((b) => !cutoff || (b.created || 0) >= cutoff)
    .map((b) => ({ id: b.id, title: b.title, job: b.job, created: b.created,
      preview: String(b.body || '').replace(/[#*`>_~\n]+/g, ' ').trim().slice(0, 140) }))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}

export function getBriefing(user, id) {
  if (!idOk(id)) return null;
  return readJson(path.join(briefingsDir(user), id + '.json'), null);
}

// ── Pending actions (side-effecting → need approval) ──────────────────────────
function actionsFile(user) { return sub(user, 'pending-actions.json'); }
// ENOENT = no actions yet ([]). A CORRUPT file THROWS — it must never read as
// [] and then be rewritten empty by the next mutation, silently wiping every
// pending proposal AND the denial-cooldown history (R5: callers audit + skip).
export function loadActions(user) {
  let txt;
  try { txt = fs.readFileSync(actionsFile(user), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const l = JSON.parse(txt);
  if (!Array.isArray(l)) throw new Error('pending-actions.json is not an array');
  return l;
}
// Exported for lib/actions.mjs batch sweeps (one read + one write per sweep).
export function saveActions(user, list) { writeJsonFile(actionsFile(user), list); }

export function proposeAction(user, action) {
  if (!idOk(action.id)) throw new Error('action id invalid');
  const list = loadActions(user);
  if (list.some((a) => a.id === action.id)) return list.find((a) => a.id === action.id); // idempotent
  const a = {
    id: action.id, type: String(action.type || 'unknown'), title: action.title || '(untitled action)',
    summary: action.summary || '', payload: action.payload || {}, job: action.job || null,
    status: 'pending', created: action.created || null,
  };
  list.push(a); saveActions(user, list); return a;
}

export function pendingActions(user) { return loadActions(user).filter((a) => a.status === 'pending'); }

export function setActionStatus(user, id, status, extra = {}) {
  const list = loadActions(user);
  const a = list.find((x) => x.id === id);
  if (!a) return null;
  a.status = status;
  Object.assign(a, extra);
  saveActions(user, list);
  return a;
}

// ── Safe-action policy ────────────────────────────────────────────────────────
// Read-only action types may run automatically; everything else queues for a human.
// The list is deliberately small and explicit — an unknown type is treated as
// side-effecting (fail safe), never auto-run.
const READONLY_TYPES = new Set(['summarize', 'digest', 'read', 'search', 'draft', 'none']);
export function isReadOnly(type) { return READONLY_TYPES.has(String(type || '').toLowerCase()); }

// ── Job runner ────────────────────────────────────────────────────────────────
// A job = { name, title, type: 'digest'|'propose', prompt, lane }.
// deps.run(user, job) does the actual work (agent call or stub) and returns
//   { body, actions:[{type,title,summary,payload}] }.
// This layer is pure orchestration + storage, so it's testable without the agent.
export async function runJob(user, job, deps = {}) {
  const now = deps.now || Date.now();
  const run = deps.run;
  if (typeof run !== 'function') throw new Error('runJob needs deps.run(user, job)');
  const result = await run(user, job);
  // null/undefined = the job DECLINED to report (e.g. no threshold fired today).
  // Intentional silence — distinct from a throw (failure) and from an empty
  // briefing (which R14 forbids: an empty "all good" must never be stored).
  if (result == null) return { briefing: null, proposed: [], skipped: true };
  const briefing = saveBriefing(user, {
    id: `${job.name}-${now}`, job: job.name, title: (typeof result.subject === 'string' && result.subject.trim()) || job.title || job.name,   // subject: a job's own email subject (only the nightly review, docs/adr/0046)
    body: result.body || '', created: now,
    // Where this output should go. Carried onto the briefing so the push layer can honour
    // it without re-reading the job; a built-in carries none and is pushed as before.
    deliver: job.deliver || null,
    // An optional HTML rendering of the same body, for the email only (lib/notify.mjs; the app
    // shows `body`). Only the model review sends one (docs/adr/0020); every other job has none.
    ...(typeof result.html === 'string' && result.html.trim() ? { html: result.html } : {}),
  });
  const proposed = (result.actions || []).map((act, i) =>
    proposeAction(user, { ...act, id: `${briefing.id}-a${i}`, job: job.name, created: now }));
  // failed: the job reported, but its run did not succeed (the nightly review, every project failed): the Jobs view says failed.
  return { briefing, proposed, ...(result.failed === true ? { failed: true } : {}) };
}

// Approve → execute exactly this one action (phase 2). deps.execute(user, action)
// performs the real side effect (agent call with the write tool); a stub just
// records it. Read-only actions never reach here — they auto-run in phase 1.
// ONLY a pending action can be approved: an already-decided or expired one is
// returned unchanged and its executor NEVER runs again (double-tap / replayed
// callback safety — the approval loop's idempotency guard).
export async function approveAction(user, id, deps = {}) {
  const cur = loadActions(user).find((x) => x.id === id);
  if (!cur) return null;
  if (cur.status !== 'pending') return cur;
  // 'approved' + executeStartedAt are persisted BEFORE the executor runs, so a
  // crash mid-execution leaves a timestamped record the limbo sweep can close
  // (lib/actions.mjs sweepStrandedApprovals) instead of an invisible zombie.
  const a = setActionStatus(user, id, 'approved', { decided: deps.now || Date.now(), executeStartedAt: deps.now || Date.now() });
  try {
    const out = deps.execute ? await deps.execute(user, a) : { ok: true, note: 'no-op (stub)' };
    return setActionStatus(user, id, 'done', { result: out, done: deps.now || Date.now() });
  } catch (e) {
    return setActionStatus(user, id, 'failed', { error: String(e && e.message || e) });
  }
}

// Deny records WHEN (`decided`) so producers can honor the denial cooldown
// (lib/actions.mjs deniedRecently). Same only-pending guard as approve.
export function denyAction(user, id, now = Date.now()) {
  const cur = loadActions(user).find((x) => x.id === id);
  if (!cur) return null;
  if (cur.status !== 'pending') return cur;
  return setActionStatus(user, id, 'denied', { decided: now });
}
