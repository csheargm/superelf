// 试用 · Try it — the owner's live preview of an unpublished core change (docs/adr/0049). The copy's web/
// is assembled by THIS node's trusted builder (lib/selfpub/preview-page.mjs, the same answer the render
// check gets) and served to the owner's own browser, where the copy's browser code really runs. So the
// page is walled off from everything the owner's session can reach:
//   - an owner-issued token in the path (POST /api/selfpub/<id>/try, lib/selfpub/routes.mjs) is the only
//     key: short-lived, in memory, one change, never the session. The preview's requests carry no
//     session: the page lives at an OPAQUE origin, so the owner's localStorage and cookies are not its own;
//   - two frames, both sandbox="allow-scripts" with NO allow-same-origin (the attribute in the shell and
//     a CSP sandbox here, so a direct open is walled too). The outer one is this file's wrapper, with no
//     script of its own; its frame-src holds the inner page to the preview's own path, so the agent's code
//     cannot navigate its frame away to another host or to a real node page;
//   - the inner page's CSP allows connections ONLY to <this host>/selfpub-try/<token>/page/api/ — the fake
//     owner. Real /api/*, other hosts, WebSockets: refused by the browser whatever the page's code does;
//   - every /api/* under the token answers the fixed fake data, whatever the method. Nothing real is read or
//     written, and no agent-written SERVER code runs (lib/selfpub/lane.mjs: the node never runs it);
//   - every answer comes from a frozen copy of the verified web/ (lib/selfpub/try-snapshot.mjs), never the
//     live checkout; the token lives only as long as the owner's session that asked for it (R13).
import crypto from 'node:crypto';
import { previewAnswer } from './preview-page.mjs';
import { getChange, PENDING } from './state.mjs';
import { takeSnapshot, dropSnapshot, dropAllSnapshots, snapshotMb } from './try-snapshot.mjs';

export const TRY_BASE = '/selfpub-try/';
export const TRY_RE = /^\/selfpub-try\/([a-f0-9]{48})(\/.*)?$/;
export const DEFAULT_TRY_MINUTES = 30;
export const MAX_TRY_TOKENS = 20;   // in memory: the oldest goes first past this
const CORS = Object.freeze({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
  'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
// The Host header the owner's browser used: a name, an IPv4 or a [IPv6], with an optional port. Anything
// else gets no page — it would be pasted into the CSP.
// IPv6 literals are not in CSP's host-source grammar: such a Host gets no page (a 400 that says so).
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;
export const MAX_TRY_MINUTES = 24 * 60;   // a config typo (or Infinity) never makes a preview link live for good

export function tryMinutes(cfg) {
  const m = Number(cfg && cfg.selfpub_try_minutes);
  return m > 0 ? Math.min(m, MAX_TRY_MINUTES) : DEFAULT_TRY_MINUTES;
}

const tokens = new Map();   // token → { id, who, sroot, at, sess, snap, exp }
const drop = (tok) => { const e = tokens.get(tok); tokens.delete(tok); if (e) dropSnapshot(e.snap); };
// at: the change record's time when issued. Any later write to it (a follow-up turn, a state change) ends the
// preview. sess: the owner's session bearer that asked; signing out (or losing the owner role) ends it too.
export function issueTry({ id, who, sroot, at, sess, snap, minutes, now = Date.now() }) {
  for (const [t, e] of tokens) if (e.exp <= now) drop(t);
  while (tokens.size >= MAX_TRY_TOKENS) drop(tokens.keys().next().value);
  const tok = crypto.randomBytes(24).toString('hex');
  tokens.set(tok, { id, who, sroot, at, sess, snap, exp: now + minutes * 60000 });
  return tok;
}
// The owner's tap: freeze the verified web/ (throws a PublishError when the bytes moved), then the token.
export function startTry({ dir, change, sroot, sess, cfg, minutes }) {
  if (![...tokens.values()].some((e) => e.sroot === sroot)) dropAllSnapshots(sroot);   // an earlier process's copies
  const snap = takeSnapshot(dir, sroot, change.verifiedHash, { maxMb: snapshotMb(cfg) });
  return issueTry({ id: change.id, who: change.who, sroot, at: change.at, sess, snap, minutes });
}
export function lookupTry(tok, now = Date.now()) {
  const e = tokens.get(tok);
  if (e && e.exp <= now) drop(tok);
  return e && e.exp > now ? e : null;
}
export const forgetTries = () => { for (const t of [...tokens.keys()]) drop(t); };   // tests

export const wrapperPrefix = (tok) => `${TRY_BASE}${tok}`;
export const pagePrefix = (tok) => `${TRY_BASE}${tok}/page`;

// A source WITH its scheme: in an opaque-origin document WebKit matches a scheme-less host-source against no
// scheme, so the inner page (and its every file) was refused on iPhone/iPad Safari (R13 review: WebKit run).
// Both schemes: the node may sit behind a TLS proxy; an https page never loads the http one (mixed content).
const at = (host, p) => `http://${host}${p} https://${host}${p}`;
export function wrapperCsp(host, tok) {
  return `sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src ${at(host, `${pagePrefix(tok)}/`)}; frame-ancestors 'self'; form-action 'none'; base-uri 'none'`;
}
// No frame-ancestors: the page's parent is the OPAQUE wrapper, which matches no source ('self' included: the page
// then never loads, tried 2026-11-27). Framing by another site needs the token URL, whose holder can read every byte anyway.
export function pageCsp(host, tok) {
  const web = at(host, `${pagePrefix(tok)}/web/`);
  return [`sandbox allow-scripts`, `default-src 'none'`, `script-src 'unsafe-inline' ${web}`, `style-src 'unsafe-inline' ${web}`,
    `img-src data: blob: ${web}`, `font-src data: ${web}`, `connect-src ${at(host, `${pagePrefix(tok)}/api/`)}`, `media-src 'none'`, `frame-src 'none'`,
    `worker-src 'none'`, `object-src 'none'`, `manifest-src 'none'`, `form-action 'none'`, `base-uri 'none'`].join('; ');
}

// The outer frame: no script, one inner frame, the full size of the overlay.
export const wrapperHtml = (tok) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head>`
  + `<body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" src="${pagePrefix(tok)}/" title="preview"></iframe></body></html>`;

// ctx: { send, demo, alive(sess) → the session's user or null }. Returns true when it answered.
export function handleTryPage(req, res, p, ctx) {
  const m = p.match(TRY_RE);
  if (!m) return false;
  const [, tok, rest = '/'] = m, e = !ctx.demo && lookupTry(tok);
  const text = (code, body) => ctx.send(res, code, 'text/plain; charset=utf-8', body, { 'cache-control': 'no-store', ...CORS });
  if (!e) return text(404, '预览已过期 · This preview has expired'), true;
  const u = typeof ctx.alive === 'function' ? ctx.alive(e.sess) : null;
  if (!u || u.id !== e.who || u.role !== 'owner') { drop(tok); return text(404, '预览已过期 · This preview has expired'), true; }
  const ch = getChange(e.sroot, e.id);
  if (!ch || ch.who !== e.who || !PENDING.includes(ch.state) || ch.at !== e.at) { drop(tok); return text(404, '这个改动已不在等待发布 · This change is no longer waiting to publish'), true; }
  if (req.method === 'OPTIONS') { ctx.send(res, 204, 'text/plain', null, CORS); return true; }
  // Only ever inside the Publish sheet's frames (or as their subresources): opened as a top-level document,
  // a page or an SVG would run without the wrapper's navigation fence (GPT review). Browsers say so in
  // Sec-Fetch-Dest; one that does not send it still gets the CSP sandbox below.
  if (req.headers['sec-fetch-dest'] === 'document') return text(403, '预览只在发布面板里打开 · Open the preview from the Publish sheet'), true;
  const host = String(req.headers.host || '');
  if (!HOST_RE.test(host)) return text(400, 'bad host'), true;
  req.resume();   // a fake API write's body is never read
  if (rest === '/' || rest === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method'), true;
    ctx.send(res, 200, 'text/html; charset=utf-8', wrapperHtml(tok), { 'content-security-policy': wrapperCsp(host, tok), 'cache-control': 'no-store' });
    return true;
  }
  if (!rest.startsWith('/page/')) return text(404, ''), true;
  const r = previewAnswer(e.snap, `${pagePrefix(tok)}${rest.slice('/page'.length)}`, { prefix: pagePrefix(tok) });
  // The page's CSP on EVERY answer, not only HTML: an SVG or an HTML file of web/ is a document too (GPT review).
  ctx.send(res, r.status, r.type, r.body, { 'cache-control': 'no-store', ...CORS, 'content-security-policy': pageCsp(host, tok) });
  return true;
}
