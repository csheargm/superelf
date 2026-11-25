// Settings → Activity log · 活动记录 — what the owner's view keeps (owner decision, 2026-11-24).
//
// The audit file stays whole (it is the node's forensic record). The VIEW keeps three kinds only:
//   security — failed sign-ins, members added / approved / removed, password and key changes;
//   failure  — a job, backup, publish, setup or health step that failed;
//   app      — an app changed: which app, who, the request text when stored (lib/app-history.mjs),
//              with Undo / See the difference where an archived version still exists.
// Routine rows (successful sign-ins, job runs, built-in app updates, searches …) are dropped here.
// GET /api/admin/activity answers it; GET /api/admin/activity/diff shows one change. Owner only.
import fs from 'node:fs';
import path from 'node:path';
import { readAuditTail } from './jobstatus.mjs';
import { listHistory, diffTrees } from './app-history.mjs';
import { VERSIONS_DIR } from './app-edit.mjs';
import { EDIT_WHY } from './app-versions.mjs';
import { slugOk } from './webutil.mjs';

export const ACTIVITY_MAX = 50;
export const ACTIVITY_RE = /^\/api\/admin\/activity(\/diff)?$/;
const SECURITY = new Set(['create', 'delete', 'approve', 'register', 'password-reset', 'set-pin', 'token-rotate']);
const APP = new Set(['app-edit', 'app-edit-undo', 'rollback', 'fork', 'share', 'unshare', 'app-publish', 'app-update']);
const FAILED_RE = /-(failed|error)$/;
const FAILED_EVENTS = new Set(['job-retries-exhausted', 'model-gone']);
// Critical failures (docs/adr/0041): pinned on top for a week, never cut off by the row cap.
const CRITICAL = new Set(['node-health-failed', 'job-retries-exhausted', 'save-data-failed']);
export const PIN_MS = 7 * 24 * 3600_000;

// 'security' | 'failure' | 'app' | null (routine: not shown).
export function activityKind(r) {
  const ev = String((r && r.ev) || '');
  if (ev === 'login' || ev === 'setup') return r.ok === false ? 'security' : null;
  if (SECURITY.has(ev)) return 'security';
  if (ev === 'app-edit') return r.applied === true ? 'app' : r.changed === true ? 'failure' : null;   // changed + rolled back = a failed change
  if (ev === 'app-edit-undo') return r.undone ? 'app' : null;
  if (ev === 'app-publish') return r.state === 'failed' || r.state === 'blocked' ? 'failure' : 'app';   // else: publishing started (the outcome comes later)
  if (APP.has(ev)) return 'app';
  if (FAILED_RE.test(ev) || FAILED_EVENTS.has(ev) || r.ok === false) return 'failure';
  return null;
}

// Newest first, kept rows only, app-edit rows carrying the stored request and what can be done.
// historyOf(slug) → listHistory rows (newest first) of the owner's own workspace.
export function activityRows(rows, historyOf, max = ACTIVITY_MAX, now = Date.now()) {
  const out = [], newestEdit = new Set();
  for (const r of [...rows].reverse()) {
    const kind = activityKind(r);
    if (!kind) continue;
    const crit = CRITICAL.has(r.ev) && now - Date.parse(r.at) < PIN_MS;
    if (out.length >= max && !crit) continue;   // past the cap: only pinned rows still come through
    const row = { ...r, kind, ...(crit ? { crit: true } : {}) };
    if (r.ev === 'app-edit' && kind === 'app' && r.version && slugOk(String(r.app || ''))) Object.assign(row, editFacts(r, historyOf(r.app), newestEdit));
    if (row.error) row.error = String(row.error).slice(0, 160);
    out.push(row);
  }
  return out;
}
function editFacts(r, hist, newestEdit) {
  const h = hist.find((x) => x.name === r.version);
  if (!h) return {};
  // Undo restores the newest EDIT copy (lib/app-versions.mjs undoLastEdit): offered on that row alone.
  const next = hist.find((x) => x.why === EDIT_WHY);
  const canUndo = !newestEdit.has(r.app) && !!next && next.name === r.version;
  newestEdit.add(r.app);
  return { request: h.request, canDiff: true, canUndo };
}

// The difference ONE change made: its "before" copy against the next copy, or the live app if newest.
export function changeDiff(wsDir, slug, version) {
  if (!slugOk(slug)) throw Object.assign(new Error('no such app'), { code: 404 });
  const root = path.join(wsDir, VERSIONS_DIR), hist = listHistory(root, slug);
  const i = hist.findIndex((x) => x.name === version);
  if (i < 0) throw Object.assign(new Error('这个版本已不在 · That version is no longer kept'), { code: 404 });
  // "After" = the next newer EDIT copy (the state right before the next change), else the live app.
  // An undo copy is skipped: it holds a later change that undo already took back.
  const newer = hist.slice(0, i).reverse().find((x) => x.why === EDIT_WHY);
  const after = newer ? path.join(root, slug, newer.name) : path.join(wsDir, 'apps', slug);
  // The live app is read only through real folders (no link from the workspace down): never outside it.
  if (!newer && ![path.join(wsDir, 'apps'), after].every(realFolder)) throw Object.assign(new Error('no such app'), { code: 404 });
  return diffTrees(path.join(root, slug, version), after) || '（没有差别 · No difference）';
}

// Undo from a log row names its version: refused (409) if a newer change landed since the row was shown.
// The version the next Undo takes back ('' when none): the shell's ⋯ sends it with its Undo (web/app-edit.js).
export function newestEditVersion(wsDir, slug) {
  const next = listHistory(path.join(wsDir, VERSIONS_DIR), slug).find((x) => x.why === EDIT_WHY);
  return next ? next.name : '';
}
export function refuseStaleUndo(wsDir, slug, version) {
  if (version === null || version === undefined) return;   // the panel's own Undo: always the newest change
  if (!version || newestEditVersion(wsDir, slug) !== version) throw Object.assign(new Error('这之后应用又改过了，请刷新 · The app changed again since; refresh and try again'), { status: 409, code: 'undo_stale' });
}

const realFolder = (p) => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; /* absent = no app */ } };

const json = (send, res, code, body) => send(res, code, 'application/json', JSON.stringify(body));
// ctx: { user, cfg, send, demo, wsDir }. Returns true when it answered.
export function handleActivityRoute(req, res, p, url, ctx) {
  const m = ACTIVITY_RE.exec(p);
  if (!m) return false;
  const { user, send } = ctx;
  if (ctx.demo || !user || user.role !== 'owner') { json(send, res, 403, { error: '仅主人 · Owner only' }); return true; }
  if (req.method !== 'GET') { json(send, res, 405, { error: 'method' }); return true; }
  const ws = ctx.wsDir(user);
  if (!m[1]) {
    const rows = activityRows(readAuditTail(ctx.cfg.auditFile), (slug) => listHistory(path.join(ws, VERSIONS_DIR), slug));
    json(send, res, 200, rows);
    return true;
  }
  try { json(send, res, 200, { text: changeDiff(ws, String(url.searchParams.get('app') || ''), String(url.searchParams.get('v') || '')) }); }
  catch (e) { if (!Number.isInteger(e.code)) throw e; json(send, res, e.code, { error: e.message }); }
  return true;
}
