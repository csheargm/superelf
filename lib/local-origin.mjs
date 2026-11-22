// The home-node fallback（家中节点回退）, docs/plans/offline-first.md §6: the iPad is on home Wi-Fi but
// the public name does not resolve. The shell (loaded from the public name, served by its worker)
// asks /api/build on `local_origin` and, when that node runs the SAME build, points its api() base
// there for the session (web/offline-origin.js PAOrigin). That is a cross-origin call with the
// Bearer header, so the node must answer CORS — and only for that one pairing: the request arrived
// on the local name (Host) and came from the page on the public name (Origin = public_base_url).
// Both keys are read at use time (config.json watcher): no restart to set the local name.
import { baseUrlOk } from './webutil.mjs';   // the ONE base-URL gate (R3), shared with public_base_url

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// What the shell's api() and relayCall send: the Bearer, JSON bodies, gzip-packed saves (web/index.html
// RELAY_GZIP) and the browser's own conditional request.
const CORS_HEADERS = 'authorization, content-type, content-encoding, if-none-match';
const CORS_MAX_AGE_S = 600;   // the preflight is remembered this long; the pairing never changes mid-session

// config.local_origin: '' (no fallback) or an http(s) origin with the trailing slash dropped;
// anything else refuses to load (the public_base_url precedent, lib/config.mjs).
export function localOriginSetting(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' || !baseUrlOk(raw)) throw new Error(`local_origin: not a valid http(s) base URL (no query/fragment/credentials): "${raw}"`);
  return raw.trim().replace(/\/+$/, '');
}

// The host a request must have arrived on for the pairing (host[:port] as the Host header spells it).
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return ''; /* refused at load (localOriginSetting); never reached */ } };

// The CORS headers for one request, or null when it is not the pairing above: no Origin (a same-origin
// call), no local_origin or public_base_url configured, an Origin that is not the public name, or a
// request that did not arrive on the local name. `vary: origin` so a cache never hands one origin's
// answer to another.
export function corsHeaders(req, cfg) {
  const origin = req.headers.origin, local = cfg.local_origin, pub = cfg.public_base_url;
  if (!origin || !local || !pub || origin !== pub) return null;
  if ((req.headers.host || '') !== hostOf(local)) return null;
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers': CORS_HEADERS, 'access-control-max-age': String(CORS_MAX_AGE_S), vary: 'origin' };
}
