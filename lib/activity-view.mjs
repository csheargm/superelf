// Settings → Activity log · 活动记录 — what the owner's view keeps (owner decision, 2026-11-24).
//
// The audit file stays whole (it is the node's forensic record). The VIEW keeps three kinds only:
//   security — failed sign-ins, members added / approved / removed, password and key changes;
//   failure  — a job, backup, publish, setup or health step that failed;
//   app      — an app changed: which app, who, the request text when stored (lib/app-history.mjs),
//              with Undo / See the difference where an archived version still exists.
// Routine rows (successful sign-ins, job runs, built-in app updates, searches …) are dropped here.
// GET /api/admin/activity answers it; GET /api/admin/activity/diff shows one change. Owner only.
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

// 'security' | 'failure' | 'app' | null (routine: not shown).
export function activityKind(r) {
  const ev = String((r && r.ev) || '');
  if (ev === 'login' || ev === 'setup') return r.ok === false ? 'security' : null;
  if (SECURITY.has(ev)) return 'security';
  if (ev === 'app-edit') return r.applied === true ? 'app' : r.changed === true ? 'failure' : null;   // changed + rolled back = a failed change
  if (ev === 'app-edit-undo') return r.undone ? 'app' : null;
  if (ev === 'app-publish') return r.state === 'failed' ? 'failure' : 'app';
  if (APP.has(ev)) return 'app';
  if (FAILED_RE.test(ev) || FAILED_EVENTS.has(ev) || r.ok === false) return 'failure';
  return null;
}

// Newest first, kept rows only, app-edit rows carrying the stored request and what can be done.
// historyOf(slug) → listHistory rows (newest first) of the owner's own workspace.
export function activityRows(rows, historyOf, max = ACTIVITY_MAX) {
  const out = [], newestEdit = new Set();
  for (const r of [...rows].reverse()) {
    const kind = activityKind(r);
    if (!kind) continue;
    const row = { ...r, kind };
    if (r.ev === 'app-edit' && kind === 'app' && r.version && slugOk(String(r.app || ''))) Object.assign(row, editFacts(r, historyOf(r.app), newestEdit));
    if (row.error) row.error = String(row.error).slice(0, 160);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}
function editFacts(r, hist, newestEdit) {
  const h = hist.find((x) => x.name === r.version);
  if (!h) return {};
  // Undo undoes the NEWEST step only (lib/app-versions.mjs undoLastEdit): offered on that row alone.
  const canUndo = !newestEdit.has(r.app) && hist[0].name === r.version && hist[0].why === EDIT_WHY;
  newestEdit.add(r.app);
  return { request: h.request, canDiff: true, canUndo };
}

// The difference ONE change made: its "before" copy against the next copy, or the live app if newest.
export function changeDiff(wsDir, slug, version) {
  if (!slugOk(slug)) throw Object.assign(new Error('no such app'), { code: 404 });
  const root = path.join(wsDir, VERSIONS_DIR), hist = listHistory(root, slug);
  const i = hist.findIndex((x) => x.name === version);
  if (i < 0) throw Object.assign(new Error('这个版本已不在 · That version is no longer kept'), { code: 404 });
  const after = i > 0 ? path.join(root, slug, hist[i - 1].name) : path.join(wsDir, 'apps', slug);
  return diffTrees(path.join(root, slug, version), after) || '（没有差别 · No difference）';
}

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
