// Public-demo quotas · 公开演示配额 (docs/demo-node.md). ONE module for every demo limit: AI calls
// per user and per client IP per UTC day, new anonymous users per IP per day, a per-user disk cap
// and a total disk ceiling for the whole demo node.
//
// Ported from bible_app's edge functions (supabase/functions/_shared/clientIp.ts, ai-proxy/caps.ts,
// ADR-0013): the caller's IP is cf-connecting-ip; only a salted SHA-256 of it is ever stored; caps are counted per UTC day; a full cap
// is a 429 with a reason, never a silent failure. Here traffic arrives only through the Cloudflare
// Tunnel (the container publishes no port), so cf-connecting-ip is the one header Cloudflare sets.
// Unlike bible_app, x-forwarded-for is NOT trusted (nothing here proves who set it): without
// cf-connecting-ip the socket address counts, so such callers all share one bucket.
//
// Every number is read from config.json "demo" at USE time (a config edit needs no restart); a
// missing or invalid value falls back to DEMO_DEFAULTS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from './atomicwrite.mjs';
import { readJsonState, FILE_OK, FILE_UNREADABLE } from './readjson.mjs';

export const DEMO_DEFAULTS = Object.freeze({
  ai_calls_per_user_per_day: 30,
  ai_calls_per_ip_per_day: 150,
  new_users_per_ip_per_day: 10,
  sessions_per_ip_per_day: 50,
  user_disk_mb: 20,
  total_disk_gb: 5,
  save_max_mb: 2,
  chat_timeout_s: 120,
  reply_max_kb: 256,
  searches_per_user_per_day: 200,
  parallel_saves: 8,
  parallel_chats: 16,
  searches_per_ip_per_day: 600,
  app_max_kb: 200,      // one demo-made app page (lib/demo-app.mjs)
  apps_per_user: 20,
  app_builds_per_user_per_day: 5,   // app requests (each may take 2 model calls)
  app_builds_per_ip_per_day: 15,    // a fresh anonymous id per cookie must not reset it
  web_search_per_day: 10,           // Ollama web searches per visitor
  web_search_per_ip_per_day: 50,
  ai_calls_node_per_day: 3000,      // the whole node: a ceiling on hosted-model cost
});
const MB = 1024 * 1024, GB = 1024 * MB;
export const DEMO_QUOTA_FILE = 'demo-quota.json';
const DISK_CACHE_MS = 30_000;   // a full walk of the demo tree at most this often per folder

// Bilingual (EN + 中文) refusals, one per cap. `code` is stable for clients and tests.
export const QUOTA_MESSAGES = Object.freeze({
  ai_user: 'Daily AI limit reached for this demo visitor — please come back tomorrow · 今日 AI 次数已用完，请明天再来',
  ai_ip: 'Daily AI limit reached for your network — please come back tomorrow · 您所在网络今日 AI 次数已用完，请明天再来',
  new_user: 'Too many new demo visitors from your network today — please try tomorrow · 您所在网络今日新访客过多，请明天再试',
  sessions: 'Too many demo sessions from your network today — please try tomorrow · 您所在网络今日会话过多，请明天再试',
  disk_user: 'Your demo storage is full — no more can be saved · 您的演示存储已满，无法再保存',
  too_big: 'That is too large to save in the demo · 内容过大，演示版无法保存',
  reply_long: 'The reply was too long for the demo and was stopped · 回复过长，演示版已停止',
  app_builds: 'Daily app-building limit reached for this demo visitor — please come back tomorrow · 今日建应用次数已用完，请明天再来',
  web_search: 'Daily web-search limit reached — answering from what the model already knows · 今日联网搜索次数已用完，以下回答不含最新网络信息',
  ai_node: 'The public demo has reached today\'s AI limit — please come back tomorrow · 公开演示今日 AI 总量已用完，请明天再来',
  search: 'Daily search limit reached — please come back tomorrow · 今日搜索次数已用完，请明天再来',
  disk_total: 'The public demo is out of storage right now — please try later · 公开演示存储已满，请稍后再试',
});

// SUPERELF_DEMO=1 (the demo container's compose file) forces demo mode on whatever config.json
// says, so a restored or hand-edited config can never open the full route table to the internet.
export const demoOn = (cfg) => process.env.SUPERELF_DEMO === '1' || cfg.demo === true || (!!cfg.demo && typeof cfg.demo === 'object' && cfg.demo.enabled === true);

export function demoLimit(cfg, key) {
  const v = cfg.demo && typeof cfg.demo === 'object' ? cfg.demo[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEMO_DEFAULTS[key];
}

// cf-connecting-ip is trusted only behind Cloudflare: in the demo container (SUPERELF_DEMO=1,
// reachable only through the tunnel) or when config says "behind_cloudflare": true. Otherwise a
// caller could pick its own bucket, so the socket address counts.
export const trustCf = (cfg) => process.env.SUPERELF_DEMO === '1' || !!(cfg.demo && cfg.demo.behind_cloudflare === true);
export function clientIp(headers, remote, cf = true) {
  return (cf && String(headers['cf-connecting-ip'] || '').trim()) || String(remote || '').trim() || 'unknown';
}
export const hashIp = (salt, ip) => crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

// The per-day counters, in <root>/demo-quota.json. A damaged file is NOT reset to zero (that
// would hand everyone a fresh day): it throws, and the caller refuses the call (fail closed).
export function makeQuotaStore(file) {
  const load = (now) => {
    const r = readJsonState(file);
    if (r.state === FILE_UNREADABLE) throw new Error(`demo quota file unreadable: ${r.error}`);
    if (r.state !== FILE_OK) return { salt: crypto.randomBytes(16).toString('hex'), day: utcDay(now), counts: {} };   // first use
    const v = r.value;
    const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
    const okCounts = (c) => isObj(c) && Object.values(c).every((n) => Number.isInteger(n) && n >= 0);
    if (!isObj(v) || typeof v.salt !== 'string' || !v.salt || !/^\d{4}-\d{2}-\d{2}$/.test(v.day || '') || !okCounts(v.counts)) {
      throw new Error('demo quota file is damaged');
    }
    if (v.day !== utcDay(now)) return { salt: v.salt, day: utcDay(now), counts: {} };
    return { salt: v.salt, day: v.day, counts: v.counts };
  };
  // Check every [key, limit] pair, then count all of them — or none when any is full.
  function consume(pairs, now = Date.now()) {
    const s = load(now);
    const full = pairs.find(([key, limit]) => (s.counts[key] || 0) >= limit);
    if (full) return { ok: false, key: full[0] };
    for (const [key] of pairs) s.counts[key] = (s.counts[key] || 0) + 1;
    writeJsonFile(file, s);
    return { ok: true };
  }
  // Delete-account: every per-visitor counter row of `userId` goes (per-IP and node rows stay).
  function dropUser(userId, now = Date.now()) {
    const s = load(now);
    for (const k of Object.keys(s.counts)) if (k.slice(k.indexOf(':') + 1) === userId) delete s.counts[k];
    writeJsonFile(file, s);
  }
  return { consume, dropUser, salt: (now = Date.now()) => { const s = load(now); if (!fs.existsSync(file)) writeJsonFile(file, s); return s.salt; } };
}

// Bytes under a folder, links not followed (a link costs its own size only). Every entry costs
// whole file-system blocks (rounded up, at least one), as ext4 allocates them, so neither many tiny
// files nor sizes just over a block boundary hide inside the cap.
const BLOCK = 4096;
export function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }   // a folder not made yet holds nothing
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { total += BLOCK; walk(p); }
      else { try { total += Math.max(1, Math.ceil(fs.lstatSync(p).size / BLOCK)) * BLOCK; } catch (err) { if (err.code !== 'ENOENT') throw err; /* deleted mid-walk */ } }
    }
  };
  walk(dir);
  return total;
}

// Audit lines on a demo node: at most AUDIT_PER_HOUR per event kind, so no visitor-triggered event
// (a failing index, a refused call) can grow the shared audit.log without bound.
const AUDIT_PER_HOUR = 60, HOUR = 3600_000, AUDIT_FIELD_MAX = 200;
export function limitAudit(audit, on) {
  const seen = new Map();
  return (ev, extra) => {
    if (on()) {
      const now = Date.now(), s = seen.get(ev);
      if (!s || now - s.at >= HOUR) seen.set(ev, { at: now, n: 1 });
      else if (++s.n > AUDIT_PER_HOUR) return;
      // ...and short: a caller-supplied field (a save path) is cut to AUDIT_FIELD_MAX characters.
      extra = Object.fromEntries(Object.entries(extra || {}).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, AUDIT_FIELD_MAX) : v]));
    }
    audit(ev, extra);
  };
}

export function makeDiskMeter(ttlMs = DISK_CACHE_MS) {
  const cache = new Map();
  return (dir, now = Date.now()) => {
    const hit = cache.get(dir);
    if (hit && now - hit.at < ttlMs) return hit.bytes;
    const bytes = dirBytes(dir);
    cache.set(dir, { at: now, bytes });
    return bytes;
  };
}

const refusal = (code, status) => ({ ok: false, status, code: `demo_${code}`, error: QUOTA_MESSAGES[code] });

// Disk: the whole demo node first (it protects every visitor; cached, `meter`), then this
// visitor's own folder, measured fresh each time (it is small). Checked BEFORE a write, so one
// accepted write (at most BODY_LIMITS) can cross a cap; the loop-mounted data disk is the hard stop.
export function checkDisk({ cfg, rootDir, userDir, meter, userBytes = dirBytes }) {
  if (meter(rootDir) >= demoLimit(cfg, 'total_disk_gb') * GB) return refusal('disk_total', 507);
  if (userDir && userBytes(userDir) >= demoLimit(cfg, 'user_disk_mb') * MB) return refusal('disk_user', 507);
  return { ok: true };
}

// One AI call: counted against the visitor AND their network, both or neither.
export function consumeAiCall({ cfg, store, userId, ip, now }) {
  const ipKey = `ip:${hashIp(store.salt(now), ip)}`;
  const r = store.consume([['node', demoLimit(cfg, 'ai_calls_node_per_day')], [`user:${userId}`, demoLimit(cfg, 'ai_calls_per_user_per_day')],
    [ipKey, demoLimit(cfg, 'ai_calls_per_ip_per_day')]], now);
  if (r.ok) return r;
  return refusal(r.key === 'node' ? 'ai_node' : r.key === ipKey ? 'ai_ip' : 'ai_user', 429);
}

// One app request (a build or an edit), per visitor per day — on top of its AI calls.
export function consumeAppBuild({ cfg, store, userId, ip, now }) {
  const r = store.consume([[`build:${userId}`, demoLimit(cfg, 'app_builds_per_user_per_day')],
    [`build-ip:${hashIp(store.salt(now), ip)}`, demoLimit(cfg, 'app_builds_per_ip_per_day')]], now);
  return r.ok ? r : refusal('app_builds', 429);
}

// One Ollama web search, per visitor and per network per day.
export function consumeWebSearch({ cfg, store, userId, ip, now }) {
  const r = store.consume([[`web:${userId}`, demoLimit(cfg, 'web_search_per_day')],
    [`web-ip:${hashIp(store.salt(now), ip)}`, demoLimit(cfg, 'web_search_per_ip_per_day')]], now);
  return r.ok ? r : refusal('web_search', 429);
}

// A Bible search scans the corpus on the main thread: counted per visitor and per network.
export function consumeSearch({ cfg, store, userId, ip, now }) {
  const r = store.consume([[`search:${userId}`, demoLimit(cfg, 'searches_per_user_per_day')],
    [`search-ip:${hashIp(store.salt(now), ip)}`, demoLimit(cfg, 'searches_per_ip_per_day')]], now);
  return r.ok ? r : refusal('search', 429);
}

// A session (every visit) and, for a first visit, a new visitor: per network, per day.
export function consumeVisit({ cfg, store, ip, isNew, now }) {
  const h = hashIp(store.salt(now), ip);
  const pairs = [[`session:${h}`, demoLimit(cfg, 'sessions_per_ip_per_day')]];
  if (isNew) pairs.push([`new:${h}`, demoLimit(cfg, 'new_users_per_ip_per_day')]);
  const r = store.consume(pairs, now);
  if (r.ok) return r;
  return refusal(r.key.startsWith('new:') ? 'new_user' : 'sessions', 429);
}
