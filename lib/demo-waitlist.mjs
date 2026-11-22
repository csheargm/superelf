// The demo's waiting list · 演示等候名单: visitors who want their own private superelf leave an
// email (and an optional name / note). Demo nodes only — the route sits on the demo allow-list
// (lib/demo.mjs) and is answered only by lib/demo-routes.mjs, so a private node has no such route.
// Stored as JSONL at <root>/WAITLIST_FILE: beside demo-users.json, outside every visitor workspace,
// so no visitor's app or data route can read it. No email is sent. The reply never says whether an
// address was already listed and never carries other entries. Privacy and deletion: docs/demo-node.md.
import fs from 'node:fs';
import path from 'node:path';
import { hashIp, demoLimit } from './demo-quota.mjs';

export const WAITLIST_PATH = '/api/waitlist';
export const WAITLIST_FILE = 'waitlist.jsonl';
export const WAITLIST_BODY_LIMIT = 4 * 1024;
export const WAITLIST_MAX = Object.freeze({ email: 254, name: 80, note: 500 });
export const WAITLIST_MESSAGES = Object.freeze({
  bad_email: 'Please enter a valid email address · 请输入有效的邮箱地址',
  rate: 'Too many sign-ups from your network today — please try tomorrow · 您所在网络今日登记过多，请明天再试',
  full: 'The waiting list is full right now — please try later · 等候名单已满，请稍后再试',
});
// One @, no spaces or angle brackets, a dot in the domain: a plain shape check, not deliverability.
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
// Control characters (newlines included) are dropped, so one entry is always one JSONL line.
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// → { ok: true, entry } or { ok: false, code }. Pure: no disk, no counters.
export function validateEntry(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const raw = typeof b.email === 'string' ? b.email.trim() : '';
  if (raw.length > WAITLIST_MAX.email || !EMAIL_RE.test(raw)) return { ok: false, code: 'bad_email' };
  return { ok: true, entry: { email: raw.toLowerCase(), name: clean(b.name, WAITLIST_MAX.name), note: clean(b.note, WAITLIST_MAX.note) } };
}

// The listed emails. A line that does not parse is skipped, not fatal: the file is append-only and
// hand-edited by the owner (deletion), and a bad line must not lock every visitor out.
function listedEmails(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return new Set(); throw e; }
  const out = new Set();
  for (const line of text.split('\n')) {
    try { const v = JSON.parse(line); if (v && typeof v.email === 'string') out.add(v.email); }
    catch { /* an empty or hand-damaged line: skipped (see above) */ }
  }
  return out;
}

// → { status, body }. Synchronous from the read to the append, so two requests can never both
// pass the dedupe or the total cap.
export function addToWaitlist({ cfg, root, store, ip, body, now = Date.now() }) {
  const v = validateEntry(body);
  if (!v.ok) return { status: 400, body: { ok: false, code: 'waitlist_bad_email', error: WAITLIST_MESSAGES.bad_email } };
  const file = path.join(root, WAITLIST_FILE);
  const listed = listedEmails(file);
  // Both caps come BEFORE the dedupe, so a listed and an unlisted address always get the same
  // answer (no lookup oracle); a repeat costs the network one sign-up, like a new one.
  if (listed.size >= demoLimit(cfg, 'waitlist_max_entries')) return { status: 507, body: { ok: false, code: 'waitlist_full', error: WAITLIST_MESSAGES.full } };
  const q = store.consume([[`waitlist:${hashIp(store.salt(now), ip)}`, demoLimit(cfg, 'waitlist_per_ip_per_day')]], now);
  if (!q.ok) return { status: 429, body: { ok: false, code: 'waitlist_rate', error: WAITLIST_MESSAGES.rate } };
  if (listed.has(v.entry.email)) return { status: 200, body: { ok: true } };
  fs.appendFileSync(file, JSON.stringify({ t: new Date(now).toISOString(), ...v.entry }) + '\n', { mode: 0o600 });
  return { status: 200, body: { ok: true } };
}
