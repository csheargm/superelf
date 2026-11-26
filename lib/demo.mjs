// Public demo mode · 公开演示模式 (config.json "demo": true, or { "enabled": true, ...limits }).
// Anonymous visitors get the apps seeded from workspace.example; signed-in visitors also get simple
// chat (Ollama lanes only, lib/demo-routes.mjs) — nothing else. FAIL CLOSED: every route is refused unless it is on the
// DEMO_ALLOW list below, so a route added to web.mjs later is unreachable in demo mode until
// someone decides it is safe there. No account sign-in, no owner, no admin account (the demo admin is a config email list, lib/demo-admin.mjs), no agent (Claude/Codex) lane,
// no jobs, no uploads; data only inside the visitor's own workspace. AI needs a Supabase sign-in
// (lib/demo-auth.mjs): a signed-in visitor is `sb-<hash of sub>` with a workspace of its own.
//
// Visitors: an HttpOnly cookie (DEMO_COOKIE) holds `<id>.<secret>`. The id is public (it is in
// /app/<id>/ URLs); the secret is the credential, kept only as a SHA-256 in
// <root>/demo-users.json — never in config.json, which stays the operator's. Each id gets a
// workspace-<id> copied from workspace.example and an ordinary session token.
import crypto from 'node:crypto';
import { APP_SIGNOUT_PATH } from './app-page-access.mjs';
import path from 'node:path';
import { writeJsonFile } from './atomicwrite.mjs';
import { readJsonState, FILE_OK, FILE_UNREADABLE } from './readjson.mjs';
import { WAITLIST_PATH } from './demo-waitlist.mjs';
import { SHARE_PATHS, SHARE_PAGE_RE, SHARE_JOIN_RE } from './app-share.mjs';

export const DEMO_COOKIE = 'superelf_demo';
export const DEMO_USERS_FILE = 'demo-users.json';
export const DEMO_START_PATH = '/api/demo/start';
export const DEMO_DELETE_PATH = '/api/demo/delete-account';
export const BUILD_JOB_PATH = '/api/demo/build';   // GET: the visitor's background app build (lib/demo-build-job.mjs)
const ANON_ID = /^anon-[0-9a-f]{16}$/;
const SIGNED_ID = /^sb-[0-9a-f]{16}$/;   // a signed-in visitor: lib/demo-auth.mjs sbUserId (a hash of the Supabase sub)
const SECRET_RE = /^[A-Za-z0-9_-]{32,64}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
const PROFILE_TEXT_MAX = 254;           // an email's longest legal length; a name is cut to the same
const SEEN_EVERY_MS = 3600_000;         // lastSeen is refreshed at most this often per visitor
export const ADMIN_PATHS = Object.freeze({ me: '/api/demo/admin/me', summary: '/api/demo/admin/summary', reset: '/api/demo/admin/reset',
  shares: '/api/demo/admin/shares', takedown: '/api/demo/admin/takedown' });   // 分享 · Shares tab (lib/app-share-routes.mjs)
export const DEMO_REFUSED = 'Not available in the public demo · 公开演示版不提供此功能';

// method → exact paths, and method → path prefixes. Everything else answers 403 DEMO_REFUSED.
const EXACT = {
  GET: ['/', '/index.html', '/sw.js', '/api/build', '/manifest.webmanifest', '/api/offline-config',
    '/api/setup-status', '/api/ping', '/api/apps', '/api/convos', '/api/models',
    '/api/app-convos', '/api/profile', '/api/notes', '/api/bible', '/api/bible-search', BUILD_JOB_PATH, ADMIN_PATHS.me, ADMIN_PATHS.summary, ADMIN_PATHS.shares],   // no note-search/-text: the index can grow far past a save (lib/note-index.mjs)
  POST: [DEMO_START_PATH, DEMO_DELETE_PATH, '/api/chat', '/api/ask', '/api/save-data', '/api/logout', WAITLIST_PATH, ADMIN_PATHS.reset, ADMIN_PATHS.takedown, SHARE_PATHS.create, SHARE_PATHS.ingest],   // /api/ask: lib/demo-ask.mjs   // no restore-data: each call is an audit line
  PUT: ['/api/profile'],
};
// 回去的路 · The shell's own way back to an app's chat and its Undo (web/app-edit.js): the panel page, the
// newest change's Undo and how many changes can be undone — for the visitor's own apps only (web.mjs checks).
export const DEMO_UNDO_RE = /^\/api\/apps\/[a-z0-9-]+\/undo$/;   // lib/demo-routes.mjs refuses it beside a build
const PATTERN = { GET: [/^\/api\/app-edit\/panel$/, /^\/api\/apps\/[a-z0-9-]+\/edits$/, SHARE_PAGE_RE], POST: [DEMO_UNDO_RE, SHARE_JOIN_RE] };   // share: lib/app-share.mjs
const PREFIX = { GET: ['/app/', '/api/convos/', '/api/data/'], PATCH: ['/api/convos/'], DELETE: ['/api/convos/'] };   // PATCH (rename) runs under the visitor lock (lib/demo-routes.mjs)

export function demoRouteAllowed(method, p) {
  if (method === 'OPTIONS') return true;   // CORS preflight carries no action
  // The signed-out shell posts here at every boot without a session (ADR 0037); web.mjs's own route
  // answers it (clears the app cookie). Read at call time: lib/app-page-access.mjs imports this file.
  if (method === 'POST' && p === APP_SIGNOUT_PATH) return true;
  if ((EXACT[method] || []).includes(p)) return true;
  if ((PATTERN[method] || []).some((re) => re.test(p))) return true;
  return (PREFIX[method] || []).some((pre) => p.startsWith(pre) && !p.includes('..'));
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
export const demoCookie = (value) => `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;

// The visitor store. A damaged file throws (R5): starting over would orphan every workspace.
// Read on FIRST USE, not at boot: a node with demo mode off never touches (or fails on) the file.
export function makeDemoUsers(root) {
  let store = null;
  const use = () => (store ||= loadDemoUsers(root));
  return { get: (id) => use().get(id), fromCookie: (v) => use().fromCookie(v), create: (now) => use().create(now),
    ensure: (id, now) => use().ensure(id, now), markSignedOut: (id, now) => use().markSignedOut(id, now),
    signedOutAt: (id) => use().signedOutAt(id), profile: (id, p, now) => use().profile(id, p, now),
    forget: (id) => use().forget(id), all: () => use().all() };
}
function loadDemoUsers(root) {
  const file = path.join(root, DEMO_USERS_FILE);
  const r = readJsonState(file);
  if (r.state === FILE_UNREADABLE) throw new Error(`${DEMO_USERS_FILE} unreadable: ${r.error}`);
  const v = r.state === FILE_OK ? r.value : { users: {} };
  if (!v || typeof v !== 'object' || !v.users || typeof v.users !== 'object' || Array.isArray(v.users)) {
    throw new Error(`${DEMO_USERS_FILE} is damaged: no users map`);   // never overwritten as empty
  }
  const known = new Map(Object.entries(v.users));
  const record = (id) => ({ id, name: SIGNED_ID.test(id) ? 'Member · 会员' : 'Guest · 访客', signedIn: SIGNED_ID.test(id), role: 'member', status: 'active', demo: true,
    rel: `workspace-${id}`, workspace: path.join(root, `workspace-${id}`) });
  return {
    // By id: only for an id a valid SESSION token already resolved to.
    get: (id) => ((ANON_ID.test(id || '') || SIGNED_ID.test(id || '')) && known.has(id) ? record(id) : null),
    // By cookie: the id AND its secret, compared in constant time.
    fromCookie(value) {
      const [id, secret] = String(value || '').split('.');
      const rec = ANON_ID.test(id || '') && SECRET_RE.test(secret || '') ? known.get(id) : null;
      if (!rec || typeof rec.sh !== 'string') return null;
      const want = Buffer.from(rec.sh, 'hex');
      return want.length === 32 && crypto.timingSafeEqual(want, sha(secret)) ? record(id) : null;
    },
    create(now = Date.now()) {
      const id = `anon-${crypto.randomBytes(8).toString('hex')}`, secret = crypto.randomBytes(24).toString('base64url');
      known.set(id, { created: now, sh: sha(secret).toString('hex') });
      writeJsonFile(file, { users: Object.fromEntries(known) });
      return { user: record(id), cookie: `${id}.${secret}` };
    },
    // A signed-in visitor, by the id lib/demo-auth.mjs derived from a VERIFIED token. No secret is
    // kept: the token is the credential. → { user, isNew }.
    ensure(id, now = Date.now()) {
      if (!SIGNED_ID.test(id || '')) throw new Error('demo: not a signed-in visitor id');
      const isNew = !known.has(id);
      if (isNew) { known.set(id, { created: now, signed: true }); writeJsonFile(file, { users: Object.fromEntries(known) }); }
      return { user: record(id), isNew };
    },
    // When a signed-in visitor last signed out: tokens issued before it are refused (lib/demo-auth.mjs).
    markSignedOut(id, now = Date.now()) {
      const rec = SIGNED_ID.test(id || '') ? known.get(id) : null;
      if (rec) { rec.out = now; writeJsonFile(file, { users: Object.fromEntries(known) }); }
    },
    signedOutAt: (id) => { const rec = known.get(id); return rec && Number.isFinite(rec.out) ? rec.out : 0; },
    // Demo admin (lib/demo-admin.mjs, ADR 0045): a signed-in visitor's sign-in email and account name,
    // from the verified token, and when they were last seen. Shown to the demo admin only; the sign-in
    // popover says so. Written only when something changed or a day passed, not on every hourly refresh.
    profile(id, { email = '', name = '' } = {}, now = Date.now()) {
      const rec = SIGNED_ID.test(id || '') ? known.get(id) : null;
      if (!rec) return;
      const e = String(email).slice(0, PROFILE_TEXT_MAX), n = String(name).slice(0, PROFILE_TEXT_MAX);
      if (rec.email === e && rec.name === n && now - (rec.seen || 0) < SEEN_EVERY_MS) return;
      Object.assign(rec, { email: e, name: n, seen: now });
      writeJsonFile(file, { users: Object.fromEntries(known) });
    },
    // Delete my account: the email and name go; the record stays (its sign-out time, see markSignedOut).
    forget(id) {
      const rec = known.get(id);
      if (rec && ('email' in rec || 'name' in rec || 'seen' in rec)) { delete rec.email; delete rec.name; delete rec.seen; writeJsonFile(file, { users: Object.fromEntries(known) }); }
    },
    all: () => [...known].map(([id, r]) => ({ id, signed: SIGNED_ID.test(id), created: r.created || 0, seen: r.seen || 0, email: r.email || '', name: r.name || '' })),
  };
}
// The shell's client code (boot, sign-in control, tips) is lib/demo-boot.mjs.
