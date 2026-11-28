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
//     written, and no agent-written SERVER code runs (lib/selfpub/lane.mjs: the node never runs it).
import crypto from 'node:crypto';
import { previewAnswer } from './preview-page.mjs';
import { getChange } from './state.mjs';
import { repoDir } from './checkout.mjs';

export const TRY_BASE = '/selfpub-try/';
export const TRY_RE = /^\/selfpub-try\/([a-f0-9]{48})(\/.*)?$/;
export const DEFAULT_TRY_MINUTES = 30;
export const MAX_TRY_TOKENS = 20;   // in memory: the oldest goes first past this
export const PENDING = Object.freeze(['ready', 'unverified']);   // states with an unpublished change in the checkout
const CORS = Object.freeze({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
  'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
// The Host header the owner's browser used: a name, an IPv4 or a [IPv6], with an optional port. Anything
// else gets no page — it would be pasted into the CSP.
const HOST_RE = /^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

export const tryMinutes = (cfg) => (Number(cfg && cfg.selfpub_try_minutes) > 0 ? Number(cfg.selfpub_try_minutes) : DEFAULT_TRY_MINUTES);

const tokens = new Map();   // token → { id, who, sroot, exp }
export function issueTry({ id, who, sroot, minutes, now = Date.now() }) {
  for (const [t, e] of tokens) if (e.exp <= now) tokens.delete(t);
  while (tokens.size >= MAX_TRY_TOKENS) tokens.delete(tokens.keys().next().value);
  const tok = crypto.randomBytes(24).toString('hex');
  tokens.set(tok, { id, who, sroot, exp: now + minutes * 60000 });
  return tok;
}
export function lookupTry(tok, now = Date.now()) {
  const e = tokens.get(tok);
  if (e && e.exp <= now) tokens.delete(tok);
  return e && e.exp > now ? e : null;
}
export const forgetTries = () => tokens.clear();   // tests

export const wrapperPrefix = (tok) => `${TRY_BASE}${tok}`;
export const pagePrefix = (tok) => `${TRY_BASE}${tok}/page`;

export function wrapperCsp(host, tok) {
  return `sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src ${host}${pagePrefix(tok)}/; frame-ancestors 'self'; form-action 'none'; base-uri 'none'`;
}
export function pageCsp(host, tok) {
  const at = `${host}${pagePrefix(tok)}`;
  return [`sandbox allow-scripts`, `default-src 'none'`, `script-src 'unsafe-inline' ${at}/web/`, `style-src 'unsafe-inline' ${at}/web/`,
    `img-src data: blob: ${at}/web/`, `font-src data: ${at}/web/`, `connect-src ${at}/api/`, `media-src 'none'`, `frame-src 'none'`,
    `worker-src 'none'`, `object-src 'none'`, `manifest-src 'none'`, `form-action 'none'`, `base-uri 'none'`].join('; ');
}

// The outer frame: no script, one inner frame, the full size of the overlay.
export const wrapperHtml = (tok) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head>`
  + `<body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" src="${pagePrefix(tok)}/" title="preview"></iframe></body></html>`;

// ctx: { send, demo }. Returns true when it answered.
export function handleTryPage(req, res, p, ctx) {
  const m = p.match(TRY_RE);
  if (!m) return false;
  const [, tok, rest = '/'] = m, e = !ctx.demo && lookupTry(tok);
  const text = (code, body) => ctx.send(res, code, 'text/plain; charset=utf-8', body, { 'cache-control': 'no-store', ...CORS });
  if (!e) return text(404, '预览已过期 · This preview has expired'), true;
  const ch = getChange(e.sroot, e.id);
  if (!ch || ch.who !== e.who || !PENDING.includes(ch.state)) { tokens.delete(tok); return text(404, '这个改动已不在等待发布 · This change is no longer waiting to publish'), true; }
  if (req.method === 'OPTIONS') { ctx.send(res, 204, 'text/plain', null, CORS); return true; }
  const host = String(req.headers.host || '');
  if (!HOST_RE.test(host)) return text(400, 'bad host'), true;
  req.resume();   // a fake API write's body is never read
  if (rest === '/' || rest === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method'), true;
    ctx.send(res, 200, 'text/html; charset=utf-8', wrapperHtml(tok), { 'content-security-policy': wrapperCsp(host, tok), 'cache-control': 'no-store' });
    return true;
  }
  if (!rest.startsWith('/page/')) return text(404, ''), true;
  const r = previewAnswer(repoDir(e.sroot), `${pagePrefix(tok)}${rest.slice('/page'.length)}`, { prefix: pagePrefix(tok) });
  const html = /^text\/html/.test(r.type);
  ctx.send(res, r.status, r.type, r.body, { 'cache-control': 'no-store', ...CORS, ...(html ? { 'content-security-policy': pageCsp(host, tok) } : {}) });
  return true;
}
