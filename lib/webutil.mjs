import path from 'node:path';
import fs from 'node:fs';

// Joins a user-supplied relative path onto a base dir, refusing anything that
// escapes it: .. traversal, absolute paths, encoded tricks, null bytes, AND
// symlinks that point outside the base (resolved with realpath).
export function safeJoin(baseDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  let dec;
  try { dec = decodeURIComponent(rel); } catch { return null; }
  if (dec.includes('\0') || path.isAbsolute(dec)) return null;
  const base = path.normalize(baseDir + path.sep);
  const p = path.normalize(path.join(baseDir, dec));
  if (!p.startsWith(base)) return null;
  // Symlink defense: the skip-permissions agent could plant a link inside the
  // workspace pointing at ~/.ssh etc. Resolve real paths and re-check.
  try {
    const realBase = fs.realpathSync(baseDir) + path.sep;
    const realP = fs.realpathSync(p);
    if (!(realP + path.sep).startsWith(realBase) && realP !== fs.realpathSync(baseDir)) return null;
  } catch (e) {
    if (e.code === 'ENOENT') return p; // file simply doesn't exist yet — lexical check already passed
    return null;
  }
  return p;
}

// Windows resolves these names to DEVICES, not files, at any path and with any extension: a
// directory named "con" or "aux" cannot be created, and opening "prn" writes to a printer port.
// Every app slug becomes a directory name, so an app called "con" bricks itself on Windows only.
export const RESERVED_DEVICE_NAMES = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

export const slugOk = (s) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(s || '') && !RESERVED_DEVICE_NAMES.has(s);

// The ☰ drawer's section ids（侧栏分组）— the ONE list both the shell (web/index.html ids) and the profile route use.
export const DRAWER_SECTIONS = Object.freeze(['secApps', 'secFamily', 'secBriefs', 'secChats']);
// {secId: boolean} with only known sections kept; anything else reads as "no taps yet".
export function drawerOpenOf(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const k of DRAWER_SECTIONS) if (typeof v[k] === 'boolean') out[k] = v[k];
  return out;
}

// Absent vs unreadable — THE root shape of the 2026-09-02 data loss on the
// server side — lives in lib/readjson.mjs (readJsonState / readJson /
// readJsonForUpdate). Re-exported here ONLY so the many existing
// `import { readJson } from './webutil.mjs'` callers keep one import; new code
// imports from lib/readjson.mjs directly. R4: this file is at its 300-line
// budget, which is why that block moved out rather than growing here.
export { readJson } from './readjson.mjs';
import { FILE_UNREADABLE_CODE } from './readjson.mjs';
import { bodyEncoding, createCappedGunzip, GZIP_BAD, GZIP_UNSUPPORTED, GZIP_OVER_LIMIT_CODE } from './gzipbody.mjs';

// Atomic writes live in lib/atomicwrite.mjs (R4: this file is at its 300-line budget, the same
// reason readjson.mjs was split out). Re-exported here so the many existing
// `import { writeJsonFile } from './webutil.mjs'` callers keep one import; new code imports from
// lib/atomicwrite.mjs directly.
export { writeFileAtomic, writeJsonFile, renameWithRetry } from './atomicwrite.mjs';

// The ONE sanitize-and-truncate for untrusted text rendered as a single line
// (R3 — the old daily brief's cap() and runner's toolBrief were drifting copies,
// and neither stripped control characters). Applied at every compose boundary
// where attacker-influenced text (approval titles, tool briefs) is joined into
// a message:
//   - CR / LF / TAB become a single space — a crafted =0A subject can never
//     forge extra lines (the injection PoC scar);
//   - all other C0+C1 controls (incl. ESC, DEL) and the bidi/format controls
//     U+200E/U+200F, U+202A–U+202E, U+2066–U+2069 are stripped — no terminal
//     escapes, no RTL-override display spoofing;
//   - whitespace collapses to single spaces, then a hard length cap with '…'.
export function sanitizeLine(s, max) {
  const out = String(s ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

// Public base URL check（对外基址）— ONE definition (R3): validates
// cfg.public_base_url at boot (lib/config.mjs) and at every Node-settings
// write (lib/adminconfig.mjs). This is the base for URLs handed to OTHER
// devices (the health-setup QR the phone scans), so it must be an http(s)
// origin the phone can reach — plain http allowed deliberately (Tailscale /
// LAN hostnames without certs); no query, no fragment, no credentials.
export const baseUrlOk = (s) => {
  if (typeof s !== 'string' || !s.trim() || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
};

export function tokenOk(given, actual) {
  if (typeof given !== 'string' || typeof actual !== 'string') return false;
  if (!given || !actual || given.length !== actual.length) return false;
  let d = 0;
  for (let i = 0; i < actual.length; i++) d |= given.charCodeAt(i) ^ actual.charCodeAt(i);
  return d === 0;
}


// ── Request-body reading（请求体读取）─────────────────────────────────────────
// Thrown on overflow and matched ONLY in bodyErrorResponse below — one
// string (R3). The other two failure strings are pinned the same way.
export const BODY_TOO_LARGE = 'body too large';
export const BODY_BAD_JSON = 'bad JSON';
export const BODY_READ_TIMEOUT = 'body read timeout';

// ── Per-route body limits（每路由请求体上限）─────────────────────────────────
// R3: the ONE table of request-body caps. readBody REQUIRES an explicit limit
// (see below) so no route can silently inherit a cap that is wrong for its
// payload — DATA-LOSS SCAR 2026-09-02: app data (handwriting notebooks!) rode
// readBody's old 64KB default, so every save past that size was rejected and
// a note froze at its last successful write, losing a page of Apple Pencil
// strokes. Sizes are chosen per payload, not by habit:
//   auth     — username + PIN + display name.
//   control  — a slug, an id, a title, a boolean flag.
//   profile  — prompt overrides (2000 chars each, per app).
//   config   — one whitelisted settings field; model lists are the big ones.
//   chat     — a typed message plus an app's accumulated context. CORRECTED
//              2026-09-02 round 2: the old note here claimed "attachments
//              travel separately through /api/upload, never inline here",
//              which is FALSE. Only BINARY attachments go through /api/upload;
//              the shell composer reads a TEXT attachment (.md/.json/.csv/.txt
//              /.js/.py/.log) and splices its whole content into `message`. So
//              this cap covers pasted-in file content too, and a client MUST
//              measure the composed body before sending (web/chat-ui.inline
//              .html pre-flight, web/index.html composer) — the alternative is
//              the invisible 413 that defect V4 was.
//   upload   — base64 inflates 4/3, so ~15MB of real file.
//   appData  — a whole notebook per save (see lib/appdata.mjs for what this
//              number means in pages, and why the design must change before
//              it is ever approached).
export const BODY_LIMITS = Object.freeze({
  auth: 8 * 1024,
  control: 8 * 1024,
  profile: 64 * 1024,
  config: 64 * 1024,
  chat: 1024 * 1024,
  upload: 20 * 1024 * 1024,
  appData: 16 * 1024 * 1024,
});

// Overall deadline for reading ONE request body, drain included. Generous
// because the meal-photo Shortcut uploads ~6 MB over cellular; still finite
// so no client can hold a connection open forever (see the tradeoff below).
export const BODY_READ_TIMEOUT_MS = 60_000;

// Read a JSON request body with a size cap.
//
// Overflow tradeoff — SETTLED (prior-review leftover): on overflow we reject
// but DRAIN the rest instead of destroying the socket, so the 413 the route
// sends can actually reach the client (destroy() = curl sees a connection
// reset, not the promised status). Discarded chunks keep memory bounded. The
// cost of draining is that a hostile slow-drip client could hold the
// connection open indefinitely — so ONE overall deadline covers the whole
// body read INCLUDING the drain and destroys the socket when it expires (the
// 413, sent at overflow time, has long since flushed; a same-size honest
// client finishes orders of magnitude sooner). test/webutil.test.mjs pins
// both halves: the drain delivers the status, the deadline ends the drip.
// `limit` is REQUIRED (BODY_LIMITS above): a default is what silently froze
// the notebooks, so there is no default any more — a new route must state
// what its payload is worth, and a missing/invalid limit fails loudly here
// instead of quietly capping someone's handwriting at 64KB.
// A `content-encoding: gzip` body is INFLATED as it arrives and `limit` is applied to the
// INFLATED bytes, enforced during inflation (lib/gzipbody.mjs — read the header there before
// touching this). The wire cap below still applies too, so both sides of the decompressor are
// bounded: a body must be small enough to send AND small enough once expanded.
export const readBody = (req, limit, timeoutMs = BODY_READ_TIMEOUT_MS) => new Promise((resolve, reject) => {
  if (!Number.isInteger(limit) || limit <= 0) { reject(new Error('readBody: an explicit byte limit is required (lib/webutil.mjs BODY_LIMITS)')); return; }
  const chunks = []; let n = 0, ended = false;
  const deadline = setTimeout(() => { reject(new Error(BODY_READ_TIMEOUT)); req.destroy(); }, timeoutMs);
  const settle = (fn, v) => { clearTimeout(deadline); fn(v); };
  const tooLarge = () => { const e = new Error(BODY_TOO_LARGE); e.code = CODE_TOO_LARGE; e.limit = limit; return e; };
  const done = () => { try { settle(resolve, chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { settle(reject, new Error(BODY_BAD_JSON)); } };
  // Answer NOW, then drain what is still coming so the status can reach the client (the tradeoff
  // above). Once the body is fully received there is no drip left to bound, so the deadline goes.
  const refuse = (e) => { reject(e); if (ended) clearTimeout(deadline); else { req.removeAllListeners('data'); req.resume(); } };
  let gz = null;
  try { gz = bodyEncoding(req) ? createCappedGunzip(limit, (c) => chunks.push(c)) : null; }
  catch (e) { settle(reject, e); return; }
  if (gz) gz.on('error', (e) => refuse(e && e.code === GZIP_OVER_LIMIT_CODE ? tooLarge() : new Error(GZIP_BAD))).on('end', done);
  req.on('data', (d) => { n += d.length;
    if (n > limit) { refuse(tooLarge()); if (gz && !gz.destroyed) gz.destroy(); }
    else if (gz) { if (!gz.destroyed) gz.write(d); }
    else chunks.push(d); });
  req.on('end', () => { ended = true;
    if (!gz) return done();
    if (gz.destroyed) return clearTimeout(deadline);        // already answered; the drain is finished
    gz.end(); });                                           // inflation finishes asynchronously → done() on gz 'end'
  req.on('error', (e) => settle(reject, e));
  req.on('aborted', () => settle(reject, new Error('client aborted')));
});

// ── The ONE size-rejection code（唯一的超限错误码）─────────────────────────
// R3: every route's 413 carries this exact string, so a client can react
// GENERICALLY ("too large") instead of pattern-matching prose per route. It is
// also pinned against the copy inside web/chat-ui.inline.html by
// test/chat-oversize.test.mjs — an inline browser component cannot import, so
// a test is what keeps the two identical.
export const CODE_TOO_LARGE = 'too-large';

// Bytes → a short human size, for the ONE place a limit is put into a
// user-visible sentence (R3). Binary units, no decimals below 10MB.
export function humanBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  if (b >= 1024 * 1024) { const mb = b / (1024 * 1024); return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`; }
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

// The ONE request-failure → HTTP answer mapping (R3/R5). SCAR: an oversized
// /api/save-data answered `400 text/plain "error"`, so the app broker's
// `await r.json()` threw and the app could not tell "too large" from "the
// server crashed" — which is why the 64KB cliff stayed invisible so long.
// Every body failure now answers machine-readable JSON with a STABLE `code`
// and, for a size rejection, the limit — 413, never a bare 400/500.
//
// TWO PROPERTIES THE CHAT ROUTE FORCED (2026-09-02 round 2, defect V4):
//   1. NDJSON-READABLE. /api/chat streams application/x-ndjson and both chat
//      readers parse `while (buf.indexOf('\n') >= 0)`. The 413 had NO trailing
//      newline, so that loop parsed nothing, nothing threw, and the composer
//      sat on "…" forever with the typed message already cleared. Every body
//      error therefore ends with '\n' and carries `type:'error'` + `text` —
//      the terminal event both readers already handle. JSON.parse ignores the
//      newline, so `await r.json()` callers are unaffected.
//   2. HUMAN-READABLE ANYWAY: a client that renders only `error` still tells
//      the truth, because the sentence names the limit, bilingually.
export function bodyErrorResponse(e) {
  const msg = (e && e.message) || '';
  const j = (status, obj) => ({ status, body: JSON.stringify({ ok: false, type: 'error', ...obj }) + '\n' });
  if (msg === BODY_TOO_LARGE) {
    const limit = (e && e.limit) || null;
    const text = `Too large · 内容过大 — limit ${humanBytes(limit)}`;
    return j(413, { error: text, text, code: CODE_TOO_LARGE, limit });
  }
  if (msg === BODY_BAD_JSON) return j(400, { error: 'invalid JSON body', text: 'invalid JSON body · 无效的 JSON 请求体', code: 'bad_json' });
  // A compressed body we could not read: the payload never arrived intact, so this is a request
  // fault (400), not a server one — and it is deliberately NOT the size code, which a client
  // reacts to by splitting its payload rather than by fixing its headers.
  if (msg === GZIP_BAD || msg === GZIP_UNSUPPORTED) return j(400, { error: msg, text: `${msg} · 请求体编码无法解读`, code: 'bad_encoding' });
  if (msg === BODY_READ_TIMEOUT || msg === 'client aborted') return j(408, { error: msg, text: `${msg} · 请求体未收完`, code: 'body_incomplete' });
  // A handler refused to overwrite a document it could not read
  // (readJsonForUpdate). Mapped HERE so every read-before-write route answers
  // the same machine-readable 500 without repeating the mapping (R3/R5): the
  // user's stored data is intact, and the client is told exactly that.
  if (e && e.code === FILE_UNREADABLE_CODE) return j(500, { error: msg, text: msg, code: FILE_UNREADABLE_CODE });
  return j(500, { error: 'server error', text: 'server error · 服务器错误', code: 'server_error' });
}

// ── Strict base64 decode（严格 base64 解码）— ONE definition (R3) ────────────
// Node's decoder is LENIENT: it stops at an interior '=' and skips invalid
// characters, so a corrupted payload decodes to a short buffer and every
// caller happily stores the truncated result. PROVEN before this was
// single-sourced: a 48-byte file whose base64 carried one stray '=' was
// stored as 6 bytes, answered 200 {"ok":true} (the "QUJD=" scar, first fixed
// inside lib/meals.mjs and then NOT applied to /api/upload — the duplication
// R3 exists to prevent). Returns a Buffer, or null when the input is not
// exactly one well-formed base64 string.
// Linear-time strictness: a grouped {4}* quantifier stack-overflows on an 8MB
// string, so the charset check allows '=' only as 1-2 trailing pad chars and
// the length-multiple-of-4 test does the rest.
const B64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/;
export function decodeBase64Strict(data) {
  const raw = (typeof data === 'string')
    ? data.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/, '').replace(/\s+/g, '')
    : '';
  if (!raw || raw.length % 4 !== 0 || !B64_CHARS.test(raw)) return null;
  return Buffer.from(raw, 'base64');
}

// /api/data may serve agent-written files. Never let html/svg execute in our
// origin: force inert content types and nosniff.
export function dataContentType(ext) {
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg') return 'image/jpeg';
  return 'text/plain; charset=utf-8'; // html, svg, md, txt, everything else
}
