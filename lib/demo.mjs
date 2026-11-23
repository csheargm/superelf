// Public demo mode · 公开演示模式 (config.json "demo": true, or { "enabled": true, ...limits }).
// Anonymous visitors get the apps seeded from workspace.example; signed-in visitors also get simple
// chat (Ollama lanes only, lib/demo-routes.mjs) — nothing else. FAIL CLOSED: every route is refused unless it is on the
// DEMO_ALLOW list below, so a route added to web.mjs later is unreachable in demo mode until
// someone decides it is safe there. No account sign-in, no owner, no admin, no agent (Claude/Codex) lane,
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
export const DEMO_REFUSED = 'Not available in the public demo · 公开演示版不提供此功能';

// method → exact paths, and method → path prefixes. Everything else answers 403 DEMO_REFUSED.
const EXACT = {
  GET: ['/', '/index.html', '/sw.js', '/api/build', '/manifest.webmanifest', '/api/offline-config',
    '/api/setup-status', '/api/ping', '/api/apps', '/api/convos', '/api/models',
    '/api/app-convos', '/api/profile', '/api/notes', '/api/bible', '/api/bible-search', BUILD_JOB_PATH],   // no note-search/-text: the index can grow far past a save (lib/note-index.mjs)
  POST: [DEMO_START_PATH, DEMO_DELETE_PATH, '/api/chat', '/api/ask', '/api/save-data', '/api/logout', WAITLIST_PATH],   // /api/ask: lib/demo-ask.mjs   // no restore-data: each call is an audit line
  PUT: ['/api/profile'],
};
const PREFIX = { GET: ['/app/', '/api/convos/', '/api/data/'], PATCH: ['/api/convos/'], DELETE: ['/api/convos/'] };   // PATCH (rename) runs under the visitor lock (lib/demo-routes.mjs)

export function demoRouteAllowed(method, p) {
  if (method === 'OPTIONS') return true;   // CORS preflight carries no action
  // The signed-out shell posts here at every boot without a session (ADR 0037); web.mjs's own route
  // answers it (clears the app cookie). Read at call time: lib/app-page-access.mjs imports this file.
  if (method === 'POST' && p === APP_SIGNOUT_PATH) return true;
  if ((EXACT[method] || []).includes(p)) return true;
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
    signedOutAt: (id) => use().signedOutAt(id) };
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
    // A signed-in visitor, by the id lib/demo-auth.mjs derived from a VERIFIED token. No secret and
    // no email are kept: the token is the credential. → { user, isNew }.
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
  };
}
// The shell's client code (boot, sign-in control, tips) is lib/demo-boot.mjs.
