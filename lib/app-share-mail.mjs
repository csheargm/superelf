// 分享邮件 · The share email and its prefill token (docs/adr/0047-app-share-link.md; routes:
// lib/app-share-routes.mjs).
//
// - The email is minimal: no sender name, no "someone shared". An optional note the sender typed
//   sits above the link. Plain text + a simple HTML part, no emojis.
// - The link carries ?k=<token>: the recipient's address SEALED (AES-256-GCM, key derived from the
//   share channel secret both nodes hold), so the URL holds no readable personal data. The link page
//   only PREFILLS the sign-in email from it; the token never signs anyone in (a forwarded email must
//   not grant access).
// - sendOnce: one idempotency key = one email, so a retry or a second tap can never send twice.
import crypto from 'node:crypto';

export const PREFILL_PARAM = 'k';
export const PREFILL_TTL_MS = 30 * 24 * 3600 * 1000;   // a share email's link prefills for 30 days
export const PREFILL_STASH = 'pa_share_email';        // sessionStorage key: the link page → the shell's sign-in box
export const NOTE_MAX = 300;
export const SEND_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const SEND_KEY_TTL_MS = 10 * 60 * 1000;
const PREFILL_INFO = 'superelf share prefill v1';
const IV_LEN = 12, TAG_LEN = 16;
const keyOf = (secret) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(PREFILL_INFO), 32));

// → an opaque base64url token for `email`, or '' with no secret.
export function sealPrefill(secret, email, now = Date.now()) {
  if (!secret || typeof email !== 'string' || !email) return '';
  const iv = crypto.randomBytes(IV_LEN), c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ e: email, x: now + PREFILL_TTL_MS }), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
// → the address, or '' when the token is missing, forged, damaged or expired.
export function openPrefill(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 600 || !/^[A-Za-z0-9_-]+$/.test(token)) return '';
  const raw = Buffer.from(token, 'base64url');
  if (raw.length <= IV_LEN + TAG_LEN) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, IV_LEN));
    d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
    const v = JSON.parse(Buffer.concat([d.update(raw.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8'));
    return v && typeof v.e === 'string' && typeof v.x === 'number' && v.x > now ? v.e : '';
  } catch { return ''; /* forged or damaged: no prefill, the visitor types their email (the page still works) */ }
}

const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const SHARE_EMAIL = Object.freeze({
  subject: (name) => `「${name}」应用链接 · Your link to the ${name} app`,
  lead: '点开即可使用 · Tap to open:',
  text: (url, note) => `${note ? `${note}\n\n` : ''}${SHARE_EMAIL.lead}\n${url}\n`,
  html: (url, note) => `<div style="font:16px/1.5 -apple-system,system-ui,sans-serif">${note ? `<p style="white-space:pre-wrap">${escHtml(note)}</p>` : ''}`
    + `<p>${escHtml(SHARE_EMAIL.lead)}<br><a href="${escHtml(url)}">${escHtml(url)}</a></p></div>`,
});
// A sender's note: plain text, trimmed, at most NOTE_MAX code points.
export const cleanNote = (v) => (typeof v === 'string' ? [...v.replace(/\r\n?/g, '\n').trim()].slice(0, NOTE_MAX).join('') : '');

// One email per key: a repeat with the same key (a retry, a second tap) gets the first send's
// result — or waits on it while it is still in flight. A failed send frees the key (a real retry).
export function makeSendOnce(now = () => Date.now()) {
  const seen = new Map();   // key → { at, p, done }
  return function sendOnce(key, send) {
    const t = now();
    for (const [k, v] of seen) if (v.done && t - v.at > SEND_KEY_TTL_MS) seen.delete(k);   // an in-flight send is never forgotten
    const had = seen.get(key);
    if (had) return had.p.then((r) => ({ ...r, again: true }));
    const p = Promise.resolve().then(send);
    const rec = { at: t, p, done: false };
    seen.set(key, rec);
    p.then(() => { rec.done = true; rec.at = now(); }, () => { if (seen.get(key) === rec) seen.delete(key); });
    return p;
  };
}
