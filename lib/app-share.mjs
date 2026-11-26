// 分享 · Share an app by link (docs/adr/0047-app-share-link.md). The STORE half: snapshots of an
// app's page code on the DEMO node (never git), an index of links, joins and take-downs, and the
// signed owner-node → demo channel. Routes live in lib/app-share-routes.mjs.
//
// - A snapshot holds page code only (lib/publish/collect.mjs collectApp: no data/, no links, code
//   kinds only), at <root>/app-shares/<id>/. A re-share of the same app (same srcKey) replaces it
//   under the SAME id; the old one moves to .versions/<id>/<stamp>. Copies already made stay.
// - Ids: 128 random bits, base64url (22 chars). Unknown and taken-down ids look the same (null).
// - Limits are config `shares` (read at use time), falling back to SHARE_DEFAULTS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from './atomicwrite.mjs';
import { copyNoLinks } from './app-versions.mjs';
import { slugOk } from './webutil.mjs';
import { collectApp, readAppMeta, CODE_EXTS, CODE_JSON } from './publish/collect.mjs';
import { scanFiles, scanLabels } from './publish/scan.mjs';

export const SHARE_DIR = 'app-shares';
export const SHARE_COOKIE = 'superelf_share';
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SHARE_PATHS = Object.freeze({ create: '/api/share', ingest: '/api/share/ingest', email: '/api/share/email' });
export const SHARE_PAGE_RE = /^\/s\/([A-Za-z0-9_-]{22})$/;
export const SHARE_JOIN_RE = /^\/api\/share\/([A-Za-z0-9_-]{22})\/join$/;
export const SHARE_DEFAULTS = Object.freeze({
  per_day: 10,                      // shares per person per UTC day
  max_mb: 2,                        // one app's code
  joins_per_link: 50,               // sign-ups through one link that skip the new-visitor cap
  exempt_per_creator_per_day: 30,   // …and through all of one person's links in a day
  demo_url: 'https://try.superelf.app',
});
export function shareLimit(cfg, key) {
  const s = cfg && cfg.shares && typeof cfg.shares === 'object' ? cfg.shares[key] : undefined;
  if (key === 'demo_url') return typeof s === 'string' && /^https?:\/\/[^/\s]+$/.test(s.trim()) ? s.trim() : SHARE_DEFAULTS.demo_url;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 ? s : SHARE_DEFAULTS[key];
}
// The shared secret of the owner-node → demo channel: config `share_ingest_secret`, read at use time.
const SECRET_MIN = 32;
export const ingestSecret = (cfg) => (cfg && typeof cfg.share_ingest_secret === 'string' && cfg.share_ingest_secret.length >= SECRET_MIN ? cfg.share_ingest_secret : '');

export const SHARE_MESSAGES = Object.freeze({
  private: '分享被拒：应用代码里有个人信息 · Not shared: the app code contains personal information',
  too_big: '应用太大，无法分享 · The app is too big to share',
  per_day: '今天分享次数已满，明天再试 · Daily share limit reached — try again tomorrow',
  no_app: '没有这个应用 · No such app',
  no_channel: '未配置分享通道 · Share channel not set up',
  gone: '链接无效或已下架 · This link is not valid or was taken down',
  apps_full: '应用数量已满，请先删除一个 · You have the most apps allowed — delete one first',
  signin: '请先登录 · Please sign in first',
  owner_only: '仅主人可分享 · Only the owner can share',
  no_index: '应用首页无法分享（过大或不是代码）· The app\'s page cannot be shared (too big or not code)',
  copied: '复制来的应用不能再分享 · A copied app cannot be shared on',
});
export class ShareError extends Error { constructor(code, status, msg, extra = {}) { super(msg); this.code = code; this.status = status; Object.assign(this, extra); } }

// The share a copy came from ('' when none): a repeat join returns only a copy that is still this share's.
function sharedFromOf(dir) { try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).sharedFrom || ''); } catch { return ''; /* gone or no meta: not that copy */ } }
export const newShareId = () => crypto.randomBytes(16).toString('base64url');

// The app's code as [{ path (inside the app), content }], with its name and one-line description.
// Throws ShareError. Reuses Publish's collector (R3) under a throwaway base, then strips it.
const BASE = 'x';
export function collectForShare(appDir, slug, cfg) {
  if (!slugOk(slug) || !fs.existsSync(path.join(appDir, 'index.html'))) throw new ShareError('no_app', 404, SHARE_MESSAGES.no_app);
  let got;
  try { got = collectApp(appDir, slug, { base: BASE, owner: '' }); }
  catch (e) { if (e && e.code === 'FORKED_APP') throw new ShareError('copied', 422, SHARE_MESSAGES.copied); if (e && e.code === 'TOO_BIG') throw new ShareError('too_big', 413, SHARE_MESSAGES.too_big); if (e && /^[A-Z_]+$/.test(e.code || '')) throw new ShareError('bad_app', 422, e.message); throw e; }
  const pre = `${BASE}/${slug}/`;
  const files = got.files.map((f) => ({ path: f.path.slice(pre.length), content: f.content }));
  if (!files.some((f) => f.path === 'index.html')) throw new ShareError('bad_app', 422, SHARE_MESSAGES.no_index);   // a link with no page (GPT review)
  checkSize(files, cfg);
  const meta = readAppMeta(appDir);
  return { files, name: String(meta.title || meta.name || slug).slice(0, 80), desc: String(meta.desc || meta.description || '').split('\n')[0].slice(0, 200) };
}
function checkSize(files, cfg) {
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total > shareLimit(cfg, 'max_mb') * 1024 * 1024) throw new ShareError('too_big', 413, SHARE_MESSAGES.too_big);
}

// The privacy check (lib/publish/scan.mjs, R3) over code + the labels that are shown on the link page.
// terms: the owner node's strict terms; [] on the demo (generic rules + PII only: it holds no owner terms).
export function scanShare(files, labels, terms) {
  return [...scanFiles(files, terms, { allowNoTerms: !terms.length }), ...scanLabels(labels, terms)];
}

// Ingested files (owner node → demo) are re-checked here: plain relative paths, code kinds only, no data/.
const PATH_OK = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
export function checkIngestFiles(list, cfg) {
  if (!Array.isArray(list) || !list.length || list.length > 200) throw new ShareError('bad_files', 400, 'bad files');
  const files = list.map((f) => {
    const p = f && typeof f.path === 'string' ? f.path : '';
    const name = p.split('/').pop();
    const ok = PATH_OK.test(p) && !p.split('/').includes('data') && (CODE_JSON.has(p) || CODE_EXTS.has(path.extname(name).toLowerCase()));
    if (!ok || typeof f.b64 !== 'string') throw new ShareError('bad_files', 400, `bad file: ${p.slice(0, 80)}`);
    return { path: p, content: Buffer.from(f.b64, 'base64') };
  });
  if (!files.some((f) => f.path === 'index.html')) throw new ShareError('bad_files', 400, 'no index.html');
  checkSize(files, cfg);
  return files;
}

// ---- the signed channel (owner node → demo) -------------------------------------------------
export const SIG_SKEW_S = 300;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const sigOf = (secret, ts, nonce, bodyText) => crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${sha256(bodyText)}`).digest('hex');
export function signIngest(secret, bodyText, now = Date.now()) {
  const ts = String(Math.floor(now / 1000)), nonce = crypto.randomBytes(16).toString('hex');
  return { 'x-share-ts': ts, 'x-share-nonce': nonce, 'x-share-sig': sigOf(secret, ts, nonce, bodyText) };
}
// seen: a Map nonce → expiry (ms), kept by the caller. → true when the request is genuine and fresh.
export function verifyIngest(secret, headers, bodyText, seen, now = Date.now()) {
  const ts = String(headers['x-share-ts'] || ''), nonce = String(headers['x-share-nonce'] || ''), sig = String(headers['x-share-sig'] || '');
  if (!secret || !/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > SIG_SKEW_S) return false;
  const want = Buffer.from(sigOf(secret, ts, nonce, bodyText), 'hex');
  if (!crypto.timingSafeEqual(want, Buffer.from(sig, 'hex'))) return false;
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(nonce)) return false;   // a replay
  seen.set(nonce, now + 2 * SIG_SKEW_S * 1000);
  return true;
}

// ---- the store --------------------------------------------------------------------------------
// index.json: { shares: { <id>: { id, srcKey, slug, name, desc, by: { kind, uid, name }, created, updated, versions, down, joins: [{ uid, slug, at }] } } }
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');
export function makeShareStore(root) {
  const dir = path.join(root, SHARE_DIR), file = path.join(dir, 'index.json');
  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { shares: {} }; throw e; }
    const v = JSON.parse(text);   // a damaged index throws (R5): starting over would orphan every link
    return v && typeof v.shares === 'object' ? v : { shares: {} };
  }
  const save = (s) => { fs.mkdirSync(dir, { recursive: true }); writeJsonFile(file, s); };
  // files: [{ path, content }] already checked and scanned. → the record (same id on a re-share).
  function put({ srcKey, slug, name, desc, by, files }) {
    const s = load();
    let rec = Object.values(s.shares).find((r) => r.srcKey === srcKey && !r.down);
    const id = rec ? rec.id : newShareId();
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    for (const f of files) { const t = path.join(tmp, ...f.path.split('/')); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, f.content); }
    const live = path.join(dir, id);
    let old = null;
    if (fs.existsSync(live)) { old = path.join(dir, '.versions', id, stampNow()); fs.mkdirSync(path.dirname(old), { recursive: true }); fs.renameSync(live, old); }
    try { fs.renameSync(tmp, live); }
    catch (e) {   // the swap failed: the old snapshot goes back, so an advertised link still joins (nightly review 2026-11-26)
      if (old) fs.renameSync(old, live);
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    const now = Date.now();
    rec = rec ? { ...rec, slug, name, desc, updated: now, versions: (rec.versions || 1) + 1 } : { id, srcKey, slug, name, desc, by, created: now, updated: now, versions: 1, down: false, joins: [] };
    s.shares[id] = rec; save(s);
    return rec;
  }
  const get = (id) => { if (!SHARE_ID_RE.test(String(id))) return null; const r = load().shares[id]; return r && !r.down && fs.existsSync(path.join(dir, id)) ? r : null; };   // no snapshot folder (a crash mid-swap): not active
  const list = () => Object.values(load().shares).sort((a, b) => b.updated - a.updated);
  function takedown(id) {
    const s = load(), r = SHARE_ID_RE.test(String(id)) ? s.shares[id] : null;
    if (!r || r.down) return false;
    r.down = true; r.downAt = Date.now(); save(s);
    return true;
  }
  // A copy of the live snapshot in the joiner's own apps/. Repeating it returns the copy already made.
  function join(id, uid, appsDir, maxApps) {
    const s = load(), r = SHARE_ID_RE.test(String(id)) ? s.shares[id] : null;
    if (!r || r.down || !fs.existsSync(path.join(dir, id))) throw new ShareError('gone', 404, SHARE_MESSAGES.gone);   // no snapshot folder: gone, never a raw fs error (GPT review)
    const had = r.joins.find((j) => j.uid === uid);
    if (had && sharedFromOf(path.join(appsDir, had.slug)) === id && fs.existsSync(path.join(appsDir, had.slug, 'index.html'))) return { slug: had.slug, name: r.name, again: true };
    fs.mkdirSync(appsDir, { recursive: true });
    const own = fs.readdirSync(appsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
    if (own >= maxApps) throw new ShareError('apps_full', 409, SHARE_MESSAGES.apps_full);
    let slug = r.slug, n = 2;
    while (fs.existsSync(path.join(appsDir, slug))) { slug = `${r.slug.slice(0, 36)}-${n++}`;   // stays a slug (≤ 40 chars)
      if (n > 99) throw new ShareError('apps_full', 409, SHARE_MESSAGES.apps_full); }
    const dst = path.join(appsDir, slug);
    copyNoLinks(path.join(dir, id), dst);
    const mf = path.join(dst, 'meta.json');
    let m = {}; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')) || {}; } catch { /* no meta in the snapshot: a fresh one */ }
    m.title = m.title || r.name; m.sharedFrom = id; delete m.shared; delete m.sharedBy;
    writeJsonFile(mf, m);
    if (had) had.slug = slug; else r.joins.push({ uid, slug, at: Date.now() });
    save(s);
    return { slug, name: r.name, again: false };
  }
  return { put, get, list, takedown, join, dir };
}
