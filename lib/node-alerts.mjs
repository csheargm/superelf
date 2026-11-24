// Owner alerts · 需要处理 (docs/adr/0041-owner-alerts.md). The rare critical problems a node owner must
// act on, and the FIXED host actions that fix them. Owner only, checked here on the server.
//
// Sources (reused, none invented): the host's daily health check writes NODE_HEALTH_FILE in the
// node folder on every run (ops/private/superelf-health.sh, private overlay); a job that failed
// every retry (audit 'job-retries-exhausted', lib/jobruns.mjs) until it next runs ok.
//
// Host action channel: the container cannot run docker, so a request is a FILE with a fixed name in
// <node>/.node-actions/req/; a host systemd path unit runs ONLY the matching fixed script, writes
// <node>/node-action-<name>.json (resultFile), then removes the request. Nothing from the request passes through: the file is
// empty. An action is offered only when the host's health file lists it (no host responder, no button).
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './readjson.mjs';
import { readAuditTail } from './jobstatus.mjs';
import { writeJsonFile } from './atomicwrite.mjs';

// The ONE list of host actions (R3): the private overlay's superelf-node-actions.sh is pinned to it.
export const NODE_ACTIONS = Object.freeze(['cleanup-disk', 'rebuild-node', 'recheck']);
export const NODE_HEALTH_FILE = 'node-health.json';
export const ACTIONS_DIR = '.node-actions';
export const SNOOZE_FILE = 'node-alerts-snooze.json';
export const resultFile = (action) => `node-action-${action}.json`;
export const ALERTS_RE = /^\/api\/admin\/alerts(?:\/(action|snooze))?$/;
export const ACTION_GAP_MS = 60_000;          // one request per action per minute (the host has its own lock)
export const SNOOZE_MAX_MS = 24 * 3600_000;   // "Not today" lasts at most a day
export const JOB_ALERT_DAYS = 7;              // an old failure that nobody re-ran stops nagging
const DAY_MS = 24 * 3600_000;
const HEALTH_KINDS = new Set(['disk', 'disk-unreadable', 'claude']);
const BOXES = new Set(['system', 'private', 'demo', 'other']);

// The host's health file → alerts. A missing or damaged file means no host checker: no alerts.
export function healthAlerts(health) {
  if (!health || health.ok !== false || !Array.isArray(health.problems)) return [];
  return health.problems.filter((x) => x && HEALTH_KINDS.has(x.kind)).map((x) => {
    const box = BOXES.has(x.box) ? x.box : 'other';
    if (x.kind === 'claude') return { id: 'claude', kind: 'claude' };
    return { id: `${x.kind}:${box}`, kind: x.kind, box, ...(Number.isInteger(x.pct) ? { pct: x.pct } : {}) };
  });
}

// The owner's own jobs whose LATEST outcome is "failed every retry", within JOB_ALERT_DAYS.
export function jobAlerts(entries, ownerId, now = Date.now()) {
  const last = new Map();
  for (const e of entries) {
    if (!e || e.who !== ownerId || typeof e.job !== 'string') continue;
    if (e.ev === 'job-run' || e.ev === 'job-failed' || e.ev === 'job-retries-exhausted') last.set(e.job, e);
  }
  return [...last.values()].filter((e) => e.ev === 'job-retries-exhausted' && now - Date.parse(e.at) < JOB_ALERT_DAYS * DAY_MS)
    .map((e) => ({ id: `job:${e.job}`, kind: 'job', job: e.job.slice(0, 80), at: e.at }));
}

const nodeDir = (cfg) => path.dirname(cfg.auditFile);
const realDir = (p) => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

export function hostActions(health) {
  return Array.isArray(health && health.actions) ? NODE_ACTIONS.filter((a) => health.actions.includes(a)) : [];
}
function actionState(dir) {
  const req = path.join(dir, ACTIONS_DIR, 'req');
  const pending = realDir(req) ? NODE_ACTIONS.filter((a) => fs.existsSync(path.join(req, a))) : [];
  const results = {};
  for (const a of NODE_ACTIONS) {
    const r = readJson(path.join(dir, resultFile(a)), null);
    if (r && typeof r.at === 'string') results[a] = { at: r.at, ok: r.ok === true, msg: String(r.msg || '').slice(0, 300) };
  }
  return { pending, results };
}

export function readSnoozes(dir, now = Date.now()) {
  const s = readJson(path.join(dir, SNOOZE_FILE), {});
  return Object.fromEntries(Object.entries(s && typeof s === 'object' ? s : {}).filter(([, u]) => Date.parse(u) > now));
}

export function alertsView(cfg, ownerId, now = Date.now()) {
  const dir = nodeDir(cfg);
  const health = readJson(path.join(dir, NODE_HEALTH_FILE), null);
  const snoozed = readSnoozes(dir, now);
  const alerts = [...healthAlerts(health), ...jobAlerts(readAuditTail(cfg.auditFile), ownerId, now)]
    .map((a) => ({ ...a, snoozed: !!snoozed[a.id] }));
  return { alerts, checkedAt: health && typeof health.at === 'string' ? health.at : null, actions: hostActions(health), ...actionState(dir) };
}

// Writes the empty request file. Throws {code} on refusal; never follows a link, never overwrites.
const lastAsk = new Map();
export function requestAction(cfg, name, now = Date.now()) {
  if (!NODE_ACTIONS.includes(name)) throw Object.assign(new Error('unknown action'), { code: 400 });
  const dir = nodeDir(cfg);
  if (!hostActions(readJson(path.join(dir, NODE_HEALTH_FILE), null)).includes(name)) throw Object.assign(new Error('this node has no host helper for that'), { code: 409 });
  const base = path.join(dir, ACTIONS_DIR), req = path.join(base, 'req');
  for (const d of [base, req]) { if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 }); if (!realDir(d)) throw Object.assign(new Error('action folder is not a plain folder'), { code: 500 }); }
  if (NODE_ACTIONS.some((a) => fs.existsSync(path.join(req, a)))) throw Object.assign(new Error('another action is still running'), { code: 409 });
  if (now - (lastAsk.get(name) || 0) < ACTION_GAP_MS) throw Object.assign(new Error('just asked; wait a minute'), { code: 429 });
  try { fs.writeFileSync(path.join(req, name), '', { flag: 'wx', mode: 0o600 }); }   // wx: fails on any existing entry, a link included
  catch (e) { if (e.code === 'EEXIST') throw Object.assign(new Error('already asked'), { code: 409 }); throw e; }
  lastAsk.set(name, now);
}
export const resetActionGaps = () => lastAsk.clear();   // tests

export function snooze(cfg, id, until, now = Date.now()) {
  if (typeof id !== 'string' || !/^[a-z-]+(:[\w .-]{1,80})?$/.test(id)) throw Object.assign(new Error('bad alert id'), { code: 400 });
  const t = Math.min(Date.parse(until) || now + SNOOZE_MAX_MS, now + SNOOZE_MAX_MS);
  const dir = nodeDir(cfg), s = readSnoozes(dir, now);
  s[id] = new Date(t).toISOString();
  writeJsonFile(path.join(dir, SNOOZE_FILE), s);
}

const json = (send, res, code, body) => send(res, code, 'application/json', JSON.stringify(body));
// Returns true when it answered. ctx: { user, cfg, readBody, send, audit, demo }
export async function handleAlertsRoute(req, res, p, ctx) {
  const m = ALERTS_RE.exec(p);
  if (!m) return false;
  const { user, cfg, send } = ctx;
  if (ctx.demo || !user || user.role !== 'owner') { json(send, res, 403, { error: '仅主人 · Owner only' }); return true; }
  if (!m[1] && req.method === 'GET') { json(send, res, 200, alertsView(cfg, user.id)); return true; }
  if (!m[1] || req.method !== 'POST') { json(send, res, 405, { error: 'method' }); return true; }
  const b = await ctx.readBody(req);
  try {
    if (m[1] === 'action') { requestAction(cfg, String(b && b.action || '')); ctx.audit('node-action', { who: user.id, action: b.action }); json(send, res, 202, { ok: true }); }
    else { snooze(cfg, b && b.id, b && b.until); json(send, res, 200, { ok: true }); }
  } catch (e) {
    if (!Number.isInteger(e.code)) throw e;
    json(send, res, e.code, { error: e.message });
  }
  return true;
}
