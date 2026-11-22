// Minimal hand-rolled ICS (RFC 5545) parser（日历）— zero dependencies by design
// (the repo ships none). It was written for the daily brief's calendar section;
// the brief was removed 2026-10-11 (docs/adr/0004). The parser and fetchIcs have
// no production caller now — they are kept for a future calendar tool (the
// `calendar` manifest in lib/jobs/tools.mjs). isPrivateAddress below IS live:
// lib/tools/pollen.mjs uses it as the repo's one SSRF guard.
//
// SUPPORTED (deliberately small):
//   - VEVENT blocks: DTSTART, DTEND (same forms), SUMMARY. DTEND is optional — without it
//     an event has a start and no known length.
//   - RRULE FREQ=DAILY and FREQ=WEEKLY (optional BYDAY, optional UNTIL),
//     INTERVAL=1 only.
//   - Line unfolding (CRLF + space/tab), text unescaping (\n \, \; \\).
//   - Malformed lines are SKIPPED, never a crash; a VEVENT without a parsable
//     DTSTART is dropped.
// NOT SUPPORTED (honest scope — such events appear only on their literal
// start date, or not at all where noted):
//   - TZID conversion: a TZID time is treated as LOCAL WALL TIME. Correct when
//     the feed's timezone equals this node's (the family's own calendar); a
//     foreign-timezone feed will show shifted times.
//   - RRULE INTERVAL>1, COUNT, MONTHLY/YEARLY, BYMONTHDAY etc. → the rule is
//     ignored (event shows on its DTSTART date only).
//   - EXDATE / cancelled instances → a cancelled occurrence still shows.
//   - VTIMEZONE, VTODO, multi-day spans (only the start day is shown).
import dns from 'node:dns/promises';
import net from 'node:net';
import { localDateStr } from './schedule.mjs';

// BYDAY two-letter codes → JS getDay() numbers.
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Hostile-feed hard caps: a calendar feed is remote text we do not control.
// ~2MB of ICS is far beyond any real family calendar; 500 events likewise
// (todaysEvents filters to one day anyway). Content-Type is deliberately NOT
// enforced — real-world feeds serve text/plain, application/octet-stream, etc.
export const ICS_MAX_BYTES = 20 * 1024 * 1024;   // real Google feeds export FULL history (5-15MB is normal); still bounded vs OOM
export const ICS_MAX_EVENTS = 100000;   // pathological-repetition guard only - must exceed any real feed, else parse truncation drops TODAY's events (they sort oldest-first)

const unescapeText = (s) => String(s)
  .replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

// "DTSTART;TZID=X;VALUE=DATE:20260901" → { name, params:{TZID,VALUE}, value }.
// A line without ":" (or without a name) is malformed → null (caller skips it).
function parseLine(line) {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  const [name, ...paramParts] = line.slice(0, i).split(';');
  const params = {};
  for (const p of paramParts) { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

// ICS date/date-time → { start: Date, allDay } or null when unparsable.
// "...Z" = UTC (converted); floating/TZID = local wall time (documented above).
function parseDtstart(prop) {
  const v = prop.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || (prop.params.VALUE === 'DATE')) {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { start: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const parts = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)];
  return { start: m[7] ? new Date(Date.UTC(...parts)) : new Date(...parts), allDay: false };
}

// RRULE value → { freq, byday:[Number]|null, until:Date|null } for supported
// rules, or null = unsupported (event then shows on its start date only).
function parseRrule(value) {
  const kv = {};
  for (const part of String(value).split(';')) { const eq = part.indexOf('='); if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase(); }
  if (kv.FREQ !== 'DAILY' && kv.FREQ !== 'WEEKLY') return null;
  if (kv.INTERVAL && kv.INTERVAL !== '1') return null;
  if (kv.COUNT) return null;
  let byday = null;
  if (kv.BYDAY) {
    byday = kv.BYDAY.split(',').map((d) => BYDAY[d.trim()]).filter((n) => n !== undefined);
    if (!byday.length) return null; // e.g. "2MO" ordinals — unsupported
  }
  let until = null;
  if (kv.UNTIL) { const p = parseDtstart({ value: kv.UNTIL, params: {} }); if (!p) return null; until = p.start; }
  return { freq: kv.FREQ, byday, until };
}

// Full ICS text → events [{ summary, start: Date, allDay, rrule }]. Never
// throws on bad input: malformed lines/blocks are skipped (the feed is remote
// text we do not control), a totally alien text simply yields [].
export function parseIcs(text, { maxEvents = ICS_MAX_EVENTS } = {}) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const events = [];
  let cur = null;
  for (const raw of unfolded.split(/\r?\n/)) {
    const prop = parseLine(raw.trim());
    if (!prop) continue; // malformed line — skipped by design
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') { cur = {}; continue; }
    if (prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      if (cur && cur.startInfo) events.push({ summary: cur.summary || '(no title · 无标题)', start: cur.startInfo.start, allDay: cur.startInfo.allDay,
        end: (cur.endInfo && !cur.endInfo.allDay) ? cur.endInfo.start : null, rrule: cur.rrule || null });
      cur = null;
      if (events.length >= maxEvents) break; // pathological repetition — hard cap, rest ignored
      continue;
    }
    if (!cur) continue;
    if (prop.name === 'SUMMARY') cur.summary = unescapeText(prop.value).trim();
    else if (prop.name === 'DTSTART') cur.startInfo = parseDtstart(prop);
    // DTEND parses with the same rules as DTSTART; absent or unparsable simply means
    // "length unknown", never a dropped event (the brief then assumes a short block).
    else if (prop.name === 'DTEND') cur.endInfo = parseDtstart(prop);
    else if (prop.name === 'RRULE') cur.rrule = parseRrule(prop.value);
  }
  return events;
}

// Does this event occur on the local calendar day of `day`?
export function occursOn(ev, day) {
  const target = localDateStr(day);
  const startDay = localDateStr(ev.start);
  if (startDay === target) return true;
  if (!ev.rrule || startDay > target) return false;
  if (ev.rrule.until) {
    // Compare INSTANTS: the occurrence at the event's wall-clock time on `day`
    // vs the UNTIL instant (RFC 5545: UNTIL is inclusive). Comparing local day
    // STRINGS shifted the series end by up to a day off UTC (the Asia/Shanghai
    // regression in test/ics.test.mjs: an ended series showed one extra morning).
    const occ = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
      ev.start.getHours(), ev.start.getMinutes(), ev.start.getSeconds());
    if (occ.getTime() > ev.rrule.until.getTime()) return false;
  }
  if (ev.rrule.freq === 'DAILY') return true;
  const wanted = ev.rrule.byday || [ev.start.getDay()];
  return wanted.includes(day.getDay());
}

// Today's occurrences, shaped for the brief: [{ summary, allDay, time }],
// all-day first, then by clock time.
export function todaysEvents(events, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (events || []).filter((ev) => occursOn(ev, now))
    // endTime is kept as well as time: two events that COLLIDE are the single most useful
    // thing a brief can notice, and that cannot be computed from start times alone.
    .map((ev) => ({ summary: ev.summary, allDay: ev.allDay,
      time: ev.allDay ? null : `${pad(ev.start.getHours())}:${pad(ev.start.getMinutes())}`,
      endTime: (ev.allDay || !ev.end) ? null : `${pad(ev.end.getHours())}:${pad(ev.end.getMinutes())}` }))
    .sort((a, b) => ((a.time || '') > (b.time || '')) - ((a.time || '') < (b.time || '')));
}

// ── Fetch policy（抓取安全策略）— SSRF gate ──────────────────────────────────
// The feed URL is member-supplied and the fetch runs from the always-on family
// node, so it is a server-side request primitive unless gated:
//   - https only (webcal:// is Apple's alias for the same HTTPS resource and
//     is rewritten; plain http is refused here);
//   - the host must not resolve to loopback / RFC1918 / link-local(metadata) /
//     ULA ranges — resolved PER FETCH because DNS answers can change;
//   - redirects are refused (redirect:'manual') with an honest bilingual line
//     instead of silently following a hop that was never validated;
//   - the body is streamed under ICS_MAX_BYTES — time-limited is not enough,
//     a fast hostile feed can push GBs inside the timeout window.
// All failures THROW with context — the caller renders the honest
// "unreachable" line, never a silent empty (R14).
const PRIVATE_HOST_MSG = 'ics feed host is a private address · 日历源解析到内网地址，已拒绝';

// Loopback / RFC1918 / link-local (incl. cloud metadata 169.254.169.254) /
// "this network", plus the IPv6 equivalents (::1, fc00::/7, fe80::/10,
// ::ffff: IPv4-mapped forms re-checked as IPv4).
export function isPrivateAddress(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(s)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return false;
}

// Every resolved address must be public — one private A/AAAA record poisons
// the host. lookupImpl is the test seam (protocol-faithful: {address} entries).
async function assertPublicHost(hostname, lookupImpl) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new Error(PRIVATE_HOST_MSG);
    return;
  }
  if (bare === 'localhost' || bare.endsWith('.localhost')) throw new Error(PRIVATE_HOST_MSG);
  let addrs;
  try { addrs = await lookupImpl(bare, { all: true, verbatim: true }); }
  catch { throw new Error('ics feed DNS lookup failed · 日历源域名解析失败'); }
  if (!Array.isArray(addrs) || !addrs.length) throw new Error('ics feed DNS lookup failed · 日历源域名解析失败');
  for (const a of addrs) if (isPrivateAddress(a && a.address)) throw new Error(PRIVATE_HOST_MSG);
}

// Read the body with a hard byte ceiling: stream when the response exposes a
// web stream, else fall back to text() with a post-hoc size check (test stubs).
async function readBodyCapped(res, maxBytes) {
  const tooBig = () => new Error(`ics feed too large (over ${Math.round(maxBytes / 1024 / 1024)}MB) · 日历源超过大小上限，已中止`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const chunks = []; let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A real Google feed is the FULL calendar history (measured: 10.7 MB / 21,638 events, 14.5 s on
// a good connection). The old 15 s budget lost that race about half the time and the brief then
// said "Calendar unreachable" on a calendar that was fine. 60 s costs nothing in a background job.
export const ICS_TIMEOUT_MS = 60000;
// One successful fetch is reused for ICS_CACHE_MS so a re-run (or a second user) is instant and a
// transient failure can fall back to it. In memory only: a restart simply refetches.
export const ICS_CACHE_MS = 6 * 60 * 60 * 1000;
const icsCache = new Map();                       // url → { at, text }
export const cachedIcs = (url, now = Date.now()) => {
  const hit = icsCache.get(url);
  return hit && (now - hit.at) < ICS_CACHE_MS ? hit.text : null;
};
export async function fetchIcs(url, { fetchImpl = fetch, lookupImpl, timeoutMs = ICS_TIMEOUT_MS, maxBytes = ICS_MAX_BYTES, now = Date.now(), useCache = false } = {}) {
  if (useCache) { const hit = cachedIcs(url, now); if (hit) return hit; }
  const u = new URL(String(url).replace(/^webcal:\/\//i, 'https://'));
  if (u.protocol !== 'https:') throw new Error('ics feed must be https · 日历源必须使用 https 地址');
  await assertPublicHost(u.hostname, lookupImpl || ((host, opts) => dns.lookup(host, opts)));
  const res = await fetchImpl(u.href, { headers: { 'user-agent': 'superelf-ics' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300 && res.status < 400) throw new Error('ics feed redirected — use the final URL · 日历源发生跳转，请使用最终地址');
  if (!res.ok) throw new Error(`ics fetch HTTP ${res.status}`);
  const text = await readBodyCapped(res, maxBytes);
  if (useCache) icsCache.set(url, { at: now, text });   // one good fetch serves re-runs for ICS_CACHE_MS
  return text;
}
