// Demo usage statistics · 演示使用统计 (ADR 0045, docs/demo-node.md "Demo admin"). Which apps each
// demo visitor opened and used, and how often, so the owner can improve the apps. COUNTS ONLY: no
// message text, prompt, search query or IP is ever recorded. A network appears only as the first 8 hex
// characters of the existing salted hashIp (lib/demo-quota.mjs), which changes nothing about what the
// quota file already holds.
//
// One rollup per UTC day: <root>/demo-usage/YYYY-MM-DD.json, written atomically, beside
// demo-users.json and outside every visitor workspace. Kept demo.usage_retention_days (config, read at
// use time; default USAGE_RETENTION_DAYS); older days are deleted on the first write of each day.
// The owner's own checks (TEST_IP, lib/demo-quota.mjs) are never counted.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from './atomicwrite.mjs';
import { readJsonState, FILE_OK } from './readjson.mjs';
import { TEST_IP, hashIp } from './demo-quota.mjs';
import { slugOk } from './webutil.mjs';

export const USAGE_DIR = 'demo-usage';
export const USAGE_RETENTION_DAYS = 90;
export const USAGE_KINDS = Object.freeze(['open', 'ai', 'build', 'edit']);
export const NET_HASH_LEN = 8;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DAY_MS = 86_400_000;
const RETENTION_MAX_DAYS = 3650;
const ID_RE = /^(anon|sb)-[0-9a-f]{16}$/;
export const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
export const netOf = (salt, ip) => hashIp(salt, ip).slice(0, NET_HASH_LEN);

// GET /app/<visitor id>/<slug>/ (the app's page itself, not its assets) → { uid, slug } | null.
// Counted for the app's own visitor: demo apps live in each visitor's workspace.
export function openedApp(p) {
  const m = /^\/app\/((?:anon|sb)-[0-9a-f]{16})\/([^/]+)\/(?:index\.html)?$/.exec(String(p || ''));
  return m && slugOk(m[2]) ? { uid: m[1], slug: m[2] } : null;
}

export function retentionDays(cfg) {
  const v = cfg && cfg.demo && typeof cfg.demo === 'object' ? cfg.demo.usage_retention_days : undefined;
  return Number.isInteger(v) && v >= 1 && v <= RETENTION_MAX_DAYS ? v : USAGE_RETENTION_DAYS;
}
const emptyDay = () => ({ visits: 0, new: 0, users: {}, nets: {} });

// d: { root, cfg, audit }. Every write is best effort: statistics must never block or fail a visit,
// a turn or a build, so a failure is audited (demo-usage-failed) and the caller carries on.
export function makeDemoUsage({ root, cfg, audit = () => {} }) {
  const dir = path.join(root, USAGE_DIR);
  let pruned = '';
  const fileOf = (day) => path.join(dir, `${day}.json`);
  function readDay(day) {
    const r = readJsonState(fileOf(day));
    const v = r.state === FILE_OK ? r.value : null;
    return v && typeof v === 'object' && v.users && v.nets ? v : emptyDay();   // a damaged day reads as empty; the next write replaces it
  }
  function prune(now) {
    const day = utcDay(now);
    if (pruned === day) return;
    pruned = day;
    const cut = utcDay(now - retentionDays(cfg) * DAY_MS);
    for (const f of fs.readdirSync(dir)) { const m = DAY_RE.exec(f); if (m && m[1] < cut) fs.rmSync(path.join(dir, f), { force: true }); }
  }
  function change(fn, now) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      prune(now);
      const day = utcDay(now), v = readDay(day);
      fn(v);
      writeJsonFile(fileOf(day), v);
    } catch (e) { audit('demo-usage-failed', { error: String((e && e.message) || e).slice(0, 200) }); /* counts only: the visitor's request goes on */ }
  }
  // One action of a visitor: kind ∈ USAGE_KINDS; app is a slug or '' (an AI call with no app).
  function track(userId, { kind, app = '', ip, now = Date.now() }) {
    if (ip === TEST_IP || !ID_RE.test(userId || '') || !USAGE_KINDS.includes(kind)) return;
    const slug = typeof app === 'string' && slugOk(app) ? app : '';
    change((v) => {
      const u = (v.users[userId] ||= { apps: {}, ai: 0, first: now, last: now });
      u.last = now;
      if (kind === 'ai') u.ai += 1;
      if (slug) { const a = (u.apps[slug] ||= { open: 0, ai: 0, build: 0, edit: 0 }); a[kind] += 1; }
    }, now);
  }
  // A session start (every visit; isNew = a first visit), per network short hash.
  function visit({ salt, ip, isNew, now = Date.now() }) {
    if (ip === TEST_IP) return;
    change((v) => {
      const n = (v.nets[netOf(salt, ip)] ||= { visits: 0, new: 0 });
      n.visits += 1; v.visits += 1;
      if (isNew) { n.new += 1; v.new += 1; }
    }, now);
  }
  // Delete my account: the visitor goes from every kept day.
  function dropUser(userId) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = DAY_RE.exec(f); if (!m) continue;
      const v = readDay(m[1]);
      if (v.users[userId]) { delete v.users[userId]; writeJsonFile(fileOf(m[1]), v); }
    }
  }
  // The last `n` days, oldest first: [{ day, ...rollup }].
  function days(n, now = Date.now()) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) { const day = utcDay(now - i * DAY_MS); out.push({ day, ...readDay(day) }); }
    return out;
  }
  return { track, visit, dropUser, days };
}
