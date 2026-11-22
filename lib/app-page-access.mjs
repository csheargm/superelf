// Who may load an app page under /app/<uid>/<slug>/ (ADR 0037).
//
// The app iframe is navigated by `src` (no Authorization header can ride a navigation), so the
// shell's session travels to /app/ in an HttpOnly cookie that web.mjs sets on every
// authenticated GET /api/ping (the shell pings at each boot and after each sign-in). The cookie
// is scoped to Path=/app/ and SameSite=Strict: it is never sent to /api/*, so it adds no CSRF
// surface — only the app-page route reads it. Its value is the session token itself, so logout
// and session expiry revoke it with no second store.
import fs from 'node:fs';
import path from 'node:path';
import { readCookie } from './demo.mjs';

export const APP_PAGE_COOKIE = 'pa_app';
export const APP_PAGE_PATH = '/app/';
// The signed-out shell posts here (the cookie is Path=/app/, so /api/logout never sees it): the
// cookie's session is destroyed and the cookie cleared, even after a sign-out made offline.
export const APP_SIGNOUT_PATH = '/app/-/signout';
export const appPageCookieToken = (req) => readCookie(req.headers.cookie, APP_PAGE_COOKIE);
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;   // the cookie outlives no session: the server resolves it as a session each time

// Secure only where the browser would keep it: an https request (direct TLS or a TLS proxy).
const isHttps = (req) => !!(req.socket && req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const attrs = (req) => `Path=${APP_PAGE_PATH}; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`;
export const appPageCookie = (req, token) => `${APP_PAGE_COOKIE}=${token}; ${attrs(req)}; Max-Age=${COOKIE_MAX_AGE_S}`;
export const clearAppPageCookie = (req) => `${APP_PAGE_COOKIE}=; ${attrs(req)}; Max-Age=0`;

// The token an app-page request carries: the cookie (iframe navigation), else a bearer header
// (a shell fetch for the srcdoc route, or a test client).
export function appPageToken(req) {
  return readCookie(req.headers.cookie, APP_PAGE_COOKIE) || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

// The app's own meta.json says whether it is shared. Missing or unreadable = not shared (fail closed).
export function appIsShared(appDir) {
  try { const m = JSON.parse(fs.readFileSync(path.join(appDir, 'meta.json'), 'utf8')); return !!(m && m.shared === true); }
  catch { return false; }   // no meta / bad JSON: treated as unshared, the safe answer (R5: deliberate)
}

// The decision. viewer = the signed-in user or null. Shared → anyone; else the author or the owner role.
export function canViewAppPage({ authorId, shared, viewer }) {
  if (shared === true) return true;
  if (!viewer) return false;
  return viewer.id === authorId || viewer.role === 'owner';
}
