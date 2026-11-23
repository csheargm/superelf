// Offline-first (docs/plans/offline-first.md) — the server side of the app bundle: the service
// worker's URL, the probe the shell uses to learn whether its sandboxed iframe is served by the
// worker, the tunables the shell reads at use time, and the CSP the srcdoc route carries.
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_IDS, TRANSLATIONS } from './bible.mjs';

export const SW_PATH = '/sw.js';                 // served by web.mjs from web/sw.js, scope /
export const SW_PROBE_PATH = '/pa-sw-probe';     // answered ONLY by the worker; the node answers an empty 204, signed in or not
export const OFFLINE_CONFIG_PATH = '/api/offline-config';
export const PA_BUNDLE_KIND = 'pa-bundle';       // shell → worker: {kind, build} after every load
export const PA_SW_PROBE_KIND = 'pa-sw-probe';   // probe page → shell: the worker served an iframe navigation
const MB = 1024 * 1024;

// Defaults, merged under config.offline at load (lib/config.mjs) — read at use time by the route.
// bible_cap_bytes: measured 2026-11-11 on the corpus as served — 1,189 chapters, 7,850,756 JSON
// bytes (3.8 MB gzipped), largest chapter 27,844 bytes; the plan's 20 MB cap leaves room for growth.
export const OFFLINE_DEFAULTS = Object.freeze({
  apps: Object.freeze(['notes', 'bible']),   // the app pages prefetched into the bundle
  bible_cap_bytes: 20 * MB,                   // the prefetch stops past this many chapter bytes
  bible_prefetch: true,
  warm_files: 40,                             // files kept readable offline per device (the warm set, §2); the queue is never capped
});

export function offlineSettings(raw) {
  const o = { ...OFFLINE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!Array.isArray(o.apps) || o.apps.some((a) => typeof a !== 'string' || !/^[a-z0-9_-]+$/.test(a))) throw new Error('offline.apps must be a list of app slugs');
  const cap = Number(o.bible_cap_bytes);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('offline.bible_cap_bytes must be a positive number of bytes');
  const warm = Number(o.warm_files);
  if (!Number.isInteger(warm) || warm <= 0) throw new Error('offline.warm_files must be a positive whole number of files');
  return { apps: [...o.apps], bible_cap_bytes: cap, bible_prefetch: o.bible_prefetch !== false, warm_files: warm };
}

// The configured app pages THIS user can open (F4-4): their own copy first, else the family shelf's.
// A slug they have neither of is left out — it was prefetched anyway and answered 404 on every load.
// → { apps: [own slugs], shelf_apps: [shelf slugs] }; the shell fetches /app/<uid>/… and /app/shared/….
export function offlineAppsFor(apps, ownAppsDir, shelfDir) {
  const has = (dir, slug) => !!dir && fs.existsSync(path.join(dir, slug, 'index.html'));
  const own = apps.filter((s) => has(ownAppsDir, s));
  return { apps: own, shelf_apps: apps.filter((s) => !own.includes(s) && has(shelfDir, s)) };
}

// Chapters per book, from the corpus on disk (the English side; getChapter refuses a chapter the
// English side lacks). Empty when the corpus is absent — the shell prefetches nothing then.
export function bibleIndex(dataDir) {
  return BOOK_IDS.map((id) => {
    try { return fs.readdirSync(path.join(dataDir, TRANSLATIONS.en, id)).filter((f) => /^\d+\.json$/.test(f)).length; }
    catch { return 0; } // no corpus here (a fresh clone, a test root): nothing to prefetch, nothing to cache
  });
}

// The policy every /app/ page is served with (web.mjs): an opaque origin with no network.
export const APP_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'";

// The srcdoc route (shell, web/sw-client.js) loads an app page without an HTTP response, so the
// CSP header never reaches it. The same policy travels INSIDE the page as a meta tag; the
// directives a meta CSP cannot carry (sandbox — the iframe attribute supplies it; frame-ancestors)
// are dropped rather than left to raise a console warning on every open.
export function cspMetaTag(headerValue) {
  const rules = String(headerValue || '').split(';').map((s) => s.trim()).filter((d) => d && !/^(sandbox|frame-ancestors)\b/.test(d));
  return rules.length ? `<meta http-equiv="Content-Security-Policy" content="${rules.join('; ')}">` : '';
}
// Right after the first of <head>, <html>, <!doctype> the page has: a tag ahead of the doctype
// puts the page in quirks mode (test/two-tap, store: a synthetic page with no <head>).
// A tag's end is the first `>` OUTSIDE quotes, and `<header>` is not `<head>` (gpt-review).
const TAG_REST = String.raw`(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>`;
const CSP_ANCHORS = [new RegExp('<head' + TAG_REST, 'i'), new RegExp('<html' + TAG_REST, 'i'), /<!doctype[^>]*>/i];
// Anchors are looked for with comments and <script>/<style> bodies blanked (same length, so an
// index is an index into the page): a `<head>` inside a comment must not swallow the policy. If any
// other tag comes before the anchor, the policy goes first: quirks mode beats an unguarded script.
const blank = (s) => s.replace(/<!--[\s\S]*?(?:-->|$)|(<(script|style)\b[^>]*>)[\s\S]*?(?=<\/\2\s*>|$)/gi, (m, open) => (open || '') + ' '.repeat(m.length - (open || '').length));
const PREFIX_OK = new RegExp(String.raw`^(?:\s|<!doctype[^>]*>|<html${TAG_REST}|<head${TAG_REST})*$`, 'i');
export const withCspMeta = (html, headerValue) => {
  const tag = cspMetaTag(headerValue);
  if (!tag) return html;
  const b = blank(html);
  const m = CSP_ANCHORS.map((re) => b.match(re)).find(Boolean);
  if (!m) return tag + html;
  const end = m.index + m[0].length;
  if (!PREFIX_OK.test(b.slice(0, end).replace(/ {2,}/g, ' '))) return tag + html;
  return html.slice(0, end) + tag + html.slice(end);
};
