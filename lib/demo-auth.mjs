// Demo sign-in · 演示登录 (docs/demo-node.md "Sign-in"). The public demo's AI features (chat, app
// building, Ask AI, web search) need a scripturetolife.org account: its Supabase project issues the
// access token, this module verifies it. Nothing about the person is stored: the visitor id is a
// hash of the token's `sub` (sbUserId), never the email.
//
// Verification: ES256/RS256 tokens against the project's JWKS (<url>/auth/v1/.well-known/jwks.json,
// cached, one fetch at a time, backed off after a failure). The scripturetolife.org project signs
// with ES256 (its JWKS, checked 2026-11-21), so the /auth/v1/user fallback for legacy HS256 tokens
// is not built: HS256 and every other alg is refused (no secret-keyed or "none" path exists).
// exp, aud and iss must hold; Supabase anonymous users (is_anonymous) are refused: AI needs an email account.
// Config is read at USE time from config.json demo.auth = { supabase_url, supabase_anon_key, required }.
import crypto from 'node:crypto';

export const AUTH_HEADER = 'x-demo-auth';   // the Supabase access token, on POST /api/demo/start only
export const SIGNIN_CODE = 'demo_signin';
export const DEMO_SIGNIN = 'Sign in to use AI (chat, app building, Ask AI, web search) — tap "Sign in" at the top · 请先登录再使用 AI（聊天、建应用、问 AI、联网搜索）——点击顶部的「登录」';
export const DEMO_SIGNIN_BAD = 'Your sign-in has expired or is not valid — please sign in again · 登录已失效，请重新登录';
export const DEMO_BLOCKED = 'This account cannot use AI on the demo · 此账户不能在演示中使用 AI';
// config.json demo.blocked_users: Supabase user ids or emails (case-insensitive), read at use time.
export function isBlocked(cfg, sub, email) {
  const list = cfg && cfg.demo && Array.isArray(cfg.demo.blocked_users) ? cfg.demo.blocked_users : [];
  const want = new Set(list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()));
  return want.has(String(sub || '').toLowerCase()) || (!!email && want.has(String(email).toLowerCase()));
}
export const DEMO_SIGNIN_DOWN = 'Sign-in cannot be checked right now — please try again in a minute · 暂时无法验证登录，请稍后再试';
const AUD = 'authenticated';
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_RETRY_MS = 30_000;    // an unknown kid refetches the key set at most this often (a forged kid must not hammer Supabase)
const BINDINGS_MAX = 5000;       // session bindings kept in memory before expired ones are pruned
const FETCH_TIMEOUT_MS = 5000;
// alg → what its JWK must be, and how its signature is encoded.
const ASYM = new Map([['ES256', { kty: 'EC', crv: 'P-256', opts: { dsaEncoding: 'ieee-p1363' } }], ['RS256', { kty: 'RSA', opts: {} }]]);

export function authConfig(cfg) {
  const d = cfg && cfg.demo && typeof cfg.demo === 'object' ? cfg.demo : {};
  const a = d.auth && typeof d.auth === 'object' ? d.auth : {};
  const url = typeof a.supabase_url === 'string' ? a.supabase_url.trim().replace(/\/+$/, '') : '';
  return {
    url: /^https:\/\/[^/\s]+$/.test(url) || /^http:\/\/127\.0\.0\.1:\d+$/.test(url) ? url : '',   // plain http only for a local test stub
    anonKey: typeof a.supabase_anon_key === 'string' ? a.supabase_anon_key.trim() : '',
    required: a.required !== false,   // fail closed: a demo node with no auth block keeps AI behind sign-in
  };
}

export const sbUserId = (sub) => `sb-${crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 16)}`;

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return { header: dec(parts[0]), payload: dec(parts[1]), signed: `${parts[0]}.${parts[1]}`, sig: Buffer.from(parts[2], 'base64url') };
  } catch { return null; }   // not a JWT at all: the caller refuses it as invalid
}

function claimsOk(p, url, nowMs) {
  if (!p || typeof p !== 'object' || typeof p.sub !== 'string' || !p.sub || p.is_anonymous === true) return false;
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  return aud.includes(AUD) && p.iss === `${url}/auth/v1` && Number.isFinite(p.exp) && p.exp * 1000 > nowMs;
}


export function makeSupabaseVerifier({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let jwks = null;          // { url, at, keys }
  let pending = null;       // { url, p }: the one JWKS fetch in flight, shared by concurrent callers of that project
  let failedAt = -Infinity; // a failed fetch is not retried for JWKS_RETRY_MS

  async function fetchKeys(url) {
    if (now() - failedAt < JWKS_RETRY_MS) throw new Error('supabase jwks: recently unreachable');
    if (pending && pending.url === url) return pending.p;   // the same project's fetch in flight: share it
    const p = (async () => {
      try {
        const r = await fetchImpl(`${url}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const body = r.ok ? await r.json() : null;
        if (!body || !Array.isArray(body.keys)) throw new Error(`supabase jwks: HTTP ${r.status}`);
        jwks = { url, at: now(), keys: body.keys };
      } catch (e) { failedAt = now(); throw e; } finally { if (pending && pending.p === p) pending = null; }
    })();
    pending = { url, p };
    return p;
  }

  async function keyFor(url, kid) {
    const stale = !jwks || jwks.url !== url || now() - jwks.at > JWKS_TTL_MS;
    const unknown = jwks && !jwks.keys.some((k) => k.kid === kid) && now() - jwks.at > JWKS_RETRY_MS;
    if (stale || unknown) await fetchKeys(url);
    if (jwks.url !== url) return null;   // the project changed while fetching: never a key from another issuer
    const hits = jwks.keys.filter((k) => k && k.kid === kid);
    return hits.length === 1 ? hits[0] : null;   // a kid naming two keys is ambiguous: refused
  }

  async function sigOk(j, a) {
    const want = ASYM.get(j.header.alg);
    if (!want || typeof j.header.kid !== 'string' || !j.header.kid) return false;
    const jwk = await keyFor(a.url, j.header.kid);
    if (!jwk || jwk.kty !== want.kty || (want.crv && jwk.crv !== want.crv) || (jwk.alg && jwk.alg !== j.header.alg)) return false;
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(j.signed), { key, ...want.opts }, j.sig);
  }

  // → { ok: true, sub, exp } | { ok: false, code: 'off' | 'bad' }. A Supabase outage THROWS (the
  // caller answers "try again", never "signed out" and never "allowed").
  async function verify(token, cfg) {
    const a = authConfig(cfg);
    if (!a.url) return { ok: false, code: 'off' };
    const j = parseJwt(token);
    if (!j || !j.header || !claimsOk(j.payload, a.url, now())) return { ok: false, code: 'bad' };
    if (!(await sigOk(j, a)) || !claimsOk(j.payload, a.url, now())) return { ok: false, code: 'bad' };   // exp again: the key fetch took time
    return { ok: true, sub: j.payload.sub, email: typeof j.payload.email === 'string' ? j.payload.email : '', exp: j.payload.exp, meta: j.payload.user_metadata, amr: Array.isArray(j.payload.amr) ? j.payload.amr : [], iat: Number.isFinite(j.payload.iat) ? j.payload.iat : 0 };
  }
  return { verify };
}

// The sign-in gate for AI routes. Each NODE SESSION (its bearer, hashed) is bound to the Supabase
// token it was minted or last refreshed with, and that token is re-verified on every AI request —
// so a session's AI ends at its own token's exp, never kept alive by another browser of the same
// account. In memory: after a restart the browser rebinds within a minute (lib/demo-boot.mjs).
// → check(user, bearer): null when allowed, else { status, body } to send.
export function makeSigninGate({ cfg, users = null, verifier = makeSupabaseVerifier(), now = () => Date.now() }) {
  const bound = new Map();   // sha256(bearer) → { id, token, exp }
  const key = (bearer) => crypto.createHash('sha256').update(String(bearer)).digest('hex');
  const refuse = (status, code, error) => ({ status, body: { ok: false, code, error } });
  function bind(bearer, id, token, exp) {
    if (bound.size >= BINDINGS_MAX) for (const [k, b] of bound) if (b.exp * 1000 <= now()) bound.delete(k);
    if (bound.size >= BINDINGS_MAX) bound.delete(bound.keys().next().value);   // still full: the oldest goes
    bound.set(key(bearer), { id, token, exp });
  }
  async function check(user, bearer) {
    if (!authConfig(cfg).required && !(user && user.signedIn)) return null;   // a signed-in member is still checked (block list)
    const b = user && user.signedIn ? bound.get(key(bearer)) : null;
    if (!b || b.id !== user.id) return refuse(401, SIGNIN_CODE, DEMO_SIGNIN);
    let v;
    try { v = await verifier.verify(b.token, cfg); }
    catch { return refuse(503, 'demo_signin_down', DEMO_SIGNIN_DOWN); }   // Supabase unreachable: neither allowed nor signed out
    if (bound.get(key(bearer)) !== b) return refuse(401, SIGNIN_CODE, DEMO_SIGNIN);   // signed out or rebound while verifying: this check is stale
    if (!v.ok || sbUserId(v.sub) !== user.id) { bound.delete(key(bearer)); return refuse(401, SIGNIN_CODE, v.code === 'off' ? DEMO_SIGNIN : DEMO_SIGNIN_BAD); }
    if (isBlocked(cfg, v.sub, v.email)) return refuse(403, 'demo_blocked', DEMO_BLOCKED);   // the owner's block list, every AI turn
    return null;
  }
  // A signed-in visitor's NODE session is usable (any route, not only AI) only while its bound token
  // is unexpired: a 30-day node bearer must not outlive the Supabase sign-in (web.mjs userFor).
  const alive = (bearer, id) => { const b = bound.get(key(bearer)); return !!b && b.id === id && b.exp * 1000 > now(); };
  // Sign-out also refuses any token ISSUED before it: an access JWT stays valid until its exp, so
  // another tab still holding one must not mint a new session after the sign-out.
  // Kept in the visitor store (users.markSignedOut) so it survives a restart; in memory without one.
  const outAt = new Map();   // visitor id → when they signed out (ms)
  const drop = (id) => { const t = now(); outAt.set(id, t); if (users) users.markSignedOut(id, t); for (const [k, b] of bound) if (b.id === id) bound.delete(k); };
  const issuedAfterOut = (id, iat) => { const t = Math.max(outAt.get(id) || 0, (users && users.signedOutAt(id)) || 0); return iat * 1000 > t; };
  return { check, bind, drop, alive, issuedAfterOut, verify: (token) => verifier.verify(token, cfg) };
}
