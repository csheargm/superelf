// Demo admin · 演示管理 (ADR 0045, docs/demo-node.md "Demo admin"). One owner-only page on the
// public demo: today's visitors and blocked networks (with a 清零 · Reset per network), who signed
// in, which apps each person opened and used, the waiting list, and a 14-day trend.
//
// Gate: the caller's Supabase access token (AUTH_HEADER), verified like a sign-in (lib/demo-auth.mjs),
// whose email is in config.json demo.admin_emails (read at use time, compared ignoring case) and not
// marked unverified. Anyone else — anonymous, a member, a bad token — gets the same 404 as an unknown
// path, so the page's existence is not revealed. The list never reaches the browser. An admin gets no
// other exemption: every cap still applies to their own visits.
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PATHS } from './demo.mjs';
import { AUTH_HEADER, sbUserId } from './demo-auth.mjs';
import { demoLimit } from './demo-quota.mjs';
import { NET_HASH_LEN } from './demo-usage.mjs';
import { WAITLIST_FILE } from './demo-waitlist.mjs';

export const SUMMARY_DAYS = 14;
const SUMMARY_DAYS_MAX = 90;
const RESET_BODY_LIMIT = 256;
const WAITLIST_SHOWN_MAX = 500;
const NOT_FOUND = 'not found';

export function adminEmails(cfg) {
  const list = cfg && cfg.demo && typeof cfg.demo === 'object' && Array.isArray(cfg.demo.admin_emails) ? cfg.demo.admin_emails : [];
  return new Set(list.filter((x) => typeof x === 'string' && x.includes('@')).map((x) => x.trim().toLowerCase()));
}

// The session itself proves the email: a magic link or code sent to it (Supabase's `amr` claim, set by
// the issuer; the demo's own sign-in is the email link). Never user_metadata, which the user can edit;
// never a password or provider session. Supabase's 'otp' also covers SMS codes, so a token with a phone
// claim is refused. demo.admin_subs (optional): Supabase user ids the admin must ALSO match — an
// immutable pin for a project whose email settings the owner does not control.
export const EMAIL_PROVEN_AMR = Object.freeze(['otp', 'magiclink']);
const emailProven = (amr) => Array.isArray(amr) && amr.some((a) => a && EMAIL_PROVEN_AMR.includes(typeof a === 'string' ? a : a.method));

// → the admin's visitor id, or '' (refused). A Supabase outage is a refusal too: the page can wait.
export async function adminOf(gate, cfg, req) {
  const token = String(req.headers[AUTH_HEADER] || '');
  const want = adminEmails(cfg);
  if (!token || !want.size) return '';
  let v;
  try { v = await gate.verify(token); } catch { return ''; /* Supabase unreachable: refused like any non-admin (404) */ }
  if (!v || !v.ok || !v.email || v.phone || !emailProven(v.amr)) return '';
  const subs = cfg.demo.admin_subs;
  if (Array.isArray(subs) && subs.length && !subs.includes(v.sub)) return '';
  if (!gate.issuedAfterOut(sbUserId(v.sub), v.iat)) return '';   // a token from before a sign-out
  return want.has(v.email.trim().toLowerCase()) ? sbUserId(v.sub) : '';
}

function readWaitlist(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, WAITLIST_FILE), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); out.push({ t: v.t || '', email: v.email || '', name: v.name || '', note: v.note || '' }); }
    catch { /* a torn last line (a crash mid-append): skipped, the rest still shows */ }
  }
  return out.slice(-WAITLIST_SHOWN_MAX).reverse();
}

// Today's networks from the quota counters: short hash, visits, new visitors, and whether a cap is hit.
function todayNets(cfg, counts) {
  const nets = new Map();
  for (const [k, n] of Object.entries(counts)) {
    const m = /^(session|new):([0-9a-f]{64})$/.exec(k);
    if (!m) continue;
    const row = nets.get(m[2]) || { id: m[2], net: m[2].slice(0, NET_HASH_LEN), visits: 0, new: 0 };   // id: the exact key Reset names; net: what is shown
    row[m[1] === 'session' ? 'visits' : 'new'] = n;
    nets.set(m[2], row);
  }
  const vCap = demoLimit(cfg, 'sessions_per_ip_per_day'), nCap = demoLimit(cfg, 'new_users_per_ip_per_day');
  return [...nets.values()].map((r) => ({ ...r, blocked: r.visits >= vCap || r.new >= nCap })).sort((a, b) => b.blocked - a.blocked || b.visits - a.visits);
}

export function buildSummary({ cfg, root, users, store, usage, days = SUMMARY_DAYS, now = Date.now() }) {
  const span = usage.days(days, now), q = store.today(now), aiCap = demoLimit(cfg, 'ai_calls_per_user_per_day');
  const people = new Map(users.all().map((u) => [u.id, { ...u, aiToday: q.counts[`user:${u.id}`] || 0, ai: 0, first: 0, last: 0, apps: {} }]));
  const apps = new Map();
  for (const d of span) for (const [id, u] of Object.entries(d.users)) {
    const p = people.get(id) || { id, signed: id.startsWith('sb-'), email: '', name: '', created: 0, seen: 0, aiToday: 0, ai: 0, first: 0, last: 0, apps: {} };
    p.ai += u.ai || 0; p.first = p.first ? Math.min(p.first, u.first) : u.first; p.last = Math.max(p.last, u.last);
    for (const [slug, c] of Object.entries(u.apps || {})) {
      const mine = Object.hasOwn(p.apps, slug) ? p.apps[slug] : (p.apps[slug] = { open: 0, ai: 0, build: 0, edit: 0 }), all = apps.get(slug) || { slug, people: new Set(), open: 0, ai: 0, build: 0, edit: 0 };
      for (const k of ['open', 'ai', 'build', 'edit']) { mine[k] += c[k] || 0; all[k] += c[k] || 0; }
      all.people.add(id); apps.set(slug, all);
    }
    people.set(id, p);
  }
  const trend = span.map((d) => {
    const us = Object.values(d.users);
    return { day: d.day, visits: d.visits || 0, new: d.new || 0, people: us.length, ai: us.reduce((s, u) => s + (u.ai || 0), 0),
      builds: us.reduce((s, u) => s + Object.values(u.apps || {}).reduce((t, a) => t + (a.build || 0) + (a.edit || 0), 0), 0) };
  });
  const last = trend[trend.length - 1];
  return {
    ok: true, day: q.day, days, aiCap,
    today: { visits: last.visits, new: last.new, nets: todayNets(cfg, q.counts) },
    people: [...people.values()].filter((p) => p.signed || p.last).sort((a, b) => Math.max(b.last, b.seen) - Math.max(a.last, a.seen)),
    apps: [...apps.values()].map((a) => ({ ...a, people: [...a.people] })).sort((a, b) => b.open + b.ai - a.open - a.ai),
    waitlist: readWaitlist(root), trend,
  };
}

// x: { d, gate, json, usage } from lib/demo-routes.mjs. → true when it answered.
export function makeDemoAdmin({ d, gate, json, usage }) {
  const nope = (res) => d.send(res, 404, 'text/plain', NOT_FOUND);
  return async function admin(req, res, p) {
    const known = Object.values(ADMIN_PATHS).includes(p);
    if (!known) return false;
    const who = await adminOf(gate, d.cfg, req);
    if (!who) { nope(res); return true; }
    const noStore = { 'cache-control': 'no-store' };
    if (req.method === 'GET' && p === ADMIN_PATHS.me) { json(res, 200, { ok: true }, noStore); return true; }
    if (req.method === 'GET' && p === ADMIN_PATHS.summary) {
      const n = Number(new URL(req.url, 'http://x').searchParams.get('days'));
      const days = Number.isInteger(n) && n >= 1 && n <= SUMMARY_DAYS_MAX ? n : SUMMARY_DAYS;
      json(res, 200, buildSummary({ cfg: d.cfg, root: d.root, users: d.users, store: d.store, usage, days }), noStore); return true;
    }
    if (req.method === 'POST' && p === ADMIN_PATHS.reset) {
      const b = (await d.readBody(req, RESET_BODY_LIMIT)) || {};
      const id = typeof b.net === 'string' ? b.net : '';
      if (!/^[0-9a-f]{64}$/.test(id)) { json(res, 400, { ok: false, error: 'bad network' }); return true; }
      const removed = d.store.dropNet(id);
      d.audit('demo-admin-reset', { by: who, net: id.slice(0, NET_HASH_LEN), removed });
      json(res, 200, { ok: true, removed }, noStore); return true;
    }
    nope(res); return true;
  };
}
