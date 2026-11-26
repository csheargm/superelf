// 分享 · Share an app by link — the routes (docs/adr/0047-app-share-link.md; store: lib/app-share.mjs).
//
// DEMO node (makeDemoShareRoutes, mounted by lib/demo-routes.mjs):
//   POST /api/share {slug}          a signed-in visitor shares their own app → { id, url }
//   POST /api/share/ingest          the owner node's signed snapshot (x-share-* headers, lib/app-share.mjs)
//   GET  /s/<id>                    the link page: name, one line, Sign in; sets the share cookie
//   POST /api/share/<id>/join       the signed-in visitor gets their OWN copy (repeat-safe)
// OWNER node (handleOwnerShareRoute, mounted by web.mjs):
//   POST /api/share {slug}          strict privacy scan here, then the signed POST to the demo's ingest
//   POST /api/share/email {id,to,key,note?}  AgentMail: minimal text + the link (lib/app-share-mail.mjs); one key = one email
// Demo users can never publish to GitHub from here: nothing in this file talks to GitHub.
import { SHARE_PATHS, SHARE_PAGE_RE, SHARE_JOIN_RE, SHARE_COOKIE, SHARE_ID_RE, SHARE_MESSAGES, ShareError,
  shareLimit, ingestSecret, collectForShare, scanShare, checkIngestFiles, signIngest, verifyIngest, makeShareStore } from './app-share.mjs';
import { SB_KEY } from './demo-boot.mjs';
import { SHARE_EMAIL, PREFILL_PARAM, PREFILL_STASH, SEND_KEY_RE, sealPrefill, openPrefill, cleanNote, makeSendOnce } from './app-share-mail.mjs';
import { loadTermsStrict } from './publish/scan.mjs';
import { readCookie } from './demo.mjs';
import { demoLimit } from './demo-quota.mjs';
import { slugOk } from './webutil.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { writeJsonFile } from './atomicwrite.mjs';

const NONCE_FILE = 'nonces.json';
function loadNonces(root) {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'app-shares', NONCE_FILE), 'utf8')))); }
  catch (e) { if (e.code === 'ENOENT') return new Map(); throw e; }   // a damaged file fails loud (R5): replays must not slip through
}
function saveNonces(root, seen) { fs.mkdirSync(path.join(root, 'app-shares'), { recursive: true }); writeJsonFile(path.join(root, 'app-shares', NONCE_FILE), Object.fromEntries(seen)); }

const INGEST_TIMEOUT_MS = 20_000;
const B64_OVERHEAD = 1.4, JSON_SLACK = 64 * 1024;
const COOKIE_MAX_AGE_S = 3600;
const bearerOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const shareUrl = (cfg, id) => `${shareLimit(cfg, 'demo_url')}/s/${id}`;
const bodyCap = (cfg) => Math.ceil(shareLimit(cfg, 'max_mb') * 1024 * 1024 * B64_OVERHEAD) + JSON_SLACK;
// A hit as a non-owner sees it: the rule and where, never the matched text.
const plainHits = (hits) => hits.slice(0, 20).map((h) => ({ file: h.file, line: h.line, rule: h.rule }));
const shareError = (json, res, e) => {
  if (!(e instanceof ShareError)) throw e;
  json(res, e.status, { ok: false, code: e.code, error: e.message, ...(e.hits ? { hits: e.hits } : {}) });
};

// The exemption from the per-network NEW-visitor cap (only that one): a live link in the share
// cookie, fewer than joins_per_link joins on it, and the creator under exempt_per_creator_per_day
// today — counted in the quota store, so it is spent once per new visitor. → true when exempt.
export function shareExempt({ cfg, store, shares, cookieHeader }) {
  const id = readCookie(cookieHeader, SHARE_COOKIE);
  if (!SHARE_ID_RE.test(id)) return false;
  const r = shares.get(id);
  if (!r || r.joins.length >= shareLimit(cfg, 'joins_per_link')) return false;
  return store.consume([[`share-x:${id}`, shareLimit(cfg, 'joins_per_link')], [`share-xby:${r.by.uid}`, shareLimit(cfg, 'exempt_per_creator_per_day')]]).ok;
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const SHARE_PAGE_LABELS = Object.freeze({
  get: '登录并获取 · Sign in and get it',
  own: '登录后你会得到自己的一份，数据只属于你 · After you sign in you get your own copy; its data is yours alone',
  safari: '在 Safari 中打开 · Open in Safari',
  inApp: '这是应用内浏览器，看不到你在 Safari 里的登录。点右上角 ⋯ 或分享按钮，选「在 Safari 中打开」。 · This in-app browser cannot see your Safari sign-in. Use its ⋯ or share button and choose Open in Safari.',
});
// In-app browsers (Gmail, Google app, Facebook, Instagram, LINE, WeChat, Android WebView) keep their
// own storage: a visitor signed in in Safari looks signed out here. A home-screen app is not one.
export const IN_APP_RE_SRC = String.raw`\bGSA\/|FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)|(iPhone|iPad).*AppleWebKit(?!.*Safari\/)`;
// The page's script: a signed-in browser (the shell's Supabase session, lib/demo-boot.mjs SB_KEY) goes
// straight on to its copy; a prefill from a share email waits for the shell's sign-in box (never signs in).
const landingScript = (id, email) => `<script>(function(){var id=${JSON.stringify(id)},e=${JSON.stringify(email).replace(/</g, '\\u003c')};
try{if(location.search)history.replaceState(null,'',location.pathname);}catch(x){/* an old browser: the token stays in the address bar; it only prefills */}
try{if(e)sessionStorage.setItem('${PREFILL_STASH}',e);}catch(x){/* blocked storage: the visitor types the email */}
var s=null;try{s=JSON.parse(localStorage.getItem('${SB_KEY}')||'null');}catch(x){/* blocked or damaged storage: signed out here */}
if(s&&s.a){location.replace('/?share='+id);return;}
if(new RegExp(${JSON.stringify(IN_APP_RE_SRC)}).test(navigator.userAgent)&&!navigator.standalone){var h=document.getElementById('shInApp');if(h)h.hidden=false;}})();</script>`;
function landing(r, email) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.name)}</title>
<style>:root{--bg:#fbfaf7;--text:#1c1e1d;--muted:#5f6662;--accent:#0f6355;--card:#fff;--line:#e3e0d8}@media(prefers-color-scheme:dark){:root{--bg:#141615;--text:#ecebe6;--muted:#a3a8a4;--accent:#5fc2ad;--card:#1d201f;--line:#2e3230}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,system-ui,sans-serif;display:flex;min-height:100dvh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;box-sizing:border-box}h1{font-size:22px;margin:0 0 6px;overflow-wrap:anywhere}p{margin:0 0 14px;color:var(--muted);overflow-wrap:anywhere}
a.go{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;padding:12px;border-radius:22px;min-height:44px;box-sizing:border-box}small{display:block;margin-top:12px;color:var(--muted)}
#shInApp{border:1px solid var(--line);border-radius:10px;padding:10px;margin:0 0 14px;font-size:14px}#shInApp b{display:block;color:var(--text)}</style></head>
<body><main><h1 id="shName">${esc(r.name)}</h1>${r.desc ? `<p id="shDesc">${esc(r.desc)}</p>` : ''}<div id="shInApp" hidden><b>${SHARE_PAGE_LABELS.safari}</b>${SHARE_PAGE_LABELS.inApp}</div><a class="go" id="shGo" href="/?share=${r.id}">${SHARE_PAGE_LABELS.get}</a><small>${SHARE_PAGE_LABELS.own}</small></main>${landingScript(r.id, email)}</body></html>`;
}

// x: { d, gate, json, ipOf, disk } from lib/demo-routes.mjs.
export function makeDemoShareRoutes({ d, gate, json, disk }) {
  const shares = d.shares || (d.shares = makeShareStore(d.root));
  let seen = null;   // read on first ingest (a damaged file fails that request, never the boot); persisted: a restart inside the window cannot accept a replay (GPT review)
  async function signedUser(req, res) {
    const user = d.userFor(req);
    if (!user) { json(res, 401, { ok: false, code: 'signin', error: SHARE_MESSAGES.signin }); return null; }
    const refused = await gate.check(user, bearerOf(req));
    if (refused) { json(res, refused.status, refused.body); return null; }
    return user;
  }
  const countShare = (key) => { if (!d.store.consume([[`share:${key}`, shareLimit(d.cfg, 'per_day')]]).ok) throw new ShareError('per_day', 429, SHARE_MESSAGES.per_day); };
  function store(srcKey, slug, name, desc, by, files) {
    const full = disk(null); if (!full.ok) throw new ShareError(full.code || 'disk', full.status, full.error);   // the node's disk cap first (GPT review)
    const hits = scanShare(files, { name, desc }, []);
    if (hits.length) throw new ShareError('private', 422, SHARE_MESSAGES.private, { hits: plainHits(hits) });
    countShare(by.uid);
    const r = shares.put({ srcKey, slug, name, desc, by, files });
    d.audit('share-made', { by: by.uid, id: r.id, slug, version: r.versions });
    return { ok: true, id: r.id, url: shareUrl(d.cfg, r.id), mail: false };
  }
  async function create(req, res) {
    const user = await signedUser(req, res); if (!user) return;
    const b = (await d.readBody(req, d.BODY_LIMITS.control)) || {};
    const slug = typeof b.slug === 'string' && slugOk(b.slug) ? b.slug : '';
    if (!slug) return json(res, 400, { ok: false, error: SHARE_MESSAGES.no_app });
    const c = collectForShare(path.join(user.workspace, 'apps', slug), slug, d.cfg);
    json(res, 200, store(`${user.id}:${slug}`, slug, c.name, c.desc, { kind: 'demo', uid: user.id }, c.files));
  }
  async function ingest(req, res) {
    const secret = ingestSecret(d.cfg);
    if (!secret) return d.send(res, 404, 'text/plain', 'not found');   // no channel: as if the route did not exist
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len > bodyCap(d.cfg)) return json(res, 413, { ok: false, code: 'too_big', error: SHARE_MESSAGES.too_big });
    const b = await d.readBody(req, bodyCap(d.cfg));
    seen ||= loadNonces(d.root);
    if (!verifyIngest(secret, req.headers, JSON.stringify(b), seen)) return d.send(res, 404, 'text/plain', 'not found');
    saveNonces(d.root, seen);
    const slug = typeof b.slug === 'string' && slugOk(b.slug) ? b.slug : '', uid = typeof b.uid === 'string' && /^[a-z0-9_-]{1,64}$/i.test(b.uid) ? b.uid : '';
    if (!slug || !uid) return json(res, 400, { ok: false, error: 'bad share' });
    const files = checkIngestFiles(b.files, d.cfg);
    const name = String(b.name || slug).slice(0, 80), desc = String(b.desc || '').split('\n')[0].slice(0, 200);
    json(res, 200, store(`owner:${uid}:${slug}`, slug, name, desc, { kind: 'owner', uid: `owner:${uid}`, name: String(b.by || '').slice(0, 80) }, files));
  }
  async function join(req, res, id) {
    const user = await signedUser(req, res); if (!user) return;
    const full = disk(user); if (!full.ok) return json(res, full.status, full);
    const r = shares.join(id, user.id, path.join(user.workspace, 'apps'), demoLimit(d.cfg, 'apps_per_user'));
    if (!r.again) d.audit('share-joined', { id, who: user.id, slug: r.slug });
    json(res, 200, { ok: true, slug: r.slug, name: r.name });
  }
  return async function handle(req, res, p) {
    try {
      if (req.method === 'POST' && p === SHARE_PATHS.create) { await create(req, res); return true; }
      if (req.method === 'POST' && p === SHARE_PATHS.ingest) { await ingest(req, res); return true; }
      const pm = req.method === 'GET' && SHARE_PAGE_RE.exec(p);   // p: the path only; the prefill token is in the query
      if (pm) {
        const r = shares.get(pm[1]);
        if (!r) { d.send(res, 404, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:16px">${SHARE_MESSAGES.gone}</p>`); return true; }
        d.send(res, 200, 'text/html; charset=utf-8', landing(r, openPrefill(ingestSecret(d.cfg), new URL(req.url, 'http://x').searchParams.get(PREFILL_PARAM) || '')), { 'set-cookie': `${SHARE_COOKIE}=${r.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return true;
      }
      const jm = req.method === 'POST' && SHARE_JOIN_RE.exec(p);
      if (jm) { await join(req, res, jm[1]); return true; }
      return false;
    } catch (e) { shareError(json, res, e); return true; }
  };
}

// The demo admin's 分享 · Shares tab (lib/demo-admin.mjs): every share, its maker, its joiners and
// whether each opened their copy (the usage counts of the last `days`).
export function shareAdminList({ shares, users, usage, days }) {
  const opened = new Map();
  for (const day of usage.days(days)) for (const [uid, u] of Object.entries(day.users)) for (const [slug, c] of Object.entries(u.apps || {})) if (c.open) opened.set(`${uid}:${slug}`, true);
  const people = new Map(users.all().map((u) => [u.id, u]));
  const who = (uid) => { const u = people.get(uid); return u ? (u.email || u.name || uid) : uid; };
  return shares.list().map((r) => ({ id: r.id, name: r.name, slug: r.slug, created: r.created, updated: r.updated, versions: r.versions, down: !!r.down,
    by: r.by.kind === 'owner' ? (r.by.name || '主人 · Owner') : who(r.by.uid), byKind: r.by.kind,
    joins: r.joins.map((j) => ({ who: who(j.uid), at: j.at, used: opened.has(`${j.uid}:${j.slug}`) })) }));
}

// ---- owner node ---------------------------------------------------------------------------------
// ctx: { user, cfg, root, ownAppDir, readBody, send, audit, mail, demo, fetchImpl }
const EMAIL_RE = /^[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const sendOnce = makeSendOnce();   // per process: one key = one email (a retry or a second tap never sends twice)
async function emailShare(b, ctx, json) {
  const id = typeof b.id === 'string' && SHARE_ID_RE.test(b.id) ? b.id : '', to = typeof b.to === 'string' ? b.to.trim() : '';
  if (!id || !EMAIL_RE.test(to) || !SEND_KEY_RE.test(String(b.key || ''))) return json(400, { ok: false, error: '邮箱或链接无效 · Bad email or link' });
  if (!ctx.mail) return json(409, { ok: false, error: '未配置邮件通道 · Email channel not configured' });
  const name = String(b.name || 'superelf').slice(0, 80), note = cleanNote(b.note);
  const k = sealPrefill(ingestSecret(ctx.cfg), to), url = shareUrl(ctx.cfg, id) + (k ? `?${PREFILL_PARAM}=${k}` : '');
  const r = await sendOnce(`${ctx.user.id}:${b.key}`, async () => {
    await ctx.mail.sendEmail({ to, subject: SHARE_EMAIL.subject(name), text: SHARE_EMAIL.text(url, note), html: SHARE_EMAIL.html(url, note) });
    ctx.audit('share-emailed', { who: ctx.user.id, id });
    return { ok: true };
  });
  json(200, r);
}
export async function handleOwnerShareRoute(req, res, p, ctx) {
  if (req.method !== 'POST' || (p !== SHARE_PATHS.create && p !== SHARE_PATHS.email)) return false;
  const json = (code, body) => ctx.send(res, code, 'application/json', JSON.stringify(body));
  if (ctx.demo || !ctx.user || ctx.user.role !== 'owner') { json(403, { ok: false, error: SHARE_MESSAGES.owner_only }); return true; }
  const b = (await ctx.readBody(req)) || {};
  try {
    if (p === SHARE_PATHS.email) { await emailShare(b, ctx, json); return true; }
    const secret = ingestSecret(ctx.cfg);
    if (!secret) { json(409, { ok: false, code: 'no_channel', error: SHARE_MESSAGES.no_channel }); return true; }
    const slug = typeof b.slug === 'string' && slugOk(b.slug) ? b.slug : '';
    const dir = slug && ctx.ownAppDir(ctx.user, slug);
    if (!dir) { json(404, { ok: false, error: SHARE_MESSAGES.no_app }); return true; }
    const c = collectForShare(dir, slug, ctx.cfg);
    let terms;
    try { terms = loadTermsStrict(ctx.root); } catch (e) { json(409, { ok: false, code: 'terms', error: e.message }); return true; }   // fail closed, as Publish
    const hits = scanShare(c.files, { name: c.name, desc: c.desc }, terms);
    if (hits.length) { json(422, { ok: false, code: 'private', error: SHARE_MESSAGES.private, hits: hits.slice(0, 20) }); return true; }   // the owner's own code: the line is shown
    const text = JSON.stringify({ slug, uid: ctx.user.id, by: ctx.user.name || '', name: c.name, desc: c.desc, files: c.files.map((f) => ({ path: f.path, b64: f.content.toString('base64') })) });
    const r = await (ctx.fetchImpl || fetch)(`${shareLimit(ctx.cfg, 'demo_url')}${SHARE_PATHS.ingest}`, { method: 'POST', body: text,
      headers: { 'content-type': 'application/json', ...signIngest(secret, text) }, signal: AbortSignal.timeout(INGEST_TIMEOUT_MS) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) { json(502, { ok: false, code: 'no_channel', error: `${SHARE_MESSAGES.no_channel} (demo)` }); return true; }
    if (!r.ok || !j.ok) { json(r.status >= 400 && r.status < 500 ? r.status : 502, { ok: false, code: j.code || 'demo', error: j.error || `演示站回复 ${r.status} · The demo answered ${r.status}` }); return true; }
    ctx.audit('share-sent', { who: ctx.user.id, slug, id: j.id });
    json(200, { ok: true, id: j.id, url: j.url, name: c.name, mail: !!ctx.mail }); return true;
  } catch (e) {
    if (e instanceof ShareError) { json(e.status, { ok: false, code: e.code, error: e.message }); return true; }
    if (e && (e.name === 'TimeoutError' || e.cause)) { json(502, { ok: false, code: 'demo', error: `演示站无法连接 · Could not reach the demo: ${e.message}` }); return true; }
    throw e;
  }
}
